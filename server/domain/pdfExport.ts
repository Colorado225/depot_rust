/**
 * Générateur PDF 1.4 autonome (sans dépendance externe ni window.open)
 * compatible hors-ligne pour les rapports tabulaires DepotPro CI (encodage WinAnsi/Latin-1).
 */

export interface PdfColumn {
  header: string;
  widthChars: number;
  align?: 'left' | 'right';
}

export interface PdfTableDocument {
  title: string;
  subtitle: string;
  generatedAt: string;
  columns: PdfColumn[];
  rows: string[][];
  footerLines?: string[];
}

function escapePdfText(input: string): string {
  // Normaliser certains caractères Unicode non WinAnsi courants (espaces insécables, tirets)
  const normalized = input
    .replace(/\u202f|\u00a0/g, ' ')
    .replace(/—|–/g, '-')
    .replace(/[«»]/g, '"')
    .replace(/’/g, "'");

  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (code === 0x28 || code === 0x29 || code === 0x5c) {
      out += '\\' + normalized[i];
    } else if (code >= 32 && code <= 255) {
      out += normalized[i];
    } else {
      out += '?';
    }
  }
  return out;
}

function padCell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const clean = value.trim();
  const truncated = clean.length > width ? `${clean.slice(0, Math.max(1, width - 1))}.` : clean;
  if (align === 'right') {
    return truncated.padStart(width, ' ');
  }
  return truncated.padEnd(width, ' ');
}

export function buildTabularPdfBuffer(doc: PdfTableDocument): Buffer {
  const pageWidth = 842; // A4 Paysage (points)
  const pageHeight = 595;
  const marginX = 36;
  const maxLinesPerPage = 34;

  const headerLine = doc.columns
    .map((col) => padCell(col.header, col.widthChars, col.align ?? 'left'))
    .join(' | ');
  const separatorLine = '-'.repeat(Math.min(130, headerLine.length));

  const tableLines = doc.rows.map((row) =>
    doc.columns
      .map((col, idx) => padCell(row[idx] ?? '', col.widthChars, col.align ?? 'left'))
      .join(' | ')
  );

  const allBodyLines: string[] = [headerLine, separatorLine, ...tableLines];
  if (doc.footerLines && doc.footerLines.length > 0) {
    allBodyLines.push(separatorLine, ...doc.footerLines);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < allBodyLines.length; i += maxLinesPerPage) {
    chunks.push(allBodyLines.slice(i, i + maxLinesPerPage));
  }
  if (chunks.length === 0) {
    chunks.push([headerLine, separatorLine, 'Aucune donnée sur la période.']);
  }

  const objects: string[] = [];
  const addObject = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalogObjId = addObject(''); // 1
  const pagesObjId = addObject(''); // 2
  const fontRegularId = addObject(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  );
  const fontBoldId = addObject(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  );
  const fontMonoId = addObject(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'
  );

  const pageIds: number[] = [];

  chunks.forEach((lines, pageIndex) => {
    const ops: string[] = [];
    ops.push('BT');
    ops.push(`/F2 14 Tf ${marginX} ${pageHeight - 40} Td (${escapePdfText(doc.title)}) Tj`);
    ops.push(`/F1 9 Tf 0 -16 Td (${escapePdfText(doc.subtitle)}) Tj`);
    ops.push(
      `/F1 8 Tf 0 -13 Td (${escapePdfText(
        `Généré le ${doc.generatedAt} — Page ${pageIndex + 1}/${chunks.length}`
      )}) Tj`
    );

    let y = pageHeight - 92;
    for (let i = 0; i < lines.length; i++) {
      const font = pageIndex === 0 && i === 0 ? '/F3' : '/F3';
      ops.push(`ET BT ${font} 8.5 Tf ${marginX} ${y} Td (${escapePdfText(lines[i])}) Tj`);
      y -= 13;
    }
    ops.push('ET');

    const streamStr = ops.join('\n');
    const streamLen = Buffer.byteLength(streamStr, 'latin1');
    const contentId = addObject(
      `<< /Length ${streamLen} >>\nstream\n${streamStr}\nendstream`
    );

    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontMonoId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  });

  objects[catalogObjId - 1] = `<< /Type /Catalog /Pages ${pagesObjId} 0 R >>`;
  objects[pagesObjId - 1] = `<< /Type /Pages /Kids [${pageIds
    .map((id) => `${id} 0 R`)
    .join(' ')}] /Count ${pageIds.length} >>`;

  const chunksOut: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [0];
  let currentOffset = chunksOut[0].length;

  for (let i = 0; i < objects.length; i++) {
    offsets.push(currentOffset);
    const objBuf = Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`, 'latin1');
    chunksOut.push(objBuf);
    currentOffset += objBuf.length;
  }

  const xrefOffset = currentOffset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunksOut.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(chunksOut);
}
