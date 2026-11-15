import { useEffect } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
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
import type { Product } from '@/src/types/catalog';
import type { Supplier } from '@/src/types/supplier';
import {
  createPurchaseOrderSchema,
  type CreatePurchaseOrderValues,
} from '../schemas/purchase.schema';
import { useCreatePurchaseOrder } from '../services/purchaseService';

interface PurchaseOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suppliers: Supplier[];
  products: Product[];
}

export function PurchaseOrderDialog({
  open,
  onOpenChange,
  suppliers,
  products,
}: PurchaseOrderDialogProps) {
  const createMutation = useCreatePurchaseOrder();

  const getDefaultProductSetup = (prod?: Product) => {
    if (!prod) return { productId: '', unitId: '', unitCostXof: 0 };
    const defaultUnit = prod.units.find((u) => u.isDefaultSaleUnit) ?? prod.units[0];
    const basePurchase = prod.purchasePriceXof || prod.weightedAvgCostXof;
    return {
      productId: prod.id,
      unitId: defaultUnit?.unitId ?? prod.baseUnitId,
      unitCostXof: basePurchase * (defaultUnit?.conversionToBase ?? 1),
    };
  };

  const form = useForm<CreatePurchaseOrderValues>({
    resolver: zodResolver(createPurchaseOrderSchema) as never,
    defaultValues: {
      supplierId: '',
      validateImmediately: true,
      note: '',
      items: [
        {
          ...getDefaultProductSetup(products[0]),
          orderedQty: 1,
        },
      ],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'items',
  });

  useEffect(() => {
    if (!open) return;
    const firstSup = suppliers[0]?.id ?? '';
    const firstProd = getDefaultProductSetup(products[0]);
    form.reset({
      supplierId: firstSup,
      validateImmediately: true,
      note: '',
      items: [{ ...firstProd, orderedQty: 1 }],
    });
  }, [open, suppliers, products, form]);

  const watchedItems = form.watch('items');
  const orderTotalXof = watchedItems.reduce((sum, line) => {
    const q = Number(line?.orderedQty) || 0;
    const c = Number(line?.unitCostXof) || 0;
    return sum + Math.max(0, Math.trunc(q)) * Math.max(0, Math.trunc(c));
  }, 0);

  const handleProductChange = (idx: number, productId: string) => {
    const prod = products.find((p) => p.id === productId);
    form.setValue(`items.${idx}.productId`, productId);
    if (prod) {
      const defUnit = prod.units.find((u) => u.isDefaultSaleUnit) ?? prod.units[0];
      if (defUnit) {
        form.setValue(`items.${idx}.unitId`, defUnit.unitId);
        const basePurchase = prod.purchasePriceXof || prod.weightedAvgCostXof;
        form.setValue(`items.${idx}.unitCostXof`, basePurchase * defUnit.conversionToBase);
      }
    }
  };

  const handleUnitChange = (idx: number, unitId: string) => {
    const prodId = form.getValues(`items.${idx}.productId`);
    const prod = products.find((p) => p.id === prodId);
    form.setValue(`items.${idx}.unitId`, unitId);
    if (prod) {
      const unitCfg = prod.units.find((u) => u.unitId === unitId);
      if (unitCfg) {
        const basePurchase = prod.purchasePriceXof || prod.weightedAvgCostXof;
        form.setValue(`items.${idx}.unitCostXof`, basePurchase * unitCfg.conversionToBase);
      }
    }
  };

  const handleAddLine = () => {
    const first = getDefaultProductSetup(products[0]);
    append({ ...first, orderedQty: 1 });
  };

  const onSubmit = async (values: CreatePurchaseOrderValues) => {
    try {
      const created = await createMutation.mutateAsync(values);
      toast.success(
        `Bon de commande ${created.orderNumber} créé (${created.status === 'VALIDATED' ? 'validé, en attente de réception' : 'brouillon'}).`
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur création bon de commande');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nouveau bon de commande fournisseur</DialogTitle>
          <DialogDescription>
            La création ou validation d&apos;une commande n&apos;augmente pas le stock ; seule la réception physique alimentera le stock et le CUMP.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Fournisseur *</Label>
              <Controller
                name="supplierId"
                control={form.control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choisir un fournisseur" />
                    </SelectTrigger>
                    <SelectContent>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {form.formState.errors.supplierId && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.supplierId.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Statut initial</Label>
              <Controller
                name="validateImmediately"
                control={form.control}
                render={({ field }) => (
                  <Select
                    value={field.value ? 'VALIDATED' : 'DRAFT'}
                    onValueChange={(v) => field.onChange(v === 'VALIDATED')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="VALIDATED">En attente (Validée pour réception)</SelectItem>
                      <SelectItem value="DRAFT">Brouillon</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label>Lignes commandées *</Label>
              <Button type="button" variant="outline" size="sm" onClick={handleAddLine}>
                <Plus className="h-4 w-4" />
                Ajouter une ligne
              </Button>
            </div>

            {fields.map((fieldItem, idx) => {
              const prodId = watchedItems[idx]?.productId;
              const prod = products.find((p) => p.id === prodId);
              const qty = Number(watchedItems[idx]?.orderedQty) || 0;
              const cost = Number(watchedItems[idx]?.unitCostXof) || 0;
              const lineTotal = Math.max(0, Math.trunc(qty)) * Math.max(0, Math.trunc(cost));

              return (
                <div
                  key={fieldItem.id}
                  className="grid grid-cols-1 gap-2.5 rounded-md border border-border p-3 sm:grid-cols-12 sm:items-end"
                >
                  <div className="space-y-1 sm:col-span-4">
                    <Label className="text-xs">Produit</Label>
                    <Controller
                      name={`items.${idx}.productId`}
                      control={form.control}
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(v) => handleProductChange(idx, v)}
                        >
                          <SelectTrigger className="h-9 text-xs">
                            <SelectValue placeholder="Produit" />
                          </SelectTrigger>
                          <SelectContent>
                            {products.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name} ({p.sku})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-3">
                    <Label className="text-xs">Conditionnement</Label>
                    <Controller
                      name={`items.${idx}.unitId`}
                      control={form.control}
                      render={({ field }) => (
                        <Select
                          value={field.value}
                          onValueChange={(v) => handleUnitChange(idx, v)}
                          disabled={!prod}
                        >
                          <SelectTrigger className="h-9 text-xs">
                            <SelectValue placeholder="Unité" />
                          </SelectTrigger>
                          <SelectContent>
                            {(prod?.units ?? []).map((u) => (
                              <SelectItem key={u.unitId} value={u.unitId}>
                                {u.unitName} (×{u.conversionToBase})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Qté</Label>
                    <Input
                      type="number"
                      min={1}
                      className="h-9 font-mono text-xs tabular-nums"
                      {...form.register(`items.${idx}.orderedQty`)}
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Coût unit. (FCFA)</Label>
                    <Input
                      type="number"
                      min={0}
                      className="h-9 font-mono text-xs tabular-nums"
                      {...form.register(`items.${idx}.unitCostXof`)}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2 sm:col-span-1 sm:justify-end">
                    <span className="font-mono text-xs tabular-nums text-muted-foreground sm:hidden">
                      {formatFCFA(lineTotal)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={fields.length <= 1}
                      onClick={() => remove(idx)}
                      aria-label="Retirer cette ligne"
                      title={`Sous-total ligne : ${formatFCFA(lineTotal)}`}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="po-note">Note / Référence commande</Label>
              <Input
                id="po-note"
                placeholder="Ex. Livraison prévue mardi matin"
                {...form.register('note')}
              />
            </div>

            <div className="rounded-md border border-border bg-secondary/40 px-4 py-3 text-right">
              <div className="text-xs text-muted-foreground">Total estimé de la commande</div>
              <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                {formatFCFA(orderTotalXof)}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Création...' : 'Enregistrer la commande'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
