import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Archive,
  Box,
  Edit3,
  Layers,
  Package,
  Plus,
  RotateCcw,
  Search,
  Tag,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { formatFCFA } from '@/src/lib/money';
import type { AuthenticatedUser } from '@/src/types/auth';
import type { Product } from '@/src/types/catalog';
import {
  brandFormSchema,
  categoryFormSchema,
  packagingTypeFormSchema,
  type BrandFormValues,
  type CategoryFormValues,
  type PackagingTypeFormValues,
} from '../schemas/catalog.schema';
import {
  useBrands,
  useCategories,
  useCreateBrand,
  useCreateCategory,
  useCreatePackagingType,
  usePackagingTypes,
  useProducts,
  useToggleProductActive,
  useUnits,
} from '../services/catalogService';
import { ProductFormDialog } from './ProductFormDialog';

const ALL_FILTER = '__ALL__';

interface CatalogManagementViewProps {
  currentUser: AuthenticatedUser;
}

export function CatalogManagementView({ currentUser }: CatalogManagementViewProps) {
  const canWrite = currentUser.permissions.includes('catalog.products.write');

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const { data: categories = [] } = useCategories();
  const { data: brands = [] } = useBrands();
  const { data: units = [] } = useUnits();
  const { data: packagingTypes = [] } = usePackagingTypes();
  const { data: products = [], isLoading: loadingProducts } = useProducts({
    search,
    categoryId: categoryFilter,
    brandId: brandFilter,
    includeInactive,
  });

  const toggleActiveMutation = useToggleProductActive();
  const createCategoryMutation = useCreateCategory();
  const createBrandMutation = useCreateBrand();
  const createPackagingMutation = useCreatePackagingType();

  const catForm = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: { name: '', description: '' },
  });

  const brandForm = useForm<BrandFormValues>({
    resolver: zodResolver(brandFormSchema),
    defaultValues: { name: '' },
  });

  const pkgForm = useForm<PackagingTypeFormValues>({
    resolver: zodResolver(packagingTypeFormSchema) as never,
    defaultValues: { code: '', name: '', kind: 'CRATE', depositAmountXof: 3000 },
  });

  const handleOpenCreate = () => {
    setEditingProduct(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (product: Product) => {
    setEditingProduct(product);
    setDialogOpen(true);
  };

  const handleToggleArchive = async (product: Product) => {
    try {
      await toggleActiveMutation.mutateAsync({
        id: product.id,
        isActive: !product.isActive,
      });
      toast.success(
        product.isActive
          ? `Produit « ${product.name} » archivé.`
          : `Produit « ${product.name} » restauré.`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Impossible de modifier le statut');
    }
  };

  const onCreateCategory = async (values: CategoryFormValues) => {
    try {
      await createCategoryMutation.mutateAsync(values);
      toast.success(`Catégorie « ${values.name} » ajoutée.`);
      catForm.reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur création catégorie');
    }
  };

  const onCreateBrand = async (values: BrandFormValues) => {
    try {
      await createBrandMutation.mutateAsync(values);
      toast.success(`Marque « ${values.name} » ajoutée.`);
      brandForm.reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur création marque');
    }
  };

  const onCreatePackaging = async (values: PackagingTypeFormValues) => {
    try {
      await createPackagingMutation.mutateAsync(values);
      toast.success(`Emballage « ${values.name} » enregistré.`);
      pkgForm.reset({ code: '', name: '', kind: 'CRATE', depositAmountXof: 3000 });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur création emballage');
    }
  };

  const kindLabel = (kind: 'BOTTLE' | 'CRATE' | 'OTHER') => {
    if (kind === 'BOTTLE') return 'Bouteille vide';
    if (kind === 'CRATE') return 'Casier vide';
    return 'Autre emballage';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Catalogue Produits &amp; Conditionnements
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tarifs gros/détail en FCFA, conversions configurées par produit et emballages consignés associés.
          </p>
        </div>
        {canWrite && (
          <Button variant="accent" onClick={handleOpenCreate}>
            <Plus className="h-4 w-4" />
            Nouveau produit
          </Button>
        )}
      </div>

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">Produits ({products.length})</TabsTrigger>
          <TabsTrigger value="taxonomies">
            Catégories &amp; Marques ({categories.length + brands.length})
          </TabsTrigger>
          <TabsTrigger value="packaging">
            Emballages consignés ({packagingTypes.length})
          </TabsTrigger>
        </TabsList>

        {/* Onglet 1 : Produits */}
        <TabsContent value="products" className="space-y-4">
          <Card>
            <CardContent className="pt-5">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                <div className="relative md:col-span-5">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Rechercher par nom, SKU ou code-barres..."
                    className="pl-9"
                  />
                </div>

                <div className="md:col-span-3">
                  <Select
                    value={categoryFilter || ALL_FILTER}
                    onValueChange={(v) => setCategoryFilter(v === ALL_FILTER ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Toutes catégories" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>Toutes catégories</SelectItem>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="md:col-span-2">
                  <Select
                    value={brandFilter || ALL_FILTER}
                    onValueChange={(v) => setBrandFilter(v === ALL_FILTER ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Toutes marques" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>Toutes marques</SelectItem>
                      {brands.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-end md:col-span-2">
                  <Button
                    type="button"
                    variant={includeInactive ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => setIncludeInactive((v) => !v)}
                  >
                    {includeInactive ? 'Masquer archivés' : 'Voir archivés'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {loadingProducts ? (
                <div className="p-6">
                  <Skeleton className="h-44 w-full" />
                </div>
              ) : products.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
                  <Package className="h-8 w-8 text-muted-foreground" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      Aucun produit enregistré dans le catalogue
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Commencez par créer vos boissons, conditionnements (casiers, packs, bouteilles) et consignes associées.
                    </p>
                  </div>
                  {canWrite && (
                    <Button variant="accent" size="sm" onClick={handleOpenCreate}>
                      <Plus className="h-4 w-4" />
                      Créer le premier produit
                    </Button>
                  )}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produit &amp; Référence</TableHead>
                      <TableHead>Conditionnements</TableHead>
                      <TableHead>Consignes liées</TableHead>
                      <TableHead className="text-right">Achat</TableHead>
                      <TableHead className="text-right">Gros</TableHead>
                      <TableHead className="text-right">Détail</TableHead>
                      <TableHead className="text-right">Stock / Seuil</TableHead>
                      {canWrite && <TableHead className="text-right">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((p) => (
                      <TableRow key={p.id} className={!p.isActive ? 'opacity-60' : undefined}>
                        <TableCell>
                          <div className="font-medium text-foreground">{p.name}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            <span className="font-mono">{p.sku}</span>
                            {p.formatLabel ? ` · ${p.formatLabel}` : ''}
                            {p.categoryName ? ` · ${p.categoryName}` : ''}
                            {p.brandName ? ` · ${p.brandName}` : ''}
                            {p.preferredSupplierName ? ` · Fourn. ${p.preferredSupplierName}` : ''}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5 text-xs">
                            {p.units.map((u) => (
                              <div key={u.id} className="font-mono tabular-nums text-foreground">
                                1 {u.unitName} = {u.conversionToBase} {p.baseUnitName}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {p.cratePackagingName || p.bottlePackagingName ? (
                            <div className="space-y-0.5">
                              {p.cratePackagingName && (
                                <div>
                                  {p.cratePackagingName} ({formatFCFA(p.crateDepositXof)})
                                </div>
                              )}
                              {p.bottlePackagingName && (
                                <div>
                                  {p.bottlePackagingName} ({formatFCFA(p.bottleDepositXof)})
                                </div>
                              )}
                            </div>
                          ) : (
                            'Sans consigne'
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatFCFA(p.purchasePriceXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatFCFA(p.wholesalePriceXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium tabular-nums">
                          {formatFCFA(p.retailPriceXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {p.stockQuantityBase} / {p.alertThresholdBase} {p.baseUnitName}
                        </TableCell>
                        {canWrite && (
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleOpenEdit(p)}
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                                Modifier
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void handleToggleArchive(p)}
                                disabled={toggleActiveMutation.isPending}
                              >
                                {p.isActive ? (
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
        </TabsContent>

        {/* Onglet 2 : Catégories & Marques */}
        <TabsContent value="taxonomies">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  Catégories ({categories.length})
                </CardTitle>
                <CardDescription>
                  Ex. Bières blondes, Sucreries, Eaux minérales, Vins &amp; Spiritueux.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {canWrite && (
                  <form
                    onSubmit={catForm.handleSubmit(onCreateCategory)}
                    className="flex flex-col gap-2 sm:flex-row"
                  >
                    <Input
                      placeholder="Nouvelle catégorie..."
                      {...catForm.register('name')}
                    />
                    <Button
                      type="submit"
                      variant="accent"
                      disabled={createCategoryMutation.isPending}
                    >
                      Ajouter
                    </Button>
                  </form>
                )}

                {categories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune catégorie enregistrée.</p>
                ) : (
                  <div className="divide-y divide-border rounded-md border border-border">
                    {categories.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between px-3.5 py-2.5 text-sm"
                      >
                        <span className="font-medium text-foreground">{c.name}</span>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {c.productCount} produit{c.productCount > 1 ? 's' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  Marques ({brands.length})
                </CardTitle>
                <CardDescription>
                  Ex. Solibra, Brassivoire, Castel, Coca-Cola, Céleste.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {canWrite && (
                  <form
                    onSubmit={brandForm.handleSubmit(onCreateBrand)}
                    className="flex flex-col gap-2 sm:flex-row"
                  >
                    <Input placeholder="Nouvelle marque..." {...brandForm.register('name')} />
                    <Button
                      type="submit"
                      variant="accent"
                      disabled={createBrandMutation.isPending}
                    >
                      Ajouter
                    </Button>
                  </form>
                )}

                {brands.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune marque enregistrée.</p>
                ) : (
                  <div className="divide-y divide-border rounded-md border border-border">
                    {brands.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between px-3.5 py-2.5 text-sm"
                      >
                        <span className="font-medium text-foreground">{b.name}</span>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {b.productCount} produit{b.productCount > 1 ? 's' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Onglet 3 : Emballages Consignés */}
        <TabsContent value="packaging" className="space-y-6">
          {canWrite && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Box className="h-4 w-4 text-muted-foreground" />
                  Ajouter un type d&apos;emballage consigné
                </CardTitle>
                <CardDescription>
                  Sépare la valeur de la consigne du prix de la boisson pleine.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={pkgForm.handleSubmit(onCreatePackaging)}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end"
                >
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="pkg-code">Code *</Label>
                    <Input
                      id="pkg-code"
                      placeholder="CASIER-24"
                      className="font-mono uppercase"
                      {...pkgForm.register('code')}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-4">
                    <Label htmlFor="pkg-name">Désignation *</Label>
                    <Input
                      id="pkg-name"
                      placeholder="Ex. Casier 24 trous plastique"
                      {...pkgForm.register('name')}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-3">
                    <Label>Type d&apos;emballage</Label>
                    <Select
                      value={pkgForm.watch('kind')}
                      onValueChange={(v: 'BOTTLE' | 'CRATE' | 'OTHER') =>
                        pkgForm.setValue('kind', v)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CRATE">Casier vide</SelectItem>
                        <SelectItem value="BOTTLE">Bouteille vide</SelectItem>
                        <SelectItem value="OTHER">Autre emballage</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="pkg-deposit">Consigne (FCFA)</Label>
                    <Input
                      id="pkg-deposit"
                      type="number"
                      min={0}
                      className="font-mono tabular-nums"
                      {...pkgForm.register('depositAmountXof')}
                    />
                  </div>
                  <div className="sm:col-span-1">
                    <Button
                      type="submit"
                      variant="accent"
                      className="w-full"
                      disabled={createPackagingMutation.isPending}
                    >
                      Créer
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-0">
              {packagingTypes.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  Aucun emballage consigné configuré.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Désignation</TableHead>
                      <TableHead>Catégorie</TableHead>
                      <TableHead className="text-right">Valeur consigne</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {packagingTypes.map((pkg) => (
                      <TableRow key={pkg.id}>
                        <TableCell className="font-mono text-xs font-medium">{pkg.code}</TableCell>
                        <TableCell>{pkg.name}</TableCell>
                        <TableCell className="text-muted-foreground">{kindLabel(pkg.kind)}</TableCell>
                        <TableCell className="text-right font-mono font-medium tabular-nums">
                          {formatFCFA(pkg.depositAmountXof)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ProductFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingProduct={editingProduct}
        categories={categories}
        brands={brands}
        units={units}
        packagingTypes={packagingTypes}
      />
    </div>
  );
}
