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
import type { Customer, CustomerType } from '@/src/types/customer';
import { customerFormSchema, type CustomerFormValues } from '../schemas/customer.schema';
import {
  CUSTOMER_TYPE_LABELS,
  useCreateCustomer,
  useUpdateCustomer,
} from '../services/customerService';

interface CustomerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingCustomer: Customer | null;
  onCreated?: (customer: Customer) => void;
}

export function CustomerFormDialog({
  open,
  onOpenChange,
  editingCustomer,
  onCreated,
}: CustomerFormDialogProps) {
  const createMutation = useCreateCustomer();
  const updateMutation = useUpdateCustomer();

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema) as never,
    defaultValues: {
      fullName: '',
      customerType: 'DETAILLANT',
      phone: '',
      email: '',
      address: '',
      creditLimitXof: 0,
      dueDays: 15,
      notes: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    if (editingCustomer) {
      form.reset({
        fullName: editingCustomer.fullName,
        customerType: editingCustomer.customerType,
        phone: editingCustomer.phone ?? '',
        email: editingCustomer.email ?? '',
        address: editingCustomer.address ?? '',
        creditLimitXof: editingCustomer.creditLimitXof,
        dueDays: editingCustomer.dueDays,
        notes: editingCustomer.notes ?? '',
      });
    } else {
      form.reset({
        fullName: '',
        customerType: 'DETAILLANT',
        phone: '',
        email: '',
        address: '',
        creditLimitXof: 0,
        dueDays: 15,
        notes: '',
      });
    }
  }, [open, editingCustomer, form]);

  const onSubmit = async (values: CustomerFormValues) => {
    try {
      const payload = {
        fullName: values.fullName.trim(),
        customerType: values.customerType as CustomerType,
        phone: values.phone?.trim() || null,
        email: values.email?.trim() || null,
        address: values.address?.trim() || null,
        creditLimitXof: values.creditLimitXof,
        dueDays: values.dueDays,
        notes: values.notes?.trim() || null,
      };
      if (editingCustomer) {
        await updateMutation.mutateAsync({ id: editingCustomer.id, ...payload });
        toast.success(`Fiche client « ${payload.fullName} » mise à jour.`);
      } else {
        const created = await createMutation.mutateAsync(payload);
        toast.success(`Client « ${created.fullName} » enregistré.`);
        onCreated?.(created);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec d’enregistrement du client');
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editingCustomer ? `Modifier ${editingCustomer.fullName}` : 'Nouveau client'}
          </DialogTitle>
          <DialogDescription>
            Définissez le profil commercial et le plafond de crédit autorisé en FCFA.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cust-name">Nom complet / Raison sociale *</Label>
              <Input
                id="cust-name"
                placeholder="Ex: Maquis Le Plateau / Kouadio Jean"
                {...form.register('fullName')}
              />
              {form.formState.errors.fullName && (
                <p className="text-xs text-destructive">{form.formState.errors.fullName.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Catégorie client *</Label>
              <Controller
                control={form.control}
                name="customerType"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(CUSTOMER_TYPE_LABELS) as CustomerType[]).map((type) => (
                        <SelectItem key={type} value={type}>
                          {CUSTOMER_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cust-phone">Téléphone</Label>
              <Input
                id="cust-phone"
                placeholder="+225 07 00 00 00 00"
                {...form.register('phone')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cust-limit">Plafond de crédit (FCFA)</Label>
              <Input
                id="cust-limit"
                type="number"
                min={0}
                step={500}
                className="font-mono tabular-nums"
                {...form.register('creditLimitXof')}
              />
              {form.formState.errors.creditLimitXof && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.creditLimitXof.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cust-due-days">Échéance crédit (jours)</Label>
              <Input
                id="cust-due-days"
                type="number"
                min={0}
                max={365}
                className="font-mono tabular-nums"
                {...form.register('dueDays')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cust-address">Quartier / Adresse</Label>
              <Input
                id="cust-address"
                placeholder="Cocody Angré / Yopougon..."
                {...form.register('address')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cust-email">Email</Label>
              <Input id="cust-email" type="email" {...form.register('email')} />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cust-notes">Notes internes</Label>
              <Input
                id="cust-notes"
                placeholder="Conditions habituelles, contact gérant..."
                {...form.register('notes')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={isPending}>
              {isPending
                ? 'Enregistrement...'
                : editingCustomer
                  ? 'Mettre à jour'
                  : 'Créer le client'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
