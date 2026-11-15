import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  AlertTriangle,
  ArrowDownUp,
  ClipboardCheck,
  History,
  PackageCheck,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { AccessDeniedCard } from '@/src/components/AccessDeniedCard';
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
import { formatDateTimeFr, formatFCFA } from '@/src/lib/money';
import { useProducts } from '@/src/modules/catalog/services/catalogService';
import type { AuthenticatedUser } from '@/src/types/auth';
import type { Product } from '@/src/types/catalog';
import {
  stockMovementFormSchema,
  type StockMovementFormValues,
} from '../schemas/stock.schema';
import {
  useRecordStockMovement,
  useStockBalances,
  useStockInventories,
  useStockMovements,
  useValidateStockInventory,
} from '../services/stockService';

const ALL_FILTER = '__ALL__';

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  INITIAL: 'Stock initial',
  MANUAL_IN: 'Entrée manuelle',
  MANUAL_OUT: 'Sortie manuelle',
  BREAKAGE: 'Casse marchandise',
  LOSS: 'Perte / Manquant',
  INVENTORY_ADJUSTMENT: 'Ajustement inventaire',
  PURCHASE_RECEIPT: 'Réception achat',
  SALE: 'Vente POS',
  SALE_RETURN: 'Retour client',
};

function formatStockBreakdown(quantityBase: number, product?: Product): string | null {
  if (!product) return null;
  const crateUnit = product.units
    .filter((u) => u.conversionToBase > 1)
    .sort((a, b) => b.conversionToBase - a.conversionToBase)[0];
  if (!crateUnit || crateUnit.conversionToBase <= 1) return null;

  const absQty = Math.abs(quantityBase);
  const packs = Math.floor(absQty / crateUnit.conversionToBase);
  const rem = absQty % crateUnit.conversionToBase;
  const sign = quantityBase < 0 ? '-' : '';
  if (packs === 0) return null;
  return rem > 0
    ? `${sign}${packs} ${crateUnit.unitName} + ${rem} ${product.baseUnitName}`
    : `${sign}${packs} ${crateUnit.unitName}`;
}

interface StockManagementViewProps {
  currentUser: AuthenticatedUser;
}

