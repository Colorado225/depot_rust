import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
import type { PurchaseOrder } from '@/src/types/purchase';
import type { Supplier } from '@/src/types/supplier';
import {
  supplierPaymentFormSchema,
  type SupplierPaymentFormValues,
} from '../schemas/purchase.schema';
import { useRecordSupplierPayment } from '../services/purchaseService';

interface SupplierPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suppliers: Supplier[];
  targetOrder?: PurchaseOrder | null;
}

export function SupplierPaymentDialog({
  open,
  onOpenChange,
  suppliers,
  targetOrder,
}: SupplierPaymentDialogProps) {
  const paymentMutation = useRecordSupplierPayment();

  const form = useForm<SupplierPaymentFormValues>({
    resolver: zodResolver(supplierPaymentFormSchema) as never,
    defaultValues: {
      supplierId: '',
      purchaseOrderId: '',
      paymentMethod: 'CASH',
      amountXof: 0,
      externalReference: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    if (targetOrder) {
      const suggested =
        targetOrder.remainingToPayOnReceivedXof > 0
          ? targetOrder.remainingToPayOnReceivedXof
          : targetOrder.remainingToPayOnOrderXof;
      form.reset({
        supplierId: targetOrder.supplierId,
        purchaseOrderId: targetOrder.id,
        paymentMethod: 'CASH',
        amountXof: suggested,
        externalReference: '',
      });
    } else {
      const firstWithDebt = suppliers.find((s) => s.balanceDueXof > 0) ?? suppliers[0];
      form.reset({
        supplierId: firstWithDebt?.id ?? '',
        purchaseOrderId: '',
        paymentMethod: 'CASH',
        amountXof: firstWithDebt?.balanceDueXof ?? 0,
        externalReference: '',
      });
    }
  }, [open, targetOrder, suppliers, form]);

  const selectedSupplierId = form.watch('supplierId');
  const selectedSupplier = suppliers.find((s) => s.id === selectedSupplierId);

  const onSubmit = async (values: SupplierPaymentFormValues) => {
    try {
      const created = await paymentMutation.mutateAsync(values);
      toast.success(
        `Règlement ${created.paymentNumber} de ${formatFCFA(created.amountXof)} enregistré.`
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors du règlement');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {targetOrder
              ? `Régler le bon ${targetOrder.orderNumber}`
              : 'Enregistrer un règlement fournisseur'}
          </DialogTitle>
          <DialogDescription>
            Paiement sortant traçable diminuant la dette commerciale du fournisseur.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Fournisseur *</Label>
            <Controller
              name="supplierId"
              control={form.control}
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={Boolean(targetOrder)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choisir un fournisseur" />
                  </SelectTrigger>
                  <SelectContent>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} (Dû : {formatFCFA(s.balanceDueXof)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {selectedSupplier && !targetOrder && (
              <p className="font-mono text-xs tabular-nums text-muted-foreground">
                Dette exigible actuelle : {formatFCFA(selectedSupplier.balanceDueXof)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Mode de règlement *</Label>
              <Controller
                name="paymentMethod"
                control={form.control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CASH">Espèces (Caisse)</SelectItem>
                      <SelectItem value="ORANGE_MONEY">Orange Money</SelectItem>
                      <SelectItem value="MTN_MOMO">MTN MoMo</SelectItem>
                      <SelectItem value="MOOV_MONEY">Moov Money</SelectItem>
                      <SelectItem value="WAVE">Wave</SelectItem>
                      <SelectItem value="BANK_TRANSFER">Virement bancaire</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">Montant payé (FCFA) *</Label>
              <Input
                id="pay-amount"
                type="number"
                min={1}
                className="font-mono tabular-nums"
                {...form.register('amountXof')}
              />
              {form.formState.errors.amountXof && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.amountXof.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-ref">Référence transaction / Reçu</Label>
            <Input
              id="pay-ref"
              placeholder="Ex. ID Mobile Money, N° chèque ou bordereau"
              className="font-mono"
              {...form.register('externalReference')}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={paymentMutation.isPending}>
              {paymentMutation.isPending ? 'Enregistrement...' : 'Valider le règlement'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
