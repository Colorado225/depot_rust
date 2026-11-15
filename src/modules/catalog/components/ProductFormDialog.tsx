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
import { Separator } from '@/src/components/ui/separator';
import type { Brand, Category, PackagingType, Product, Unit } from '@/src/types/catalog';
import { useSuppliers } from '@/src/modules/suppliers/services/supplierService';
import { productFormSchema, type ProductFormValues } from '../schemas/catalog.schema';
import { useCreateProduct, useUpdateProduct } from '../services/catalogService';

const NONE_VALUE = '__NONE__';

interface ProductFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingProduct: Product | null;
  categories: Category[];
  brands: Brand[];
  units: Unit[];
  packagingTypes: PackagingType[];
}

export function ProductFormDialog({
  open,
  onOpenChange,
  editingProduct,
  categories,
  brands,
  units,
  packagingTypes,
}: ProductFormDialogProps) {
  const createMutation = useCreateProduct();
  const updateMutation = useUpdateProduct();
  const { data: suppliers = [] } = useSuppliers();

  const defaultBaseUnitId =
    units.find((u) => u.code === 'BOUTEILLE')?.id ?? units[0]?.id ?? 'unit-bottle';

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema) as never,
    defaultValues: {
      sku: '',
      barcode: '',
      name: '',
      categoryId: '',
      brandId: '',
      preferredSupplierId: '',
      formatLabel: '',
      baseUnitId: defaultBaseUnitId,
      bottlePackagingTypeId: '',
      cratePackagingTypeId: '',
      purchasePriceXof: 0,
      wholesalePriceXof: 0,
      retailPriceXof: 0,
      alertThresholdBase: 24,
      units: [
        {
          unitId: defaultBaseUnitId,
          conversionToBase: 1,
          wholesalePriceXof: 0,
          retailPriceXof: 0,
          barcode: '',
          isDefaultSaleUnit: true,
        },
      ],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'units',
  });

  useEffect(() => {
    if (!open) return;
    if (editingProduct) {
      reset({
        sku: editingProduct.sku,
        barcode: editingProduct.barcode ?? '',
        name: editingProduct.name,
        categoryId: editingProduct.categoryId ?? '',
        brandId: editingProduct.brandId ?? '',
        preferredSupplierId: editingProduct.preferredSupplierId ?? '',
        formatLabel: editingProduct.formatLabel ?? '',
        baseUnitId: editingProduct.baseUnitId,
        bottlePackagingTypeId: editingProduct.bottlePackagingTypeId ?? '',
        cratePackagingTypeId: editingProduct.cratePackagingTypeId ?? '',
        purchasePriceXof: editingProduct.purchasePriceXof,
        wholesalePriceXof: editingProduct.wholesalePriceXof,
        retailPriceXof: editingProduct.retailPriceXof,
        alertThresholdBase: editingProduct.alertThresholdBase,
        units: editingProduct.units.map((u) => ({
          unitId: u.unitId,
          conversionToBase: u.conversionToBase,
          wholesalePriceXof: u.wholesalePriceXof,
          retailPriceXof: u.retailPriceXof,
          barcode: u.barcode ?? '',
          isDefaultSaleUnit: u.isDefaultSaleUnit,
        })),
      });
    } else {
      reset({
        sku: '',
        barcode: '',
        name: '',
        categoryId: '',
        brandId: '',
        preferredSupplierId: '',
        formatLabel: '',
        baseUnitId: defaultBaseUnitId,
        bottlePackagingTypeId: '',
        cratePackagingTypeId: '',
        purchasePriceXof: 0,
        wholesalePriceXof: 0,
        retailPriceXof: 0,
        alertThresholdBase: 24,
        units: [
          {
            unitId: defaultBaseUnitId,
            conversionToBase: 1,
            wholesalePriceXof: 0,
            retailPriceXof: 0,
            barcode: '',
            isDefaultSaleUnit: true,
          },
        ],
      });
    }
  }, [open, editingProduct, reset, defaultBaseUnitId]);

  const baseUnitId = watch('baseUnitId');
  const bottlePackagings = packagingTypes.filter((p) => p.kind === 'BOTTLE');
  const cratePackagings = packagingTypes.filter((p) => p.kind === 'CRATE' || p.kind === 'OTHER');

  const onSubmit = async (values: ProductFormValues) => {
    const normalized: ProductFormValues = {
      ...values,
      categoryId: values.categoryId || null,
      brandId: values.brandId || null,
      preferredSupplierId: values.preferredSupplierId || null,
      barcode: values.barcode?.trim() || null,
      formatLabel: values.formatLabel?.trim() || null,
      bottlePackagingTypeId: values.bottlePackagingTypeId || null,
      cratePackagingTypeId: values.cratePackagingTypeId || null,
      units: values.units.map((u) => ({
        ...u,
        barcode: u.barcode?.trim() || null,
      })),
    };

    try {
      if (editingProduct) {
        await updateMutation.mutateAsync({ id: editingProduct.id, values: normalized });
        toast.success(`Produit « ${normalized.name} » mis à jour.`);
      } else {
        await createMutation.mutateAsync(normalized);
        toast.success(`Produit « ${normalized.name} » ajouté au catalogue.`);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde');
    }
  };

  const handleAddUnitRow = () => {
    const usedIds = new Set(fields.map((f) => f.unitId));
    const nextUnit = units.find((u) => !usedIds.has(u.id)) ?? units[0];
    if (!nextUnit) return;
    append({
      unitId: nextUnit.id,
      conversionToBase: nextUnit.code === 'CASIER' ? 24 : nextUnit.code === 'PACK' ? 6 : 12,
      wholesalePriceXof: 0,
      retailPriceXof: 0,
      barcode: '',
      isDefaultSaleUnit: false,
    });
  };

  const isSubmitting = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editingProduct ? `Modifier : ${editingProduct.name}` : 'Nouveau produit du catalogue'}
          </DialogTitle>
          <DialogDescription>
            Définissez les tarifs FCFA (entiers), emballages consignés et conversions propres à ce produit.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          {/* Identification */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="prod-name">Désignation *</Label>
              <Input
                id="prod-name"
                placeholder="Ex. Bock Solibra 65cl"
                {...register('name')}
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prod-sku">Référence SKU *</Label>
              <Input
                id="prod-sku"
                placeholder="Ex. BOCK-65"
                className="font-mono uppercase"
                {...register('sku')}
              />
              {errors.sku && <p className="text-xs text-destructive">{errors.sku.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label>Catégorie</Label>
              <Controller
                name="categoryId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || NONE_VALUE}
                    onValueChange={(v) => field.onChange(v === NONE_VALUE ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Aucune" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>Aucune catégorie</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Marque</Label>
              <Controller
                name="brandId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || NONE_VALUE}
                    onValueChange={(v) => field.onChange(v === NONE_VALUE ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Aucune" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>Aucune marque</SelectItem>
                      {brands.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prod-format">Format / Contenance</Label>
              <Input id="prod-format" placeholder="Ex. 65 cl" {...register('formatLabel')} />
            </div>

            <div className="space-y-1.5">
              <Label>Fournisseur principal</Label>
              <Controller
                name="preferredSupplierId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || NONE_VALUE}
                    onValueChange={(v) => field.onChange(v === NONE_VALUE ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Non assigné" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>Aucun fournisseur assigné</SelectItem>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prod-barcode">Code-barres principal</Label>
              <Input
                id="prod-barcode"
                placeholder="Optionnel"
                className="font-mono"
                {...register('barcode')}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Unité de base (Stock = 1) *</Label>
              <Controller
                name="baseUnitId"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {units
                        .filter((u) => u.isBaseUnit)
                        .map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prod-alert">Seuil d&apos;alerte (unité de base)</Label>
              <Input
                id="prod-alert"
                type="number"
                min={0}
                className="font-mono tabular-nums"
                {...register('alertThresholdBase')}
              />
            </div>
          </div>

          <Separator />

          {/* Tarification & Emballages Consignés */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="prod-buy">Prix d&apos;achat base (FCFA)</Label>
              <Input
                id="prod-buy"
                type="number"
                min={0}
                className="font-mono tabular-nums"
                {...register('purchasePriceXof')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prod-whole">Prix de gros base (FCFA)</Label>
              <Input
                id="prod-whole"
                type="number"
                min={0}
                className="font-mono tabular-nums"
                {...register('wholesalePriceXof')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prod-retail">Prix de détail base (FCFA)</Label>
              <Input
                id="prod-retail"
                type="number"
                min={0}
                className="font-mono tabular-nums"
                {...register('retailPriceXof')}
              />
            </div>

            <div className="space-y-1.5 sm:col-span-1">
              <Label>Consigne bouteille associée</Label>
              <Controller
                name="bottlePackagingTypeId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || NONE_VALUE}
                    onValueChange={(v) => field.onChange(v === NONE_VALUE ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Sans consigne bouteille" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>Sans consigne bouteille</SelectItem>
                      {bottlePackagings.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} ({p.depositAmountXof} FCFA)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label>Consigne casier / emballage groupé associée</Label>
              <Controller
                name="cratePackagingTypeId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value || NONE_VALUE}
                    onValueChange={(v) => field.onChange(v === NONE_VALUE ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Sans consigne casier" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>Sans consigne casier</SelectItem>
                      {cratePackagings.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} ({p.depositAmountXof} FCFA)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <Separator />

          {/* Conversions par produit */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  Conditionnements &amp; Conversions propres à ce produit
                </h4>
                <p className="text-xs text-muted-foreground">
                  Ex. 1 Casier = 24 Bouteilles pour une bière, ou 1 Casier = 12 Bouteilles pour un autre format.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleAddUnitRow}>
                <Plus className="h-4 w-4" />
                Ajouter unité
              </Button>
            </div>

            {errors.units?.message && (
              <p className="text-xs text-destructive">{errors.units.message}</p>
            )}

            <div className="space-y-2.5">
              {fields.map((fieldItem, idx) => {
                const currentUnitId = watch(`units.${idx}.unitId`);
                const isBase = currentUnitId === baseUnitId;
                return (
                  <div
                    key={fieldItem.id}
                    className="grid grid-cols-1 gap-2.5 rounded-md border border-border p-3 sm:grid-cols-12 sm:items-end"
                  >
                    <div className="space-y-1 sm:col-span-3">
                      <Label className="text-xs">Unité</Label>
                      <Controller
                        name={`units.${idx}.unitId`}
                        control={control}
                        render={({ field }) => (
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {units.map((u) => (
                                <SelectItem key={u.id} value={u.id}>
                                  {u.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </div>

                    <div className="space-y-1 sm:col-span-2">
                      <Label className="text-xs">Qté base</Label>
                      <Input
                        type="number"
                        min={1}
                        readOnly={isBase}
                        className="h-9 font-mono text-xs tabular-nums"
                        {...register(`units.${idx}.conversionToBase`)}
                      />
                    </div>

                    <div className="space-y-1 sm:col-span-2">
                      <Label className="text-xs">Gros (FCFA)</Label>
                      <Input
                        type="number"
                        min={0}
                        className="h-9 font-mono text-xs tabular-nums"
                        {...register(`units.${idx}.wholesalePriceXof`)}
                      />
                    </div>

                    <div className="space-y-1 sm:col-span-2">
                      <Label className="text-xs">Détail (FCFA)</Label>
                      <Input
                        type="number"
                        min={0}
                        className="h-9 font-mono text-xs tabular-nums"
                        {...register(`units.${idx}.retailPriceXof`)}
                      />
                    </div>

                    <div className="space-y-1 sm:col-span-2">
                      <Label className="text-xs">Code-barres</Label>
                      <Input
                        placeholder="Optionnel"
                        className="h-9 font-mono text-xs"
                        {...register(`units.${idx}.barcode`)}
                      />
                    </div>

                    <div className="flex items-center justify-end sm:col-span-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={isBase || fields.length <= 1}
                        onClick={() => remove(idx)}
                        aria-label="Retirer cette unité"
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={isSubmitting}>
              {isSubmitting
                ? 'Enregistrement...'
                : editingProduct
                  ? 'Mettre à jour'
                  : 'Créer le produit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
