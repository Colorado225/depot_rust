import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
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
import { formatFCFA } from '@/src/lib/money';
import type { Sale } from '@/src/types/pos';
import { cancelSaleSchema, type CancelSaleFormValues } from '../schemas/pos.schema';
import { useCancelSale } from '../services/posService';

interface CancelSaleDialogProps {
  sale: Sale | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CancelSaleDialog({ sale, open, onOpenChange }: CancelSaleDialogProps) {
  const cancelMutation = useCancelSale();
  const form = useForm<CancelSaleFormValues>({
    resolver: zodResolver(cancelSaleSchema) as never,
    defaultValues: { reason: '' },
  });

  useEffect(() => {
    if (open) form.reset({ reason: '' });
  }, [open, form]);

  if (!sale) return null;

  const onSubmit = async (values: CancelSaleFormValues) => {
    try {
      await cancelMutation.mutateAsync({ id: sale.id, reason: values.reason.trim() });
      toast.success(
        `Vente ${sale.saleNumber} annulée par écritures compensatoires (stock réintégré).`
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de l'annulation");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Annuler la vente {sale.saleNumber}</DialogTitle>
          <DialogDescription>
            Montant :{' '}
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {formatFCFA(sale.totalPayableXof)}
            </span>
            . La vente reste archivée ; le stock et la créance seront compensés atomiquement.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cancel-sale-reason">Motif d’annulation obligatoire *</Label>
            <Input
              id="cancel-sale-reason"
              placeholder="Ex: Erreur de saisie quantité / client désisté"
              {...form.register('reason')}
            />
            {form.formState.errors.reason && (
              <p className="text-xs text-destructive">{form.formState.errors.reason.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Retour
            </Button>
            <Button type="submit" variant="destructive" disabled={cancelMutation.isPending}>
              {cancelMutation.isPending ? 'Annulation...' : 'Confirmer l’annulation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
