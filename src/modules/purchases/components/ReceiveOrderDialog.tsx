import { useEffect, useState } from 'react';
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
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/src/components/ui/table';
import { formatFCFA } from '@/src/lib/money';
import type { PurchaseOrder } from '@/src/types/purchase';
import { useReceivePurchaseOrder } from '../services/purchaseService';

interface ReceiveOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: PurchaseOrder | null;
}

export function ReceiveOrderDialog({
  open,
  onOpenChange,
  order,
}: ReceiveOrderDialogProps) {
  const receiveMutation = useReceivePurchaseOrder();
  const [qtyByItem, setQtyByItem] = useState<Record<string, string>>({});
  const [supplierInvoiceRef, setSupplierInvoiceRef] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open || !order) return;
    const init: Record<string, string> = {};
    for (const item of order.items) {
      init[item.id] = String(item.remainingQty);
    }
    setQtyByItem(init);
    setSupplierInvoiceRef('');
    setNote('');
  }, [open, order]);

  if (!order) return null;

  const totalToReceiveXof = order.items.reduce((acc, item) => {
    const raw = qtyByItem[item.id] ?? '0';
    const q = Number.parseInt(raw, 10);
    const safeQ = Number.isNaN(q) || q < 0 ? 0 : Math.min(q, item.remainingQty);
    return acc + safeQ * item.unitCostXof;
  }, 0);

  const handleSubmit = async () => {
    const itemsPayload = order.items
      .map((item) => {
        const q = Number.parseInt(qtyByItem[item.id] ?? '0', 10);
        return {
          purchaseItemId: item.id,
          receivedQty: Number.isNaN(q) ? 0 : q,
        };
      })
      .filter((i) => i.receivedQty > 0);

    if (itemsPayload.length === 0) {
      toast.error('Indiquez au moins une quantité reçue supérieure à 0.');
      return;
    }

    try {
      const receipt = await receiveMutation.mutateAsync({
        id: order.id,
        supplierInvoiceRef: supplierInvoiceRef.trim() || undefined,
        note: note.trim() || undefined,
        items: itemsPayload,
      });
      toast.success(
        `Réception ${receipt.receiptNumber} validée (${formatFCFA(receipt.totalReceivedXof)}). Stock et CUMP mis à jour.`
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec de validation de réception');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Réceptionner : {order.orderNumber}</DialogTitle>
          <DialogDescription>
            Fournisseur : {order.supplierName}. Vous pouvez valider une réception partielle ou complète ; le stock et le CUMP sont mis à jour uniquement pour les quantités réceptionnées.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produit &amp; Unité</TableHead>
                <TableHead className="text-right">Commandé</TableHead>
                <TableHead className="text-right">Déjà reçu</TableHead>
                <TableHead className="text-right">Reliquat</TableHead>
                <TableHead className="w-32 text-right">Reçu ce jour</TableHead>
                <TableHead className="text-right">Équiv. base</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((item) => {
                const rawVal = qtyByItem[item.id] ?? '0';
                const parsed = Number.parseInt(rawVal, 10);
                const safeQ = Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
                const basePreview = safeQ * item.conversionToBase;

                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{item.productName}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {item.unitName} · {formatFCFA(item.unitCostXof)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {item.orderedQty}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {item.receivedQty}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                      {item.remainingQty}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        min={0}
                        max={item.remainingQty}
                        disabled={item.remainingQty === 0}
                        value={rawVal}
                        onChange={(e) =>
                          setQtyByItem((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                        className="h-8 text-right font-mono text-xs tabular-nums"
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      +{basePreview} {item.baseUnitName}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rec-bl">N° Facture / BL fournisseur</Label>
              <Input
                id="rec-bl"
                placeholder="Ex. BL-2026-0842"
                className="font-mono"
                value={supplierInvoiceRef}
                onChange={(e) => setSupplierInvoiceRef(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rec-note">Observation réception</Label>
              <Input
                id="rec-note"
                placeholder="Ex. Livraison partielle conforme"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-md border border-border bg-secondary/40 px-4 py-3 text-right">
            <div className="text-xs text-muted-foreground">Valeur réceptionnée (ajoute à la dette fournisseur)</div>
            <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
              {formatFCFA(totalToReceiveXof)}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            type="button"
            variant="accent"
            onClick={() => void handleSubmit()}
            disabled={receiveMutation.isPending}
          >
            {receiveMutation.isPending ? 'Validation...' : 'Valider la réception'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
