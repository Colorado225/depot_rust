//! LOT 10 — Générateur PDF 1.4 autonome, port fidèle de
//! `server/domain/pdfExport.ts` (encodage WinAnsi/Latin-1, aucune dépendance
//! externe, aucun appel réseau). Utilisé par les exports de rapports Tauri
//! après le retrait du sidecar Node.

#[derive(Debug, Clone)]
pub struct PdfColumn {
    pub header: String,
    pub width_chars: usize,
    pub align_right: bool,
}

impl PdfColumn {
    pub fn left(header: &str, width_chars: usize) -> Self {
        Self { header: header.to_string(), width_chars, align_right: false }
    }

    pub fn right(header: &str, width_chars: usize) -> Self {
        Self { header: header.to_string(), width_chars, align_right: true }
    }
}

#[derive(Debug, Clone)]
pub struct PdfTableDocument {
    pub title: String,
    pub subtitle: String,
    pub generated_at: String,
    pub columns: Vec<PdfColumn>,
    pub rows: Vec<Vec<String>>,
    pub footer_lines: Vec<String>,
}

/// Normalise les caractères non WinAnsi courants et échappe `(`, `)`, `\`.
fn escape_pdf_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for ch in input.chars() {
        let normalized = match ch {
            '\u{202f}' | '\u{00a0}' => ' ',
            '\u{2014}' | '\u{2013}' => '-',
            '\u{00ab}' | '\u{00bb}' => '"',
            '\u{2019}' => '\'',
            other => other,
        };
        let code = normalized as u32;
        if normalized == '(' || normalized == ')' || normalized == '\\' {
            out.push('\\');
            out.push(normalized);
        } else if (32..=255).contains(&code) {
            out.push(normalized);
        } else {
            out.push('?');
        }
    }
    out
}

fn char_len(value: &str) -> usize {
    value.chars().count()
}

fn pad_cell(value: &str, width: usize, align_right: bool) -> String {
    let clean = value.trim();
    let mut truncated: String = if char_len(clean) > width {
        let keep = width.max(1) - 1;
        clean.chars().take(keep).collect::<String>() + "."
    } else {
        clean.to_string()
    };
    let missing = width.saturating_sub(char_len(&truncated));
    if align_right {
        let padding = " ".repeat(missing);
        truncated = format!("{padding}{truncated}");
    } else {
        truncated.push_str(&" ".repeat(missing));
    }
    truncated
}

fn latin1(text: &str) -> Vec<u8> {
    text.chars()
        .map(|ch| {
            let code = ch as u32;
            if code <= 255 { code as u8 } else { b'?' }
        })
        .collect()
}

fn push_object(objects: &mut Vec<String>, body: String) -> usize {
    objects.push(body);
    objects.len()
}