export function StockManagementView({ currentUser }: StockManagementViewProps) {
  const canAdjust = currentUser.permissions.includes('stock.adjust');

  const [activeTab, setActiveTab] = useState<'balances' | 'movement' | 'inventories' | 'ledger'>(
    'balances'
  );
  const [search, setSearch] = useState('');
  const [onlyLowStock, setOnlyLowStock] = useState(false);

  const [ledgerProductFilter, setLedgerProductFilter] = useState('');
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState('');

  const [inventoryNote, setInventoryNote] = useState('');
  const [countedMap, setCountedMap] = useState<Record<string, string>>({});

  const { data: balances = [], isLoading: loadingBalances } = useStockBalances({
    search,
    onlyLowStock,
  });
  const { data: allBalances = [] } = useStockBalances();
  const { data: products = [] } = useProducts();
  const { data: movements = [], isLoading: loadingMovements } = useStockMovements({
    productId: ledgerProductFilter || undefined,
    movementType: ledgerTypeFilter || undefined,
    limit: 150,
  });
  const { data: inventories = [] } = useStockInventories();

  const recordMovementMutation = useRecordStockMovement();
  const validateInventoryMutation = useValidateStockInventory();

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const movementForm = useForm<StockMovementFormValues>({
    resolver: zodResolver(stockMovementFormSchema) as never,
    defaultValues: {
      productId: '',
      unitId: '',
      movementType: 'MANUAL_IN',
      quantity: 1,
      unitCostXof: 0,
      note: '',
    },
  });

  const selectedProductId = movementForm.watch('productId');
  const selectedUnitId = movementForm.watch('unitId');
  const selectedMovementType = movementForm.watch('movementType');
  const enteredQuantity = Number(movementForm.watch('quantity') || 0);

  const selectedProduct = productById.get(selectedProductId);
  const selectedUnit =
    selectedProduct?.units.find((u) => u.unitId === selectedUnitId) ?? selectedProduct?.units[0];

  const isIncomingMovement =
    selectedMovementType === 'INITIAL' || selectedMovementType === 'MANUAL_IN';

  useEffect(() => {
    if (!selectedProductId && products.length > 0) {
      const first = products[0];
      const defaultUnit = first.units.find((u) => u.isDefaultSaleUnit) ?? first.units[0];
      movementForm.setValue('productId', first.id);
      if (defaultUnit) {
        movementForm.setValue('unitId', defaultUnit.unitId);
        movementForm.setValue(
          'unitCostXof',
          (first.weightedAvgCostXof || first.purchasePriceXof) * defaultUnit.conversionToBase
        );
      }
    }
  }, [products, selectedProductId, movementForm]);

  const handleSelectProductInForm = (newProductId: string) => {
    movementForm.setValue('productId', newProductId);
    const prod = productById.get(newProductId);
    if (prod) {
      const defaultUnit = prod.units.find((u) => u.isDefaultSaleUnit) ?? prod.units[0];
      if (defaultUnit) {
        movementForm.setValue('unitId', defaultUnit.unitId);
        movementForm.setValue(
          'unitCostXof',
          (prod.weightedAvgCostXof || prod.purchasePriceXof) * defaultUnit.conversionToBase
        );
      }
    }
  };

  const handleSelectUnitInForm = (newUnitId: string) => {
    movementForm.setValue('unitId', newUnitId);
    if (selectedProduct) {
      const unitObj = selectedProduct.units.find((u) => u.unitId === newUnitId);
      if (unitObj) {
        movementForm.setValue(
          'unitCostXof',
          (selectedProduct.weightedAvgCostXof || selectedProduct.purchasePriceXof) *
            unitObj.conversionToBase
        );
      }
    }
  };

  const handleQuickMovement = (productId: string) => {
    handleSelectProductInForm(productId);
    setActiveTab('movement');
  };

  const onSubmitMovement = async (values: StockMovementFormValues) => {
    try {
      const payload: StockMovementFormValues = {
        ...values,
        unitCostXof:
          values.movementType === 'INITIAL' || values.movementType === 'MANUAL_IN'
            ? values.unitCostXof
            : undefined,
      };
      await recordMovementMutation.mutateAsync(payload);
      toast.success('Mouvement de stock enregistré dans le journal.');
      movementForm.setValue('quantity', 1);
      movementForm.setValue('note', '');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec enregistrement mouvement');
    }
  };

  const handleResetInventoryCounts = () => {
    const next: Record<string, string> = {};
    for (const b of allBalances) {
      next[b.productId] = String(b.quantityBase);
    }
    setCountedMap(next);
  };

  const handleValidateInventory = async () => {
    if (allBalances.length === 0) {
      toast.error('Aucun produit actif à inventorier.');
      return;
    }

    const lines = allBalances.map((b) => {
      const raw = countedMap[b.productId];
      const parsed = raw !== undefined && raw !== '' ? Number.parseInt(raw, 10) : b.quantityBase;
      return {
        productId: b.productId,
        countedBase: Number.isNaN(parsed) || parsed < 0 ? 0 : parsed,
      };
    });

    try {
      const inv = await validateInventoryMutation.mutateAsync({
        note: inventoryNote.trim() || undefined,
        lines,
      });
      toast.success(`Inventaire ${inv.inventoryNumber} validé (${inv.linesCount} articles).`);
      setInventoryNote('');
      setCountedMap({});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de validation d'inventaire");
    }
  };

  // KPIs calculés sur l'ensemble du stock actif (hors filtre)
  const totalValuationXof = allBalances.reduce((acc, b) => acc + b.totalValuationXof, 0);
  const lowStockCount = allBalances.filter((b) => b.isLowStock).length;
  const totalDamagedUnits = allBalances.reduce((acc, b) => acc + b.damagedQuantityBase, 0);
  const convertedPreviewBase =
    selectedUnit && Number.isFinite(enteredQuantity) && enteredQuantity > 0
      ? enteredQuantity * selectedUnit.conversionToBase
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Gestion des Stocks &amp; Mouvements
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Soldes en unité de base, valorisation CUMP entière (FCFA), casse, inventaires et journal immuable.
          </p>
        </div>
        {canAdjust && (
          <Button variant="accent" onClick={() => setActiveTab('movement')}>
            <ArrowDownUp className="h-4 w-4" />
            Saisir un mouvement
          </Button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Valorisation totale (CUMP)</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {formatFCFA(totalValuationXof)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Calcul entier sur {allBalances.length} référence{allBalances.length > 1 ? 's' : ''} active
            {allBalances.length > 1 ? 's' : ''}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Alertes stock bas</CardDescription>
            <CardTitle
              className={
                lowStockCount > 0
                  ? 'font-mono text-2xl tabular-nums text-amber-600 dark:text-amber-400'
                  : 'font-mono text-2xl tabular-nums'
              }
            >
              {lowStockCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Articles sous ou égaux au seuil d&apos;alerte
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Unités cassées</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">{totalDamagedUnits}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Stock non revendable isolé en casse
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Mouvements journalisés</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">{movements.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Écritures immuables sur la base locale
          </CardContent>
        </Card>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'balances' | 'movement' | 'inventories' | 'ledger')}
      >
        <TabsList>
          <TabsTrigger value="balances">État du stock ({balances.length})</TabsTrigger>
          <TabsTrigger value="movement">Mouvement de stock</TabsTrigger>
          <TabsTrigger value="inventories">Inventaires ({inventories.length})</TabsTrigger>
          <TabsTrigger value="ledger">Journal des mouvements</TabsTrigger>
        </TabsList>

        {/* Onglet 1 : État du stock */}
        <TabsContent value="balances" className="space-y-4">
          <Card>
            <CardContent className="pt-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative flex-1 sm:max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Rechercher par produit, SKU ou code-barres..."
                    className="pl-9"
                  />
                </div>
                <Button
                  type="button"
                  variant={onlyLowStock ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => setOnlyLowStock((v) => !v)}
                >
                  <AlertTriangle className="h-4 w-4" />
                  {onlyLowStock ? 'Afficher tout le stock' : 'Alertes stock bas uniquement'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {loadingBalances ? (
                <div className="p-6">
                  <Skeleton className="h-44 w-full" />
                </div>
              ) : balances.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
                  <PackageCheck className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">
                    Aucun article correspondant à afficher
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Créez d&apos;abord des produits dans le catalogue puis saisissez un stock initial.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produit</TableHead>
                      <TableHead className="text-right">Stock vendable</TableHead>
                      <TableHead className="text-right">Casse</TableHead>
                      <TableHead className="text-right">Seuil</TableHead>
                      <TableHead className="text-right">CUMP</TableHead>
                      <TableHead className="text-right">Valorisation</TableHead>
                      <TableHead>État</TableHead>
                      {canAdjust && <TableHead className="text-right">Action</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {balances.map((item) => {
                      const breakdown = formatStockBreakdown(
                        item.quantityBase,
                        productById.get(item.productId)
                      );
                      return (
                        <TableRow key={item.productId}>
                          <TableCell>
                            <div className="font-medium text-foreground">{item.name}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              <span className="font-mono">{item.sku}</span>
                              {item.categoryName ? ` · ${item.categoryName}` : ''}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="font-mono text-sm font-semibold tabular-nums">
                              {item.quantityBase} {item.baseUnitName}
                            </div>
                            {breakdown && (
                              <div className="font-mono text-xs tabular-nums text-muted-foreground">
                                {breakdown}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                            {item.damagedQuantityBase} {item.baseUnitName}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                            {item.alertThresholdBase}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatFCFA(item.weightedAvgCostXof)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs font-medium tabular-nums">
                            {formatFCFA(item.totalValuationXof)}
                          </TableCell>
                          <TableCell>
                            {item.isLowStock ? (
                              <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                                Stock bas
                              </span>
                            ) : (
                              <span className="text-xs text-emerald-700 dark:text-emerald-400">
                                Normal
                              </span>
                            )}
                          </TableCell>
                          {canAdjust && (
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleQuickMovement(item.productId)}
                              >
                                Mouvement
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Onglet 2 : Saisie d'un mouvement */}
        <TabsContent value="movement">
          {!canAdjust ? (
            <AccessDeniedCard
              requiredPermission="stock.adjust"
              userRoleName={currentUser.roleName}
            />
          ) : (
            <Card className="max-w-3xl">
              <CardHeader>
                <CardTitle>Enregistrer un mouvement de stock</CardTitle>
                <CardDescription>
                  Toute quantité saisie dans un conditionnement (casier, pack) est convertie automatiquement vers l&apos;unité de base dans SQLite.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {products.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Aucun produit actif disponible dans le catalogue.
                  </p>
                ) : (
                  <form
                    onSubmit={movementForm.handleSubmit(onSubmitMovement)}
                    className="space-y-4"
                  >
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>Produit *</Label>
                        <Controller
                          name="productId"
                          control={movementForm.control}
                          render={({ field }) => (
                            <Select
                              value={field.value}
                              onValueChange={handleSelectProductInForm}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Choisir un produit" />
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
                        {movementForm.formState.errors.productId && (
                          <p className="text-xs text-destructive">
                            {movementForm.formState.errors.productId.message}
                          </p>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <Label>Type de mouvement *</Label>
                        <Controller
                          name="movementType"
                          control={movementForm.control}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={field.onChange}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="INITIAL">Stock initial (Entrée)</SelectItem>
                                <SelectItem value="MANUAL_IN">Entrée manuelle (+)</SelectItem>
                                <SelectItem value="MANUAL_OUT">Sortie manuelle (−)</SelectItem>
                                <SelectItem value="BREAKAGE">
                                  Casse (retire du vendable)
                                </SelectItem>
                                <SelectItem value="LOSS">Perte / Manquant (−)</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label>Unité / Conditionnement *</Label>
                        <Controller
                          name="unitId"
                          control={movementForm.control}
                          render={({ field }) => (
                            <Select
                              value={field.value}
                              onValueChange={handleSelectUnitInForm}
                              disabled={!selectedProduct}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Choisir une unité" />
                              </SelectTrigger>
                              <SelectContent>
                                {(selectedProduct?.units ?? []).map((u) => (
                                  <SelectItem key={u.unitId} value={u.unitId}>
                                    {u.unitName} (×{u.conversionToBase}{' '}
                                    {selectedProduct?.baseUnitName})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="mv-qty">Quantité *</Label>
                        <Input
                          id="mv-qty"
                          type="number"
                          min={1}
                          className="font-mono tabular-nums"
                          {...movementForm.register('quantity')}
                        />
                        {selectedProduct && selectedUnit && convertedPreviewBase > 0 && (
                          <p className="font-mono text-xs tabular-nums text-muted-foreground">
                            Équivalent base : {convertedPreviewBase}{' '}
                            {selectedProduct.baseUnitName} (stock actuel :{' '}
                            {selectedProduct.stockQuantityBase})
                          </p>
                        )}
                      </div>

                      {isIncomingMovement && (
                        <div className="space-y-1.5">
                          <Label htmlFor="mv-cost">
                            Coût unitaire par {selectedUnit?.unitName ?? 'unité'} (FCFA)
                          </Label>
                          <Input
                            id="mv-cost"
                            type="number"
                            min={0}
                            className="font-mono tabular-nums"
                            {...movementForm.register('unitCostXof')}
                          />
                          <p className="text-xs text-muted-foreground">
                            Recalcule le CUMP entier de l&apos;article en base.
                          </p>
                        </div>
                      )}

                      <div className={isIncomingMovement ? 'space-y-1.5' : 'space-y-1.5 sm:col-span-2'}>
                        <Label htmlFor="mv-note">Motif / Observation</Label>
                        <Input
                          id="mv-note"
                          placeholder="Ex. Inventaire d'ouverture, casse lors de manutention..."
                          {...movementForm.register('note')}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-3 pt-2">
                      <Button
                        type="submit"
                        variant="accent"
                        disabled={recordMovementMutation.isPending}
                      >
                        {recordMovementMutation.isPending
                          ? 'Enregistrement...'
                          : 'Valider le mouvement'}
                      </Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Onglet 3 : Inventaires physiques */}
        <TabsContent value="inventories" className="space-y-6">
          {canAdjust ? (
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
                      Nouveau comptage d&apos;inventaire physique
                    </CardTitle>
                    <CardDescription>
                      Saisissez les quantités réelles en unité de base. La validation génère automatiquement les écritures INVENTORY_ADJUSTMENT pour tout écart constaté.
                    </CardDescription>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={handleResetInventoryCounts}>
                    Pré-remplir avec stock théorique
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {allBalances.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Aucun article actif à inventorier.
                  </p>
                ) : (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Article</TableHead>
                          <TableHead className="text-right">Théorique (base)</TableHead>
                          <TableHead className="w-40 text-right">Compté réel</TableHead>
                          <TableHead className="text-right">Écart</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {allBalances.map((b) => {
                          const rawVal = countedMap[b.productId];
                          const counted =
                            rawVal !== undefined && rawVal !== ''
                              ? Number.parseInt(rawVal, 10)
                              : b.quantityBase;
                          const safeCounted = Number.isNaN(counted) ? b.quantityBase : counted;
                          const variance = safeCounted - b.quantityBase;

                          return (
                            <TableRow key={b.productId}>
                              <TableCell>
                                <div className="font-medium text-foreground">{b.name}</div>
                                <div className="font-mono text-xs text-muted-foreground">
                                  {b.sku} · {b.baseUnitName}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs tabular-nums">
                                {b.quantityBase}
                              </TableCell>
                              <TableCell className="text-right">
                                <Input
                                  type="number"
                                  min={0}
                                  value={
                                    rawVal !== undefined ? rawVal : String(b.quantityBase)
                                  }
                                  onChange={(e) =>
                                    setCountedMap((prev) => ({
                                      ...prev,
                                      [b.productId]: e.target.value,
                                    }))
                                  }
                                  className="h-8 text-right font-mono text-xs tabular-nums"
                                />
                              </TableCell>
                              <TableCell
                                className={
                                  variance === 0
                                    ? 'text-right font-mono text-xs tabular-nums text-muted-foreground'
                                    : variance > 0
                                      ? 'text-right font-mono text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-400'
                                      : 'text-right font-mono text-xs font-semibold tabular-nums text-destructive'
                                }
                              >
                                {variance > 0 ? `+${variance}` : variance}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div className="flex-1 space-y-1.5 sm:max-w-md">
                        <Label htmlFor="inv-note">Note d&apos;inventaire</Label>
                        <Input
                          id="inv-note"
                          value={inventoryNote}
                          onChange={(e) => setInventoryNote(e.target.value)}
                          placeholder="Ex. Inventaire mensuel de fin de période"
                        />
                      </div>
                      <Button
                        variant="accent"
                        onClick={() => void handleValidateInventory()}
                        disabled={validateInventoryMutation.isPending}
                      >
                        {validateInventoryMutation.isPending
                          ? 'Validation...'
                          : "Valider l'inventaire physique"}
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <AccessDeniedCard
              requiredPermission="stock.adjust"
              userRoleName={currentUser.roleName}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Historique des inventaires validés</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {inventories.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  Aucun inventaire enregistré pour le moment.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Référence</TableHead>
                      <TableHead>Validé le</TableHead>
                      <TableHead>Opérateur</TableHead>
                      <TableHead className="text-right">Lignes</TableHead>
                      <TableHead className="text-right">Écart net (base)</TableHead>
                      <TableHead>Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inventories.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-mono text-xs font-medium">
                          {inv.inventoryNumber}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatDateTimeFr(inv.validatedAt ?? inv.createdAt)}
                        </TableCell>
                        <TableCell className="text-sm">{inv.validatedByName ?? inv.createdByName}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {inv.linesCount}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium tabular-nums">
                          {inv.totalVarianceBase > 0
                            ? `+${inv.totalVarianceBase}`
                            : inv.totalVarianceBase}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {inv.note ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Onglet 4 : Journal immuable */}
        <TabsContent value="ledger" className="space-y-4">
          <Card>
            <CardContent className="pt-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Select
                  value={ledgerProductFilter || ALL_FILTER}
                  onValueChange={(v) => setLedgerProductFilter(v === ALL_FILTER ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Tous les produits" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER}>Tous les produits</SelectItem>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.sku})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={ledgerTypeFilter || ALL_FILTER}
                  onValueChange={(v) => setLedgerTypeFilter(v === ALL_FILTER ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Tous types de mouvements" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER}>Tous types de mouvements</SelectItem>
                    <SelectItem value="INITIAL">Stock initial</SelectItem>
                    <SelectItem value="MANUAL_IN">Entrée manuelle</SelectItem>
                    <SelectItem value="MANUAL_OUT">Sortie manuelle</SelectItem>
                    <SelectItem value="BREAKAGE">Casse</SelectItem>
                    <SelectItem value="LOSS">Perte</SelectItem>
                    <SelectItem value="INVENTORY_ADJUSTMENT">Ajustement inventaire</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {loadingMovements ? (
                <div className="p-6">
                  <Skeleton className="h-44 w-full" />
                </div>
              ) : movements.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
                  <History className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">
                    Aucun mouvement dans le journal
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Horodatage</TableHead>
                      <TableHead>Produit</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Variation</TableHead>
                      <TableHead className="text-right">Coût unit.</TableHead>
                      <TableHead className="text-right">Solde après</TableHead>
                      <TableHead>Opérateur</TableHead>
                      <TableHead>Motif</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movements.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                          {formatDateTimeFr(m.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-foreground">{m.productName}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {m.productSku}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {MOVEMENT_TYPE_LABELS[m.movementType] ?? m.movementType}
                        </TableCell>
                        <TableCell
                          className={
                            m.quantityDeltaBase >= 0
                              ? 'text-right font-mono text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-400'
                              : 'text-right font-mono text-xs font-semibold tabular-nums text-destructive'
                          }
                        >
                          {m.quantityDeltaBase > 0
                            ? `+${m.quantityDeltaBase}`
                            : m.quantityDeltaBase}{' '}
                          {m.baseUnitName}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatFCFA(m.unitCostXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {m.balanceAfterBase} {m.baseUnitName}
                        </TableCell>
                        <TableCell className="text-xs">{m.userName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {m.note ?? '—'}
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
    </div>
  );
}
