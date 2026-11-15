import { useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/src/components/ui/dialog';
import { formatDateTimeFr, formatFCFA } from '@/src/lib/money';
import { PAYMENT_METHOD_LABELS } from '@/src/modules/customers/services/customerService';
import { useBusinessSettings } from '@/src/modules/settings/services/settingsService';
import type { Sale } from '@/src/types/pos';

interface SaleTicketDialogProps {
  sale: Sale | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SaleTicketDialog({ sale, open, onOpenChange }: SaleTicketDialogProps) {
  const { data: settings } = useBusinessSettings(open);
  const [format, setFormat] = useState<'80mm' | '58mm' | 'A4'>(
    settings?.receiptPrintWidth ?? '80mm'
  );

  if (!sale) return null;

  const activeFormat = format;
  const depotName = settings?.depotName ?? 'DepotPro CI';

  const handlePrint = () => {
    try {
      window.print();
    } catch {
      toast.error(
        'Impression indisponible sur ce poste ; la vente reste validée et enregistrée en base.'
      );
    }
  };

  const handleDownloadHtmlReceipt = () => {
    try {
      const linesHtml = sale.items
        .map(
          (i) =>
            `<tr><td>${i.productName} (${i.quantity} ${i.unitName})</td><td style="text-align:right;font-family:monospace">${formatFCFA(i.lineTotalXof)}</td></tr>`
        )
        .join('');
      const payHtml =
        sale.payments.length > 0
          ? sale.payments
              .map(
                (p) =>
                  `<tr><td>${PAYMENT_METHOD_LABELS[p.paymentMethod]}${p.externalReference ? ` (${p.externalReference})` : ''}</td><td style="text-align:right;font-family:monospace">${formatFCFA(p.amountXof)}</td></tr>`
              )
              .join('')
          : '<tr><td colspan="2">Vente à crédit intégral</td></tr>';

      const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Ticket ${sale.saleNumber}</title></head><body style="font-family:sans-serif;max-width:${activeFormat === '58mm' ? '260px' : activeFormat === '80mm' ? '340px' : '720px'};margin:24px auto;padding:16px;border:1px solid #ddd">
<h2 style="margin:0 0 4px">${depotName}</h2>
<p style="margin:0 0 12px;font-size:12px;color:#555">${settings?.phone ?? ''} ${settings?.address ? '· ' + settings.address : ''}</p>
<p style="margin:0 0 8px;font-size:12px">Ticket : <strong>${sale.saleNumber}</strong><br>Date : ${formatDateTimeFr(sale.createdAt)}<br>Client : ${sale.customerName}<br>Tarif : ${sale.priceTier === 'WHOLESALE' ? 'GROS' : 'DÉTAIL'}</p>
<hr><table style="width:100%;font-size:12px;border-collapse:collapse">${linesHtml}</table><hr>
<table style="width:100%;font-size:12px">
<tr><td>Sous-total</td><td style="text-align:right;font-family:monospace">${formatFCFA(sale.subtotalXof)}</td></tr>
<tr><td>Remise</td><td style="text-align:right;font-family:monospace">-${formatFCFA(sale.discountXof)}</td></tr>
<tr><td>Consignes emballages</td><td style="text-align:right;font-family:monospace">${formatFCFA(sale.consignmentTotalXof)}</td></tr>
<tr><td><strong>NET À PAYER</strong></td><td style="text-align:right;font-family:monospace"><strong>${formatFCFA(sale.totalPayableXof)}</strong></td></tr>
<tr><td>Encaissé</td><td style="text-align:right;font-family:monospace">${formatFCFA(sale.paidAmountXof)}</td></tr>
<tr><td>Reste à crédit</td><td style="text-align:right;font-family:monospace">${formatFCFA(sale.creditAmountXof)}</td></tr>
</table><hr>
<table style="width:100%;font-size:11px">${payHtml}</table>
<p style="margin-top:16px;font-size:11px;text-align:center;color:#555">${settings?.receiptFooter ?? 'Merci de votre confiance.'}</p>
</body></html>`;

      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ticket-${sale.saleNumber}.html`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Ticket ${sale.saleNumber} téléchargé.`);
    } catch {
      toast.error('Export local du ticket impossible ; la vente reste enregistrée.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Ticket de caisse — {sale.saleNumber}</DialogTitle>
          <DialogDescription>
            Vente persistée dans SQLite. L’impression reste indépendante de la validation commerciale.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
            {(['58mm', '80mm', 'A4'] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setFormat(w)}
                className={`rounded-md px-3 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                  activeFormat === w
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Format {w}
              </button>
            ))}
          </div>
          {sale.status === 'CANCELLED' && (
            <span className="text-xs font-semibold text-destructive">TICKET ANNULÉ</span>
          )}
        </div>

        {/* Aperçu Ticket */}
        <div className="flex justify-center rounded-md border border-border bg-secondary/40 p-4">
          <div
            className={`w-full rounded border border-border bg-white p-5 text-slate-900 shadow-xs ${
              activeFormat === '58mm'
                ? 'max-w-[260px]'
                : activeFormat === '80mm'
                  ? 'max-w-[340px]'
                  : 'max-w-full'
            }`}
          >
            <div className="border-b border-dashed border-slate-300 pb-3 text-center">
              <p className="font-display text-base font-bold text-slate-900">{depotName}</p>
              {settings?.phone && <p className="text-xs text-slate-600">{settings.phone}</p>}
              {settings?.address && <p className="text-xs text-slate-600">{settings.address}</p>}
              {settings?.receiptHeader && (
                <p className="mt-1 text-xs text-slate-700">{settings.receiptHeader}</p>
              )}
            </div>

            <div className="space-y-0.5 border-b border-dashed border-slate-300 py-2.5 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-600">Ticket</span>
                <span className="font-mono font-semibold">{sale.saleNumber}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Date</span>
                <span className="font-mono tabular-nums">{formatDateTimeFr(sale.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Client</span>
                <span className="font-medium">{sale.customerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Tarif / Caissier</span>
                <span>
                  {sale.priceTier === 'WHOLESALE' ? 'Gros' : 'Détail'} · {sale.userName}
                </span>
              </div>
            </div>

            <div className="space-y-1.5 border-b border-dashed border-slate-300 py-3 text-xs">
              {sale.items.map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-slate-900">{item.productName}</p>
                    <p className="font-mono text-[11px] tabular-nums text-slate-600">
                      {item.quantity} {item.unitName} × {formatFCFA(item.unitPriceXof)}
                    </p>
                  </div>
                  <span className="font-mono font-medium tabular-nums">
                    {formatFCFA(item.lineTotalXof)}
                  </span>
                </div>
              ))}
            </div>

            <div className="space-y-1 border-b border-dashed border-slate-300 py-2.5 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-600">Sous-total marchandises</span>
                <span className="font-mono tabular-nums">{formatFCFA(sale.subtotalXof)}</span>
              </div>
              {sale.discountXof > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>Remise autorisée</span>
                  <span className="font-mono tabular-nums">-{formatFCFA(sale.discountXof)}</span>
                </div>
              )}
              {sale.consignmentTotalXof > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-600">Consignes emballages (à part)</span>
                  <span className="font-mono tabular-nums">
                    {formatFCFA(sale.consignmentTotalXof)}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-1 text-sm font-bold text-slate-900">
                <span>NET À PAYER</span>
                <span className="font-mono tabular-nums">{formatFCFA(sale.totalPayableXof)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Encaissé</span>
                <span className="font-mono tabular-nums">{formatFCFA(sale.paidAmountXof)}</span>
              </div>
              {sale.creditAmountXof > 0 && (
                <div className="flex justify-between font-semibold text-amber-700">
                  <span>Reste à crédit</span>
                  <span className="font-mono tabular-nums">{formatFCFA(sale.creditAmountXof)}</span>
                </div>
              )}
            </div>

            <div className="space-y-1 py-2.5 text-[11px] text-slate-700">
              {sale.payments.length === 0 ? (
                <p>Règlement : Crédit intégral à échéance</p>
              ) : (
                sale.payments.map((pay) => (
                  <div key={pay.id} className="flex justify-between gap-2">
                    <span>
                      {PAYMENT_METHOD_LABELS[pay.paymentMethod]}
                      {pay.externalReference ? ` (${pay.externalReference})` : ''}
                    </span>
                    <span className="font-mono tabular-nums">{formatFCFA(pay.amountXof)}</span>
                  </div>
                ))
              )}
            </div>

            <div className="border-t border-dashed border-slate-300 pt-2.5 text-center text-[11px] text-slate-600">
              {settings?.receiptFooter ?? 'Merci de votre visite et à bientôt.'}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={handleDownloadHtmlReceipt}>
            <Download className="h-4 w-4" />
            Enregistrer ticket
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Fermer
            </Button>
            <Button type="button" variant="accent" onClick={handlePrint}>
              <Printer className="h-4 w-4" />
              Imprimer / PDF
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
