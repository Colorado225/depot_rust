import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Archive,
  Edit3,
  Plus,
  RotateCcw,
  Search,
  Truck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
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
import { Skeleton } from '@/src/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/src/components/ui/table';
import { formatFCFA } from '@/src/lib/money';
import type { AuthenticatedUser } from '@/src/types/auth';
import type { Supplier, SupplierType } from '@/src/types/supplier';
import { supplierFormSchema, type SupplierFormValues } from '../schemas/supplier.schema';
import {
  useCreateSupplier,
  useSuppliers,
  useToggleSupplierActive,
  useUpdateSupplier,
} from '../services/supplierService';

const SUPPLIER_TYPE_LABELS: Record<SupplierType, string> = {
  BRASSERIE: 'Brasserie / Producteur',
  DISTRIBUTEUR: 'Distributeur / Grossiste',
  IMPORTATEUR: 'Importateur',
  AUTRE: 'Autre fournisseur',
};

interface SuppliersViewProps {
  currentUser: AuthenticatedUser;
}

export function SuppliersView({ currentUser }: SuppliersViewProps) {
  const canManage = currentUser.permissions.includes('purchase.manage');

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  const { data: suppliers = [], isLoading } = useSuppliers({ search, includeInactive });
  const { data: allActiveSuppliers = [] } = useSuppliers();

  const createMutation = useCreateSupplier();
  const updateMutation = useUpdateSupplier();
  const toggleActiveMutation = useToggleSupplierActive();

  const form = useForm<SupplierFormValues>({
    resolver: zodResolver(supplierFormSchema) as never,
    defaultValues: {
      name: '',
      supplierType: 'DISTRIBUTEUR',
      phone: '',
      email: '',
      address: '',
      taxId: '',
      paymentTermsDays: 0,
      notes: '',
    },
  });

  useEffect(() => {
    if (!dialogOpen) return;
    if (editingSupplier) {
      form.reset({
        name: editingSupplier.name,
        supplierType: editingSupplier.supplierType,
        phone: editingSupplier.phone ?? '',
        email: editingSupplier.email ?? '',
        address: editingSupplier.address ?? '',
        taxId: editingSupplier.taxId ?? '',
        paymentTermsDays: editingSupplier.paymentTermsDays,
        notes: editingSupplier.notes ?? '',
      });
    } else {
      form.reset({
        name: '',
        supplierType: 'DISTRIBUTEUR',
        phone: '',
        email: '',
        address: '',
        taxId: '',
        paymentTermsDays: 0,
        notes: '',
      });
    }
  }, [dialogOpen, editingSupplier, form]);

  const handleOpenCreate = () => {
    setEditingSupplier(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier);
    setDialogOpen(true);
  };

  const onSubmit = async (values: SupplierFormValues) => {
    const normalized: SupplierFormValues = {
      ...values,
      phone: values.phone?.trim() || null,
      email: values.email?.trim() || null,
      address: values.address?.trim() || null,
      taxId: values.taxId?.trim() || null,
      notes: values.notes?.trim() || null,
    };

    try {
      if (editingSupplier) {
        await updateMutation.mutateAsync({ id: editingSupplier.id, values: normalized });
        toast.success(`Fournisseur « ${normalized.name} » mis à jour.`);
      } else {
        await createMutation.mutateAsync(normalized);
        toast.success(`Fournisseur « ${normalized.name} » enregistré.`);
      }
      setDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde');
    }
  };

  const handleToggleActive = async (supplier: Supplier) => {
    try {
      await toggleActiveMutation.mutateAsync({
        id: supplier.id,
        isActive: !supplier.isActive,
      });
      toast.success(
        supplier.isActive
          ? `Fournisseur « ${supplier.name} » archivé.`
          : `Fournisseur « ${supplier.name} » restauré.`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Impossible de modifier le statut');
    }
  };

  const totalDebtXof = allActiveSuppliers.reduce((acc, s) => acc + s.balanceDueXof, 0);
  const totalLinkedProducts = allActiveSuppliers.reduce(
    (acc, s) => acc + s.linkedProductsCount,
    0
  );
  const isSubmitting = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Référentiel Fournisseurs
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Brasseries, distributeurs et importateurs liés au catalogue, aux achats, aux dettes et aux consignes.
          </p>
        </div>
        {canManage && (
          <Button variant="accent" onClick={handleOpenCreate}>
            <Plus className="h-4 w-4" />
            Nouveau fournisseur
          </Button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Fournisseurs actifs</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {allActiveSuppliers.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Tiers commerciaux habilités à l&apos;approvisionnement
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Dette fournisseurs cumulée</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {formatFCFA(totalDebtXof)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Solde commercial dû (distinct des emballages consignés)
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Produits rattachés</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {totalLinkedProducts}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Articles ayant un fournisseur principal assigné
          </CardContent>
        </Card>
      </div>

      {/* Recherche & Filtres */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher par nom, téléphone ou RCCM / CC..."
                className="pl-9"
              />
            </div>
            <Button
              type="button"
              variant={includeInactive ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setIncludeInactive((v) => !v)}
            >
              {includeInactive ? 'Masquer archivés' : 'Voir archivés'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Liste des fournisseurs */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-44 w-full" />
            </div>
          ) : suppliers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
              <Truck className="h-8 w-8 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  Aucun fournisseur enregistré
                </p>
                <p className="text-xs text-muted-foreground">
                  Ajoutez vos brasseries et distributeurs (ex. Solibra, Brassivoire, grossistes locaux) pour les lier au catalogue et aux futurs bons d&apos;achat.
                </p>
              </div>
              {canManage && (
                <Button variant="accent" size="sm" onClick={handleOpenCreate}>
                  <Plus className="h-4 w-4" />
                  Ajouter un fournisseur
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fournisseur</TableHead>
                  <TableHead>Catégorie</TableHead>
                  <TableHead>Coordonnées</TableHead>
                  <TableHead className="text-right">Délai règlement</TableHead>
                  <TableHead className="text-right">Produits liés</TableHead>
                  <TableHead className="text-right">Solde dû</TableHead>
                  {canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppliers.map((s) => (
                  <TableRow key={s.id} className={!s.isActive ? 'opacity-60' : undefined}>
                    <TableCell>
                      <div className="font-medium text-foreground">{s.name}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {s.taxId ? <span className="font-mono">{s.taxId}</span> : 'Sans n° fiscal'}
                        {s.email ? ` · ${s.email}` : ''}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {SUPPLIER_TYPE_LABELS[s.supplierType] ?? s.supplierType}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>{s.phone ?? '—'}</div>
                      {s.address && <div className="truncate max-w-[220px]">{s.address}</div>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {s.paymentTermsDays === 0 ? 'Comptant' : `${s.paymentTermsDays} j`}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {s.linkedProductsCount}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-medium tabular-nums">
                      {formatFCFA(s.balanceDueXof)}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleOpenEdit(s)}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            Modifier
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleToggleActive(s)}
                            disabled={toggleActiveMutation.isPending}
                          >
                            {s.isActive ? (
                              <>
                                <Archive className="h-3.5 w-3.5" />
                                Archiver
                              </>
                            ) : (
                              <>
                                <RotateCcw className="h-3.5 w-3.5" />
                                Restaurer
                              </>
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Rôle métier des fournisseurs */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rôle des fournisseurs dans DepotPro CI</CardTitle>
          <CardDescription>
            Architecture stricte séparant approvisionnement marchandise, dette financière et consignes d&apos;emballages.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <div className="font-semibold text-foreground">1. Sourcing &amp; Catalogue</div>
              <p className="text-muted-foreground">
                Rattachement sur chaque produit (<span className="font-mono">preferred_supplier_id</span>) et table N-N <span className="font-mono">product_suppliers</span> pour suivre le dernier coût d&apos;achat négocié.
              </p>
            </div>
            <div className="space-y-1">
              <div className="font-semibold text-foreground">2. Achats &amp; CUMP (LOT 4)</div>
              <p className="text-muted-foreground">
                Les bons d&apos;achat et réceptions partielles ou complètes alimentent les entrées en stock et recalculent le CUMP entier en FCFA.
              </p>
            </div>
            <div className="space-y-1">
              <div className="font-semibold text-foreground">3. Dettes &amp; Règlements</div>
              <p className="text-muted-foreground">
                Suivi du solde commercial dû (<span className="font-mono">balance_due_xof</span>) et des paiements échelonnés selon le délai convenu.
              </p>
            </div>
            <div className="space-y-1">
              <div className="font-semibold text-foreground">4. Consignes Brasserie (LOT 6)</div>
              <p className="text-muted-foreground">
                Comptabilité séparée des casiers et bouteilles vides dus aux brasseries ou retournés lors des livraisons.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Dialog Création / Édition */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editingSupplier
                ? `Modifier : ${editingSupplier.name}`
                : 'Nouveau fournisseur'}
            </DialogTitle>
            <DialogDescription>
              Les fournisseurs ne sont jamais supprimés physiquement ; utilisez l&apos;archivage si un compte devient inactif.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="sup-name">Raison sociale / Nom *</Label>
                <Input
                  id="sup-name"
                  placeholder="Ex. SOLIBRA Côte d'Ivoire"
                  {...form.register('name')}
                />
                {form.formState.errors.name && (
                  <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Catégorie fournisseur *</Label>
                <Controller
                  name="supplierType"
                  control={form.control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BRASSERIE">Brasserie / Producteur</SelectItem>
                        <SelectItem value="DISTRIBUTEUR">Distributeur / Grossiste</SelectItem>
                        <SelectItem value="IMPORTATEUR">Importateur</SelectItem>
                        <SelectItem value="AUTRE">Autre</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sup-terms">Délai de règlement (jours)</Label>
                <Input
                  id="sup-terms"
                  type="number"
                  min={0}
                  max={365}
                  className="font-mono tabular-nums"
                  {...form.register('paymentTermsDays')}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sup-phone">Téléphone</Label>
                <Input id="sup-phone" placeholder="+225 07..." {...form.register('phone')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sup-email">Email</Label>
                <Input id="sup-email" placeholder="commandes@..." {...form.register('email')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sup-tax">N° CC / RCCM</Label>
                <Input
                  id="sup-tax"
                  placeholder="Optionnel"
                  className="font-mono"
                  {...form.register('taxId')}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sup-address">Adresse / Zone</Label>
                <Input
                  id="sup-address"
                  placeholder="Zone industrielle Yopougon..."
                  {...form.register('address')}
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="sup-notes">Notes commerciales</Label>
                <Input
                  id="sup-notes"
                  placeholder="Jours de livraison, interlocuteur..."
                  {...form.register('notes')}
                />
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" variant="accent" disabled={isSubmitting}>
                {isSubmitting
                  ? 'Enregistrement...'
                  : editingSupplier
                    ? 'Mettre à jour'
                    : 'Créer le fournisseur'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