/// Construit un PDF tabulaire A4 paysage, avec table des objets et xref.
pub fn build_tabular_pdf(doc: &PdfTableDocument) -> Vec<u8> {
    const PAGE_WIDTH: i64 = 842;
    const PAGE_HEIGHT: i64 = 595;
    const MARGIN_X: i64 = 36;
    const MAX_LINES_PER_PAGE: usize = 34;

    let header_line = doc
        .columns
        .iter()
        .map(|col| pad_cell(&col.header, col.width_chars, col.align_right))
        .collect::<Vec<_>>()
        .join(" | ");
    let separator = "-".repeat(130.min(char_len(&header_line)));

    let mut all_body_lines = vec![header_line.clone(), separator.clone()];
    for row in &doc.rows {
        all_body_lines.push(
            doc.columns
                .iter()
                .enumerate()
                .map(|(idx, col)| {
                    pad_cell(
                        row.get(idx).map(String::as_str).unwrap_or(""),
                        col.width_chars,
                        col.align_right,
                    )
                })
                .collect::<Vec<_>>()
                .join(" | "),
        );
    }
    if !doc.footer_lines.is_empty() {
        all_body_lines.push(separator.clone());
        all_body_lines.extend(doc.footer_lines.iter().cloned());
    }

    let mut chunks: Vec<Vec<String>> = Vec::new();
    for group in all_body_lines.chunks(MAX_LINES_PER_PAGE) {
        chunks.push(group.to_vec());
    }
    if chunks.is_empty() {
        chunks.push(vec![header_line, separator, "Aucune donnée sur la période.".to_string()]);
    }

    let mut objects: Vec<String> = Vec::new();
    let catalog_id = push_object(&mut objects, String::new());
    let pages_id = push_object(&mut objects, String::new());
    let font_regular_id = push_object(
        &mut objects,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
    );
    let font_bold_id = push_object(
        &mut objects,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".into(),
    );
    let font_mono_id = push_object(
        &mut objects,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>".into(),
    );

    let mut page_ids: Vec<usize> = Vec::new();
    for (page_index, lines) in chunks.iter().enumerate() {
        let mut ops: Vec<String> = Vec::new();
        ops.push("BT".to_string());
        ops.push(format!(
            "/F2 14 Tf {MARGIN_X} {} Td ({}) Tj",
            PAGE_HEIGHT - 40,
            escape_pdf_text(&doc.title)
        ));
        ops.push(format!("/F1 9 Tf 0 -16 Td ({}) Tj", escape_pdf_text(&doc.subtitle)));
        ops.push(format!(
            "/F1 8 Tf 0 -13 Td ({}) Tj",
            escape_pdf_text(&format!(
                "Généré le {} — Page {}/{}",
                doc.generated_at,
                page_index + 1,
                chunks.len()
            ))
        ));

        let mut y = PAGE_HEIGHT - 92;
        for line in lines {
            ops.push(format!("ET BT /F3 8.5 Tf {MARGIN_X} {y} Td ({}) Tj", escape_pdf_text(line)));
            y -= 13;
        }
        ops.push("ET".to_string());

        let stream = ops.join("\n");
        let stream_len = latin1(&stream).len();
        let content_id = push_object(
            &mut objects,
            format!("<< /Length {stream_len} >>\nstream\n{stream}\nendstream"),
        );
        let page_id = push_object(&mut objects, format!(
            "<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] \
             /Resources << /Font << /F1 {font_regular_id} 0 R /F2 {font_bold_id} 0 R \
             /F3 {font_mono_id} 0 R >> >> /Contents {content_id} 0 R >>"
        ));
        page_ids.push(page_id);
    }

    objects[catalog_id - 1] = format!("<< /Type /Catalog /Pages {pages_id} 0 R >>");
    let kids = page_ids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    objects[pages_id - 1] = format!(
        "<< /Type /Pages /Kids [{kids}] /Count {} >>",
        page_ids.len()
    );

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    let mut offsets: Vec<usize> = vec![0];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(&latin1(object));
        out.extend_from_slice(b"\nendobj\n");
    }

    let xref_offset = out.len();
    let mut xref = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
    for index in 1..=objects.len() {
        xref.push_str(&format!("{:010} 00000 n \n", offsets[index]));
    }
    xref.push_str(&format!(
        "trailer\n<< /Size {} /Root {catalog_id} 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
        objects.len() + 1
    ));
    out.extend_from_slice(xref.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echappement_et_latin1() {
        assert_eq!(escape_pdf_text("(A) \\ —"), "\\(A\\) \\\\ -");
        assert_eq!(latin1("É"), vec![0xC9]);
        assert_eq!(pad_cell("12", 5, true), "   12");
        assert_eq!(pad_cell("abcdef", 3, false), "ab.");
    }

    #[test]
    fn pdf_autonome_avec_xref() {
        let doc = PdfTableDocument {
            title: "DepotPro CI — Test".into(),
            subtitle: "Période : Toutes les écritures".into(),
            generated_at: "2026-11-15 10:00:00".into(),
            columns: vec![PdfColumn::left("SKU", 12), PdfColumn::right("Montant", 10)],
            rows: vec![vec!["BOCK-33".into(), "1 000 FCFA".into()]],
            footer_lines: vec!["TOTAL: 1 000 FCFA".into()],
        };
        let bytes = build_tabular_pdf(&doc);
        let text = String::from_utf8_lossy(&bytes);
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(text.contains("xref"));
        assert!(text.contains("startxref"));
        assert!(text.ends_with("%%EOF\n"));
        assert!(text.contains("/Type /Catalog"));
    }
}
