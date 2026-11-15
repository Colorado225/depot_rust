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
import type { Customer, CustomerPaymentMethod } from '@/src/types/customer';
import {
  customerPaymentFormSchema,
  type CustomerPaymentFormValues,
} from '../schemas/customer.schema';
import { PAYMENT_METHOD_LABELS, useRecordCustomerPayment } from '../services/customerService';

interface CustomerPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: Customer | null;
  preselectedSaleId?: string | null;
  maxAmountXof?: number;
}

export function CustomerPaymentDialog({
  open,
  onOpenChange,
  customer,
  preselectedSaleId,
  maxAmountXof,
}: CustomerPaymentDialogProps) {
  const paymentMutation = useRecordCustomerPayment();
  const maxPayable = maxAmountXof ?? customer?.commercialDebtXof ?? 0;

  const form = useForm<CustomerPaymentFormValues>({
    resolver: zodResolver(customerPaymentFormSchema) as never,
    defaultValues: {
      customerId: '',
      saleId: '',
      paymentMethod: 'CASH',
      amountXof: 0,
      externalReference: '',
    },
  });

  useEffect(() => {
    if (!open || !customer) return;
    form.reset({
      customerId: customer.id,
      saleId: preselectedSaleId ?? '',
      paymentMethod: 'CASH',
      amountXof: maxPayable > 0 ? maxPayable : 0,
      externalReference: '',
    });
  }, [open, customer, preselectedSaleId, maxPayable, form]);

  const onSubmit = async (values: CustomerPaymentFormValues) => {
    if (!customer) return;
    try {
      const payment = await paymentMutation.mutateAsync({
        customerId: customer.id,
        saleId: values.saleId ? values.saleId : null,
        paymentMethod: values.paymentMethod as CustomerPaymentMethod,
        amountXof: values.amountXof,
        externalReference: values.externalReference?.trim() || null,
      });
      toast.success(
        `Règlement ${payment.paymentNumber} de ${formatFCFA(payment.amountXof)} encaissé.`
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors du recouvrement');
    }
  };

  if (!customer) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Encaisser un règlement client</DialogTitle>
          <DialogDescription>
            {customer.fullName} · Créance commerciale due :{' '}
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {formatFCFA(maxPayable)}
            </span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Canal d’encaissement *</Label>
            <Controller
              control={form.control}
              name="paymentMethod"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PAYMENT_METHOD_LABELS) as CustomerPaymentMethod[]).map(
                      (method) => (
                        <SelectItem key={method} value={method}>
                          {PAYMENT_METHOD_LABELS[method]}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="cust-pay-amount">Montant encaissé (FCFA) *</Label>
              <button
                type="button"
                onClick={() => form.setValue('amountXof', maxPayable)}
                className="text-xs font-medium text-primary hover:underline cursor-pointer"
              >
                Solder ({formatFCFA(maxPayable)})
              </button>
            </div>
            <Input
              id="cust-pay-amount"
              type="number"
              min={1}
              max={maxPayable}
              className="font-mono tabular-nums"
              {...form.register('amountXof')}
            />
            {form.formState.errors.amountXof && (
              <p className="text-xs text-destructive">{form.formState.errors.amountXof.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cust-pay-ref">Référence transaction (Mobile Money / Virement)</Label>
            <Input
              id="cust-pay-ref"
              placeholder="Ex: WAVE-2026-9921 ou OM-12345"
              {...form.register('externalReference')}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={paymentMutation.isPending}>
              {paymentMutation.isPending ? 'Encaissement...' : 'Valider le règlement'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
