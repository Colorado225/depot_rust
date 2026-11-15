import { useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  Minus,
  Plus,
  Receipt,
  Search,
  ShoppingBag,
  Trash2,
  UserPlus,
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
import { formatDateTimeFr, formatFCFA } from '@/src/lib/money';
import { useCategories, useProducts } from '@/src/modules/catalog/services/catalogService';
import { CustomerFormDialog } from '@/src/modules/customers/components/CustomerFormDialog';
import {
  PAYMENT_METHOD_LABELS,
  useCustomers,
} from '@/src/modules/customers/services/customerService';
import type { AuthenticatedUser } from '@/src/types/auth';
import type { Product, ProductUnit } from '@/src/types/catalog';
import type { Customer, CustomerPaymentMethod } from '@/src/types/customer';
import type { PriceTier, Sale } from '@/src/types/pos';
import { useCreateSale, useSalesHistory } from '../services/posService';
import { CancelSaleDialog } from './CancelSaleDialog';
import { SaleTicketDialog } from './SaleTicketDialog';

const WALKIN_CUSTOMER_VALUE = '__COMPTOIR__';

interface CartLine {
  key: string;
  product: Product;
  unitId: string;
  quantity: number;
  applyConsignment: boolean;
}

interface PaymentDraftLine {
  id: string;
  paymentMethod: CustomerPaymentMethod;
  amountXof: number;
  externalReference: string;
}

interface PosViewProps {
  currentUser: AuthenticatedUser;
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pos-${crypto.randomUUID()}`;
  }
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function PosView({ currentUser }: PosViewProps) {
  const canSell = currentUser.permissions.includes('pos.sale.create');
  const canApplyDiscount = currentUser.permissions.includes('pos.discount.apply');
  const canCancelSale = currentUser.permissions.includes('pos.sale.cancel');

  const [workspaceTab, setWorkspaceTab] = useState<'terminal' | 'history'>('terminal');

  // Terminal POS state
  const [search, setSearch] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [priceTier, setPriceTier] = useState<PriceTier>('WHOLESALE');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(WALKIN_CUSTOMER_VALUE);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountXof, setDiscountXof] = useState<number>(0);
  const [saleNote, setSaleNote] = useState('');
  const [paymentMode, setPaymentMode] = useState<'FULL' | 'MIXED' | 'CREDIT'>('FULL');
  const [paymentLines, setPaymentLines] = useState<PaymentDraftLine[]>([
    { id: 'pay-1', paymentMethod: 'CASH', amountXof: 0, externalReference: '' },
  ]);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(createIdempotencyKey);

  // Modals
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [ticketSale, setTicketSale] = useState<Sale | null>(null);
  const [cancellingSale, setCancellingSale] = useState<Sale | null>(null);

  // History filters
  const [historySearch, setHistorySearch] = useState('');
  const [historyStatus, setHistoryStatus] = useState<'ALL' | 'VALIDATED' | 'CANCELLED'>('ALL');

  const { data: categories = [] } = useCategories();
  const { data: products = [], isLoading: loadingProducts } = useProducts({
    includeInactive: false,
  });
  const { data: customers = [] } = useCustomers();
  const { data: salesHistory = [], isLoading: loadingHistory } = useSalesHistory({
    search: historySearch,
    status: historyStatus === 'ALL' ? undefined : historyStatus,
    limit: 100,
  });

  const createSaleMutation = useCreateSale();

  const selectedCustomer: Customer | null = useMemo(
    () =>
      selectedCustomerId === WALKIN_CUSTOMER_VALUE
        ? null
        : (customers.find((c) => c.id === selectedCustomerId) ?? null),
    [customers, selectedCustomerId]
  );

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (selectedCategoryId !== 'ALL' && p.categoryId !== selectedCategoryId) return false;
      if (!q) return true;
      const unitBarcodeMatch = p.units.some((u) => u.barcode?.toLowerCase().includes(q));
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode?.toLowerCase().includes(q) ?? false) ||
        unitBarcodeMatch
      );
    });
  }, [products, search, selectedCategoryId]);

  const getProductUnit = (product: Product, unitId: string): ProductUnit | undefined =>
    product.units.find((u) => u.unitId === unitId) ??
    product.units.find((u) => u.isDefaultSaleUnit) ??
    product.units[0];

  const getLineUnitPrice = (unit: ProductUnit | undefined, product: Product): number => {
    if (!unit) {
      return priceTier === 'WHOLESALE' ? product.wholesalePriceXof : product.retailPriceXof;
    }
    return priceTier === 'WHOLESALE' ? unit.wholesalePriceXof : unit.retailPriceXof;
  };

  const addProductToCart = (product: Product, forcedUnitId?: string) => {
    const targetUnit =
      (forcedUnitId ? product.units.find((u) => u.unitId === forcedUnitId) : undefined) ??
      product.units.find((u) => u.isDefaultSaleUnit) ??
      product.units[0];

    if (!targetUnit) {
      toast.error(`Aucun conditionnement configuré pour ${product.name}.`);
      return;
    }

    const lineKey = `${product.id}::${targetUnit.unitId}`;
    setCart((prev) => {
      const existing = prev.find((l) => l.key === lineKey);
      if (existing) {
        return prev.map((l) => (l.key === lineKey ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...prev,
        {
          key: lineKey,
          product,
          unitId: targetUnit.unitId,
          quantity: 1,
          applyConsignment: false,
        },
      ];
    });
  };

  const handleScanEnter = () => {
    const q = search.trim().toLowerCase();
    if (!q) return;
    // Priorité au match exact code-barres conditionnement / produit / SKU
    for (const p of products) {
      const unitMatch = p.units.find((u) => u.barcode?.toLowerCase() === q);
      if (unitMatch) {
        addProductToCart(p, unitMatch.unitId);
        setSearch('');
        return;
      }
      if (p.barcode?.toLowerCase() === q || p.sku.toLowerCase() === q) {
        addProductToCart(p);
        setSearch('');
        return;
      }
    }
    if (filteredProducts.length === 1) {
      addProductToCart(filteredProducts[0]);
      setSearch('');
    }
  };

  const updateCartLineUnit = (oldKey: string, nextUnitId: string) => {
    setCart((prev) => {
      const line = prev.find((l) => l.key === oldKey);
      if (!line) return prev;
      const newKey = `${line.product.id}::${nextUnitId}`;
      const existingTarget = prev.find((l) => l.key === newKey && l.key !== oldKey);
      if (existingTarget) {
        return prev
          .filter((l) => l.key !== oldKey)
          .map((l) => (l.key === newKey ? { ...l, quantity: l.quantity + line.quantity } : l));
      }
      return prev.map((l) => (l.key === oldKey ? { ...l, key: newKey, unitId: nextUnitId } : l));
    });
  };

  const computeLineConsignmentXof = (line: CartLine): number => {
    if (!line.applyConsignment) return 0;
    const unit = getProductUnit(line.product, line.unitId);
    const conv = unit?.conversionToBase ?? 1;
    const baseQty = line.quantity * conv;
    let total = 0;
    if (line.product.bottlePackagingTypeId && line.product.bottleDepositXof > 0) {
      total += line.product.bottleDepositXof * baseQty;
    }
    if (
      line.product.cratePackagingTypeId &&
      line.product.crateDepositXof > 0 &&
      unit?.unitCode === 'CASIER'
    ) {
      total += line.product.crateDepositXof * line.quantity;
    }
    return total;
  };

  const totals = useMemo(() => {
    let subtotalXof = 0;
    let consignmentTotalXof = 0;
    for (const line of cart) {
      const unit = getProductUnit(line.product, line.unitId);
      subtotalXof += getLineUnitPrice(unit, line.product) * line.quantity;
      consignmentTotalXof += computeLineConsignmentXof(line);
    }
    const cleanDiscount = Math.max(0, Math.min(subtotalXof, discountXof || 0));
    const totalPayableXof = subtotalXof - cleanDiscount + consignmentTotalXof;
    return { subtotalXof, consignmentTotalXof, cleanDiscount, totalPayableXof };
  }, [cart, discountXof, priceTier]);

  const effectivePayments = useMemo(() => {
    if (paymentMode === 'FULL') {
      const method = paymentLines[0]?.paymentMethod ?? 'CASH';
      const ref = paymentLines[0]?.externalReference ?? '';
      return totals.totalPayableXof > 0
        ? [{ paymentMethod: method, amountXof: totals.totalPayableXof, externalReference: ref }]
        : [];
    }
    if (paymentMode === 'CREDIT') {
      return [];
    }
    return paymentLines.filter((p) => p.amountXof > 0);
  }, [paymentMode, paymentLines, totals.totalPayableXof]);

  const totalPaidDraftXof = effectivePayments.reduce((sum, p) => sum + p.amountXof, 0);
  const creditDueDraftXof = Math.max(0, totals.totalPayableXof - totalPaidDraftXof);

  const resetCart = () => {
    setCart([]);
    setDiscountXof(0);
    setSaleNote('');
    setPaymentMode('FULL');
    setPaymentLines([{ id: 'pay-1', paymentMethod: 'CASH', amountXof: 0, externalReference: '' }]);
    setIdempotencyKey(createIdempotencyKey());
  };

  const handleValidateSale = async () => {
    if (cart.length === 0) {
      toast.error('Ajoutez au moins un produit dans le panier.');
      return;
    }
    if (creditDueDraftXof > 0 && !selectedCustomer) {
      toast.error('Sélectionnez un client enregistré pour valider une vente à crédit.');
      return;
    }

    try {
      const createdSale = await createSaleMutation.mutateAsync({
        idempotencyKey,
        customerId: selectedCustomer?.id ?? null,
        priceTier,
        discountXof: totals.cleanDiscount,
        note: saleNote.trim() || null,
        items: cart.map((line) => ({
          productId: line.product.id,
          unitId: line.unitId,
          quantity: line.quantity,
          applyConsignment: line.applyConsignment,
        })),
        payments: effectivePayments.map((p) => ({
          paymentMethod: p.paymentMethod,
          amountXof: p.amountXof,
          externalReference: p.externalReference?.trim() || null,
        })),
      });

      toast.success(`Vente ${createdSale.saleNumber} validée (${formatFCFA(createdSale.totalPayableXof)}).`);
      resetCart();
      setTicketSale(createdSale);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la validation de la vente');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Point de Vente (POS)
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Encaissement rapide multi-unités, tarifs gros/détail, Mobile Money, crédit client et tickets.
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 self-start">
          <button
            type="button"
            onClick={() => setWorkspaceTab('terminal')}
            className={`rounded-md px-3.5 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
              workspaceTab === 'terminal'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Caisse POS
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceTab('history')}
            className={`rounded-md px-3.5 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
              workspaceTab === 'history'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Historique des ventes ({salesHistory.length})
          </button>
        </div>
      </div>

      {workspaceTab === 'terminal' ? (
        <div className="grid gap-5 lg:grid-cols-12 lg:items-start">
          {/* Colonne gauche : Recherche, catégories, tarif & grille produits */}
          <div className="space-y-4 lg:col-span-7">
            <Card>
              <CardContent className="space-y-4 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleScanEnter();
                        }
                      }}
                      placeholder="Scanner code-barres ou saisir nom / SKU (+ Entrée)..."
                      className="pl-9"
                    />
                  </div>

                  <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setPriceTier('WHOLESALE')}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                        priceTier === 'WHOLESALE'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Tarif Gros
                    </button>
                    <button
                      type="button"
                      onClick={() => setPriceTier('RETAIL')}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                        priceTier === 'RETAIL'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Tarif Détail
                    </button>
                  </div>
                </div>

                {/* Filtre catégories */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  <button
                    type="button"
                    onClick={() => setSelectedCategoryId('ALL')}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                      selectedCategoryId === 'ALL'
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Toutes catégories
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setSelectedCategoryId(cat.id)}
                      className={`rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                        selectedCategoryId === cat.id
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {loadingProducts ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-28 w-full" />
              </div>
            ) : filteredProducts.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <ShoppingBag className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">Aucun article disponible</p>
                  <p className="text-xs text-muted-foreground">
                    Ajustez le filtre ou créez des boissons dans le module Catalogue.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filteredProducts.map((product) => {
                  const defaultUnit =
                    product.units.find((u) => u.isDefaultSaleUnit) ?? product.units[0];
                  const activePrice = getLineUnitPrice(defaultUnit, product);
                  const outOfStock = product.stockQuantityBase <= 0;

                  return (
                    <button
                      key={product.id}
                      type="button"
                      disabled={!canSell}
                      onClick={() => addProductToCart(product)}
                      className="flex flex-col justify-between rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:border-primary/50 hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                    >
                      <div className="space-y-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium text-sm text-foreground line-clamp-2">
                            {product.name}
                          </span>
                          <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                            {product.sku}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {product.formatLabel ?? product.categoryName ?? 'Boisson'} ·{' '}
                          {defaultUnit?.unitName ?? product.baseUnitName}
                        </p>
                      </div>

                      <div className="mt-3 flex items-end justify-between border-t border-border/60 pt-2.5">
                        <div>
                          <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
                            {formatFCFA(activePrice)}
                          </p>
                          <p
                            className={`font-mono text-[11px] tabular-nums ${
                              outOfStock
                                ? 'text-destructive'
                                : product.stockQuantityBase <= product.alertThresholdBase
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : 'text-muted-foreground'
                            }`}
                          >
                            Stock : {product.stockQuantityBase} {product.baseUnitName}
                          </p>
                        </div>
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-foreground">
                          <Plus className="h-4 w-4" />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Colonne droite : Panier, client & règlement multi-canaux */}
          <Card className="lg:col-span-5">
            <CardHeader className="border-b border-border pb-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Panier en cours</CardTitle>
                  <CardDescription>
                    Tarif appliqué : {priceTier === 'WHOLESALE' ? 'Gros' : 'Détail'}
                  </CardDescription>
                </div>
                {cart.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={resetCart}>
                    Vider
                  </Button>
                )}
              </div>

              {/* Sélection client */}
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Client</Label>
                  {canSell && (
                    <button
                      type="button"
                      onClick={() => setCustomerDialogOpen(true)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline cursor-pointer"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Nouveau client
                    </button>
                  )}
                </div>
                <Select value={selectedCustomerId} onValueChange={setSelectedCustomerId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={WALKIN_CUSTOMER_VALUE}>
                      Client comptoir (paiement comptant)
                    </SelectItem>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.fullName} ({formatFCFA(c.creditLimitXof)} plaf.)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedCustomer && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Créance actuelle :{' '}
                      <span className="font-mono tabular-nums text-foreground">
                        {formatFCFA(selectedCustomer.commercialDebtXof)}
                      </span>
                    </span>
                    <span>
                      Dispo crédit :{' '}
                      <span className="font-mono tabular-nums text-foreground">
                        {formatFCFA(
                          Math.max(
                            0,
                            selectedCustomer.creditLimitXof - selectedCustomer.commercialDebtXof
                          )
                        )}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-4 p-4">
              {cart.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    Sélectionnez un produit ou scannez un code-barres pour démarrer la vente.
                  </p>
                </div>
              ) : (
                <div className="max-h-72 space-y-2.5 overflow-y-auto pr-1">
                  {cart.map((line) => {
                    const unit = getProductUnit(line.product, line.unitId);
                    const unitPrice = getLineUnitPrice(unit, line.product);
                    const lineTotal = unitPrice * line.quantity;
                    const hasDeposit =
                      Boolean(line.product.bottlePackagingTypeId && line.product.bottleDepositXof > 0) ||
                      Boolean(line.product.cratePackagingTypeId && line.product.crateDepositXof > 0);
                    const lineDeposit = computeLineConsignmentXof(line);

                    return (
                      <div
                        key={line.key}
                        className="rounded-md border border-border bg-background p-3 space-y-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {line.product.name}
                            </p>
                            <p className="font-mono text-xs tabular-nums text-muted-foreground">
                              {formatFCFA(unitPrice)} / {unit?.unitName ?? line.product.baseUnitName}
                              {' · '}
                              {line.quantity * (unit?.conversionToBase ?? 1)}{' '}
                              {line.product.baseUnitName}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setCart((prev) => prev.filter((l) => l.key !== line.key))
                            }
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive cursor-pointer"
                            aria-label="Retirer la ligne"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Select
                            value={line.unitId}
                            onValueChange={(nextUnit) => updateCartLineUnit(line.key, nextUnit)}
                          >
                            <SelectTrigger className="h-8 w-36 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {line.product.units.map((u) => (
                                <SelectItem key={u.unitId} value={u.unitId}>
                                  {u.unitName} (×{u.conversionToBase})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 w-8 p-0"
                              onClick={() =>
                                setCart((prev) =>
                                  prev.map((l) =>
                                    l.key === line.key
                                      ? { ...l, quantity: Math.max(1, l.quantity - 1) }
                                      : l
                                  )
                                )
                              }
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </Button>
                            <Input
                              type="number"
                              min={1}
                              value={line.quantity}
                              onChange={(e) => {
                                const q = Math.max(1, Number.parseInt(e.target.value, 10) || 1);
                                setCart((prev) =>
                                  prev.map((l) => (l.key === line.key ? { ...l, quantity: q } : l))
                                );
                              }}
                              className="h-8 w-16 text-center font-mono text-xs tabular-nums"
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 w-8 p-0"
                              onClick={() =>
                                setCart((prev) =>
                                  prev.map((l) =>
                                    l.key === line.key ? { ...l, quantity: l.quantity + 1 } : l
                                  )
                                )
                              }
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          <span className="font-mono text-sm font-semibold tabular-nums">
                            {formatFCFA(lineTotal)}
                          </span>
                        </div>

                        {hasDeposit && (
                          <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground cursor-pointer">
                            <span className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={line.applyConsignment}
                                onChange={(e) =>
                                  setCart((prev) =>
                                    prev.map((l) =>
                                      l.key === line.key
                                        ? { ...l, applyConsignment: e.target.checked }
                                        : l
                                    )
                                  )
                                }
                              />
                              Facturer consigne emballages (à part)
                            </span>
                            {line.applyConsignment && (
                              <span className="font-mono tabular-nums text-foreground">
                                +{formatFCFA(lineDeposit)}
                              </span>
                            )}
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Remise & Totaux */}
              <div className="space-y-2 border-t border-border pt-3 text-sm">
                {canApplyDiscount && (
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="pos-discount" className="text-xs text-muted-foreground">
                      Remise autorisée (FCFA)
                    </Label>
                    <Input
                      id="pos-discount"
                      type="number"
                      min={0}
                      max={totals.subtotalXof}
                      value={discountXof}
                      onChange={(e) =>
                        setDiscountXof(Math.max(0, Number.parseInt(e.target.value, 10) || 0))
                      }
                      className="h-8 w-32 text-right font-mono text-xs tabular-nums"
                    />
                  </div>
                )}

                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Sous-total marchandises</span>
                  <span className="font-mono tabular-nums">{formatFCFA(totals.subtotalXof)}</span>
                </div>
                {totals.cleanDiscount > 0 && (
                  <div className="flex justify-between text-xs text-emerald-700 dark:text-emerald-400">
                    <span>Remise commerciale</span>
                    <span className="font-mono tabular-nums">
                      -{formatFCFA(totals.cleanDiscount)}
                    </span>
                  </div>
                )}
                {totals.consignmentTotalXof > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Consignes emballages (distinctes)</span>
                    <span className="font-mono tabular-nums">
                      +{formatFCFA(totals.consignmentTotalXof)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
                  <span>Net à payer</span>
                  <span className="font-mono tabular-nums">
                    {formatFCFA(totals.totalPayableXof)}
                  </span>
                </div>
              </div>

              {/* Encaissement multi-canaux / mixte / crédit */}
              <div className="space-y-3 border-t border-border pt-3">
                <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
                  <button
                    type="button"
                    onClick={() => setPaymentMode('FULL')}
                    className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                      paymentMode === 'FULL'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Comptant
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentMode('MIXED');
                      setPaymentLines([
                        {
                          id: 'pay-1',
                          paymentMethod: 'CASH',
                          amountXof: totals.totalPayableXof,
                          externalReference: '',
                        },
                      ]);
                    }}
                    className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                      paymentMode === 'MIXED'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Mixte / Partiel
                  </button>
                  <button
                    type="button"
                    disabled={!selectedCustomer}
                    onClick={() => setPaymentMode('CREDIT')}
                    className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium whitespace-nowrap disabled:opacity-50 cursor-pointer ${
                      paymentMode === 'CREDIT'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Crédit total
                  </button>
                </div>

                {paymentMode === 'FULL' && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      value={paymentLines[0]?.paymentMethod ?? 'CASH'}
                      onValueChange={(m) =>
                        setPaymentLines((prev) => [
                          {
                            ...(prev[0] ?? {
                              id: 'pay-1',
                              amountXof: totals.totalPayableXof,
                              externalReference: '',
                            }),
                            paymentMethod: m as CustomerPaymentMethod,
                          },
                        ])
                      }
                    >
                      <SelectTrigger className="h-9 text-xs">
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

                    <Input
                      placeholder="Réf. Mobile Money (optionnel)"
                      value={paymentLines[0]?.externalReference ?? ''}
                      onChange={(e) =>
                        setPaymentLines((prev) => [
                          {
                            ...(prev[0] ?? {
                              id: 'pay-1',
                              paymentMethod: 'CASH',
                              amountXof: totals.totalPayableXof,
                            }),
                            externalReference: e.target.value,
                          },
                        ])
                      }
                      className="h-9 text-xs"
                    />
                  </div>
                )}

                {paymentMode === 'MIXED' && (
                  <div className="space-y-2">
                    {paymentLines.map((line, index) => (
                      <div key={line.id} className="grid grid-cols-12 gap-1.5">
                        <div className="col-span-5">
                          <Select
                            value={line.paymentMethod}
                            onValueChange={(m) =>
                              setPaymentLines((prev) =>
                                prev.map((p) =>
                                  p.id === line.id
                                    ? { ...p, paymentMethod: m as CustomerPaymentMethod }
                                    : p
                                )
                              )
                            }
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(
                                Object.keys(PAYMENT_METHOD_LABELS) as CustomerPaymentMethod[]
                              ).map((method) => (
                                <SelectItem key={method} value={method}>
                                  {PAYMENT_METHOD_LABELS[method]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-3">
                          <Input
                            type="number"
                            min={0}
                            value={line.amountXof}
                            onChange={(e) => {
                              const v = Math.max(0, Number.parseInt(e.target.value, 10) || 0);
                              setPaymentLines((prev) =>
                                prev.map((p) => (p.id === line.id ? { ...p, amountXof: v } : p))
                              );
                            }}
                            className="h-8 text-right font-mono text-xs tabular-nums"
                          />
                        </div>
                        <div className="col-span-3">
                          <Input
                            placeholder="Réf."
                            value={line.externalReference}
                            onChange={(e) =>
                              setPaymentLines((prev) =>
                                prev.map((p) =>
                                  p.id === line.id ? { ...p, externalReference: e.target.value } : p
                                )
                              )
                            }
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="col-span-1 flex justify-end">
                          {index > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0"
                              onClick={() =>
                                setPaymentLines((prev) => prev.filter((p) => p.id !== line.id))
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setPaymentLines((prev) => [
                          ...prev,
                          {
                            id: `pay-${Date.now()}`,
                            paymentMethod: 'WAVE',
                            amountXof: Math.max(0, totals.totalPayableXof - totalPaidDraftXof),
                            externalReference: '',
                          },
                        ])
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Ajouter un canal
                    </Button>
                  </div>
                )}

                <div className="flex items-center justify-between rounded-md bg-secondary/60 px-3 py-2 text-xs">
                  <span>
                    Encaissé :{' '}
                    <strong className="font-mono tabular-nums">
                      {formatFCFA(totalPaidDraftXof)}
                    </strong>
                  </span>
                  <span>
                    Reste à crédit :{' '}
                    <strong
                      className={`font-mono tabular-nums ${
                        creditDueDraftXof > 0
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-foreground'
                      }`}
                    >
                      {formatFCFA(creditDueDraftXof)}
                    </strong>
                  </span>
                </div>

                <Input
                  value={saleNote}
                  onChange={(e) => setSaleNote(e.target.value)}
                  placeholder="Note ticket / livraison (optionnel)"
                  className="h-8 text-xs"
                />
              </div>

              <Button
                type="button"
                variant="accent"
                className="w-full"
                disabled={!canSell || cart.length === 0 || createSaleMutation.isPending}
                onClick={() => void handleValidateSale()}
              >
                <CheckCircle2 className="h-4 w-4" />
                {createSaleMutation.isPending
                  ? 'Validation transactionnelle...'
                  : `Valider la vente · ${formatFCFA(totals.totalPayableXof)}`}
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-sm">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Rechercher n° ticket, client, note..."
                  className="pl-9"
                />
              </div>

              <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 self-start">
                {(
                  [
                    ['ALL', 'Toutes'],
                    ['VALIDATED', 'Validées'],
                    ['CANCELLED', 'Annulées'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setHistoryStatus(key)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                      historyStatus === key
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {loadingHistory ? (
              <div className="space-y-2 p-6">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : salesHistory.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                Aucune vente enregistrée pour ce filtre.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ticket</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Tarif &amp; Caissier</TableHead>
                    <TableHead className="text-right">Net à payer</TableHead>
                    <TableHead className="text-right">Encaissé</TableHead>
                    <TableHead className="text-right">Crédit</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {salesHistory.map((sale) => (
                    <TableRow
                      key={sale.id}
                      className={sale.status === 'CANCELLED' ? 'opacity-65' : ''}
                    >
                      <TableCell className="font-mono text-xs font-semibold">
                        {sale.saleNumber}
                        {sale.status === 'CANCELLED' ? ' · Annulée' : ''}
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDateTimeFr(sale.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm">{sale.customerName}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {sale.priceTier === 'WHOLESALE' ? 'Gros' : 'Détail'} · {sale.userName}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                        {formatFCFA(sale.totalPayableXof)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {formatFCFA(sale.paidAmountXof)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono text-xs tabular-nums ${
                          sale.creditAmountXof > 0
                            ? 'font-semibold text-amber-700 dark:text-amber-400'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {formatFCFA(sale.creditAmountXof)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setTicketSale(sale)}
                          >
                            <Receipt className="h-3.5 w-3.5" />
                            Ticket
                          </Button>
                          {canCancelSale && sale.status === 'VALIDATED' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setCancellingSale(sale)}
                            >
                              <Ban className="h-3.5 w-3.5" />
                              Annuler
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <CustomerFormDialog
        open={customerDialogOpen}
        onOpenChange={setCustomerDialogOpen}
        editingCustomer={null}
        onCreated={(created) => setSelectedCustomerId(created.id)}
      />

      <SaleTicketDialog
        sale={ticketSale}
        open={Boolean(ticketSale)}
        onOpenChange={(open) => {
          if (!open) setTicketSale(null);
        }}
      />

      <CancelSaleDialog
        sale={cancellingSale}
        open={Boolean(cancellingSale)}
        onOpenChange={(open) => {
          if (!open) setCancellingSale(null);
        }}
      />
    </div>
  );
}
