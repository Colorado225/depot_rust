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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/src/components/ui/select';
import { formatFCFA } from '@/src/lib/money';
import { PAYMENT_METHOD_LABELS } from '@/src/modules/customers/services/customerService';
import type { ConsignmentBalance } from '@/src/types/consignment';
import type { CustomerPaymentMethod } from '@/src/types/customer';
import { useCustomerConsignmentReturn } from '../services/consignmentService';

interface CustomerReturnDialogProps {
  balance: ConsignmentBalance | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CustomerReturnDialog({ balance, open, onOpenChange }: CustomerReturnDialogProps) {
  const returnMutation = useCustomerConsignmentReturn();
  const [quantity, setQuantity] = useState(1);
  const [refundCustomer, setRefundCustomer] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState<CustomerPaymentMethod>('CASH');
  const [externalReference, setExternalReference] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open && balance) {
      setQuantity(Math.min(1, balance.quantity) || 1);
      setRefundCustomer(true);
      setPaymentMethod('CASH');
      setExternalReference('');
      setNote('');
    }
  }, [open, balance]);

  if (!balance) return null;

  const estimatedRefundXof = Math.min(
    balance.depositValueXof,
    Math.max(0, quantity) * balance.depositAmountXof
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await returnMutation.mutateAsync({
        customerId: balance.holderId,
        packagingTypeId: balance.packagingTypeId,
        quantity,
        refundCustomer,
        paymentMethod: refundCustomer ? paymentMethod : undefined,
        externalReference: refundCustomer ? externalReference.trim() || null : null,
        note: note.trim() || null,
      });

      toast.success(
        `Retour enregistré (${quantity} × ${balance.packagingName}). Reste client : ${res.remainingCustomerQty}.`
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors du retour de consigne');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Retour d’emballages consignés</DialogTitle>
          <DialogDescription>
            {balance.holderName} · {balance.packagingName} · Détenu :{' '}
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {balance.quantity}
            </span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="ret-qty">Quantité retournée *</Label>
              <button
                type="button"
                onClick={() => setQuantity(balance.quantity)}
                className="text-xs font-medium text-primary hover:underline cursor-pointer"
              >
                Tout retourner ({balance.quantity})
              </button>
            </div>
            <Input
              id="ret-qty"
              type="number"
              min={1}
              max={balance.quantity}
              value={quantity}
              onChange={(e) =>
                setQuantity(
                  Math.max(1, Math.min(balance.quantity, Number.parseInt(e.target.value, 10) || 1))
                )
              }
              className="font-mono tabular-nums"
            />
          </div>

          <label className="flex items-center justify-between rounded-md border border-border p-3 text-sm cursor-pointer">
            <span>Rembourser la consigne au client</span>
            <input
              type="checkbox"
              checked={refundCustomer}
              onChange={(e) => setRefundCustomer(e.target.checked)}
            />
          </label>

          {refundCustomer && (
            <div className="space-y-3 rounded-md border border-border bg-secondary/40 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Montant remboursé</span>
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {formatFCFA(estimatedRefundXof)}
                </span>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Canal de remboursement</Label>
                <Select
                  value={paymentMethod}
                  onValueChange={(v) => setPaymentMethod(v as CustomerPaymentMethod)}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PAYMENT_METHOD_LABELS) as CustomerPaymentMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Input
                placeholder="Référence transaction (optionnel)"
                value={externalReference}
                onChange={(e) => setExternalReference(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ret-cons-note">Observation</Label>
            <Input
              id="ret-cons-note"
              placeholder="Ex: Retour partiel fin de week-end"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={returnMutation.isPending}>
              {returnMutation.isPending ? 'Validation...' : 'Enregistrer le retour'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
