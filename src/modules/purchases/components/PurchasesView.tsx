import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Banknote,
  CheckCircle2,
  ClipboardList,
  PackagePlus,
  Plus,
  Search,
  Undo2,
  XCircle,
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
import { useSuppliers } from '@/src/modules/suppliers/services/supplierService';
import type { AuthenticatedUser } from '@/src/types/auth';
import type { PaymentMethod, PurchaseOrder, PurchaseOrderStatus } from '@/src/types/purchase';
import {
  supplierReturnFormSchema,
  type SupplierReturnFormValues,
} from '../schemas/purchase.schema';
import {
  useCancelPurchaseOrder,
  useGoodsReceipts,
  usePurchaseOrders,
  useRecordSupplierReturn,
  useSupplierPayments,
  useValidatePurchaseOrder,
} from '../services/purchaseService';
import { PurchaseOrderDialog } from './PurchaseOrderDialog';
import { ReceiveOrderDialog } from './ReceiveOrderDialog';
import { SupplierPaymentDialog } from './SupplierPaymentDialog';

const ALL_FILTER = '__ALL__';

const ORDER_STATUS_META: Record<PurchaseOrderStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Brouillon', className: 'text-muted-foreground' },
  VALIDATED: { label: 'En attente', className: 'text-sky-600 dark:text-sky-400 font-medium' },
  PARTIAL_RECEIVED: {
    label: 'Réception partielle',
    className: 'text-amber-600 dark:text-amber-400 font-medium',
  },
  RECEIVED: {
    label: 'Réceptionnée',
    className: 'text-emerald-700 dark:text-emerald-400 font-medium',
  },
  CANCELLED: { label: 'Annulée', className: 'text-muted-foreground line-through' },
};

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Espèces',
  ORANGE_MONEY: 'Orange Money',
  MTN_MOMO: 'MTN MoMo',
  MOOV_MONEY: 'Moov Money',
  WAVE: 'Wave',
  BANK_TRANSFER: 'Virement bancaire',
};

interface PurchasesViewProps {
  currentUser: AuthenticatedUser;
}

export function PurchasesView({ currentUser }: PurchasesViewProps) {
  const canManage = currentUser.permissions.includes('purchase.manage');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');

  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [receiveOrder, setReceiveOrder] = useState<PurchaseOrder | null>(null);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [paymentTargetOrder, setPaymentTargetOrder] = useState<PurchaseOrder | null>(null);

  const { data: orders = [], isLoading: loadingOrders } = usePurchaseOrders({
    search,
    status: statusFilter,
    supplierId: supplierFilter,
  });
  const { data: allOrders = [] } = usePurchaseOrders();
  const { data: receipts = [], isLoading: loadingReceipts } = useGoodsReceipts();
  const { data: payments = [], isLoading: loadingPayments } = useSupplierPayments();
  const { data: suppliers = [] } = useSuppliers();
  const { data: products = [] } = useProducts();

  const validateMutation = useValidatePurchaseOrder();
  const cancelMutation = useCancelPurchaseOrder();
  const returnMutation = useRecordSupplierReturn();

  const receivedOrders = allOrders.filter(
    (o) => o.status === 'PARTIAL_RECEIVED' || o.status === 'RECEIVED'
  );

  const returnForm = useForm<SupplierReturnFormValues>({
    resolver: zodResolver(supplierReturnFormSchema) as never,
    defaultValues: {
      purchaseOrderId: '',
      productId: '',
      unitId: '',
      quantity: 1,
      note: '',
    },
  });

  const selectedReturnOrderId = returnForm.watch('purchaseOrderId');
  const selectedReturnProductId = returnForm.watch('productId');
  const selectedReturnOrder = receivedOrders.find((o) => o.id === selectedReturnOrderId);
  const returnableItems = (selectedReturnOrder?.items ?? []).filter((i) => i.receivedQty > 0);
  const selectedReturnItem = returnableItems.find((i) => i.productId === selectedReturnProductId);

  useEffect(() => {
    if (!selectedReturnOrderId && receivedOrders.length > 0) {
      const firstOrder = receivedOrders[0];
      const firstLine = firstOrder.items.find((i) => i.receivedQty > 0);
      returnForm.setValue('purchaseOrderId', firstOrder.id);
      if (firstLine) {
        returnForm.setValue('productId', firstLine.productId);
        returnForm.setValue('unitId', firstLine.unitId);
      }
    }
  }, [receivedOrders, selectedReturnOrderId, returnForm]);

  const handleReturnOrderChange = (orderId: string) => {
    returnForm.setValue('purchaseOrderId', orderId);
    const po = receivedOrders.find((o) => o.id === orderId);
    const firstLine = po?.items.find((i) => i.receivedQty > 0);
    if (firstLine) {
      returnForm.setValue('productId', firstLine.productId);
      returnForm.setValue('unitId', firstLine.unitId);
    } else {
      returnForm.setValue('productId', '');
      returnForm.setValue('unitId', '');
    }
  };

  const handleReturnProductChange = (productId: string) => {
    returnForm.setValue('productId', productId);
    const line = returnableItems.find((i) => i.productId === productId);
    if (line) {
      returnForm.setValue('unitId', line.unitId);
    }
  };

  const onSubmitReturn = async (values: SupplierReturnFormValues) => {
    try {
      const res = await returnMutation.mutateAsync(values);
      toast.success(
        `Retour ${res.returnNumber} enregistré (-${res.baseQtyReturned} unités base, avoir ${formatFCFA(res.totalReturnXof)}).`
      );
      returnForm.setValue('quantity', 1);
      returnForm.setValue('note', '');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur retour fournisseur');
    }
  };

  const handleValidateOrder = async (order: PurchaseOrder) => {
    try {
      await validateMutation.mutateAsync(order.id);
      toast.success(`Commande ${order.orderNumber} validée (prête pour réception).`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur validation');
    }
  };

  const handleCancelOrder = async (order: PurchaseOrder) => {
    try {
      await cancelMutation.mutateAsync({ id: order.id });
      toast.success(`Commande ${order.orderNumber} annulée.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible d'annuler cette commande");
    }
  };

  const handleOpenPayment = (order: PurchaseOrder | null) => {
    setPaymentTargetOrder(order);
    setPaymentDialogOpen(true);
  };

  const pendingOrdersCount = allOrders.filter(
    (o) => o.status === 'VALIDATED' || o.status === 'PARTIAL_RECEIVED'
  ).length;
  const totalReceivedAllXof = allOrders.reduce((acc, o) => acc + o.receivedAmountXof, 0);
  const totalSupplierDebtXof = suppliers.reduce((acc, s) => acc + s.balanceDueXof, 0);
  const totalPaidAllXof = payments.reduce((acc, p) => acc + p.amountXof, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Achats, Réceptions &amp; Dettes Fournisseurs
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Bons de commande, réceptions partielles ou complètes alimentant stock et CUMP, retours et règlements.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => handleOpenPayment(null)}
              disabled={suppliers.length === 0}
            >
              <Banknote className="h-4 w-4" />
              Régler fournisseur
            </Button>
            <Button
              variant="accent"
              onClick={() => setCreateOrderOpen(true)}
              disabled={suppliers.length === 0 || products.length === 0}
            >
              <Plus className="h-4 w-4" />
              Nouvelle commande
            </Button>
          </div>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Commandes en cours</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {pendingOrdersCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Validées ou en réception partielle
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total réceptionné</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {formatFCFA(totalReceivedAllXof)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Sur {receipts.length} bon{receipts.length > 1 ? 's' : ''} de réception validé
            {receipts.length > 1 ? 's' : ''}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Dette fournisseurs due</CardDescription>
            <CardTitle
              className={
                totalSupplierDebtXof > 0
                  ? 'font-mono text-2xl tabular-nums text-amber-600 dark:text-amber-400'
                  : 'font-mono text-2xl tabular-nums'
              }
            >
              {formatFCFA(totalSupplierDebtXof)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Réceptionné non encore réglé
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Règlements effectués</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {formatFCFA(totalPaidAllXof)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {payments.length} paiement{payments.length > 1 ? 's' : ''} enregistré
            {payments.length > 1 ? 's' : ''}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Commandes ({orders.length})</TabsTrigger>
          <TabsTrigger value="receipts">Réceptions ({receipts.length})</TabsTrigger>
          <TabsTrigger value="payments">Règlements ({payments.length})</TabsTrigger>
          <TabsTrigger value="returns">Retours fournisseurs</TabsTrigger>
        </TabsList>

        {/* Onglet 1 : Commandes */}
        <TabsContent value="orders" className="space-y-4">
          <Card>
            <CardContent className="pt-5">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
                <div className="relative md:col-span-6">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Rechercher par n° commande, fournisseur ou note..."
                    className="pl-9"
                  />
                </div>
                <div className="md:col-span-3">
                  <Select
                    value={supplierFilter || ALL_FILTER}
                    onValueChange={(v) => setSupplierFilter(v === ALL_FILTER ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Tous fournisseurs" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>Tous fournisseurs</SelectItem>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-3">
                  <Select
                    value={statusFilter || ALL_FILTER}
                    onValueChange={(v) => setStatusFilter(v === ALL_FILTER ? '' : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Tous statuts" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>Tous statuts</SelectItem>
                      <SelectItem value="DRAFT">Brouillon</SelectItem>
                      <SelectItem value="VALIDATED">En attente</SelectItem>
                      <SelectItem value="PARTIAL_RECEIVED">Réception partielle</SelectItem>
                      <SelectItem value="RECEIVED">Réceptionnée</SelectItem>
                      <SelectItem value="CANCELLED">Annulée</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {loadingOrders ? (
                <div className="p-6">
                  <Skeleton className="h-44 w-full" />
                </div>
              ) : orders.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
                  <ClipboardList className="h-8 w-8 text-muted-foreground" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      Aucune commande fournisseur enregistrée
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {suppliers.length === 0 || products.length === 0
                        ? 'Assurez-vous d’avoir au moins un fournisseur et un produit actif.'
                        : 'Créez votre premier bon de commande puis réceptionnez la livraison.'}
                    </p>
                  </div>
                  {canManage && suppliers.length > 0 && products.length > 0 && (
                    <Button size="sm" variant="accent" onClick={() => setCreateOrderOpen(true)}>
                      <Plus className="h-4 w-4" />
                      Nouvelle commande
                    </Button>
                  )}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bon / Date</TableHead>
                      <TableHead>Fournisseur</TableHead>
                      <TableHead>Statut</TableHead>
                      <TableHead className="text-right">Commandé</TableHead>
                      <TableHead className="text-right">Réceptionné</TableHead>
                      <TableHead className="text-right">Payé</TableHead>
                      <TableHead className="text-right">Reste dû (reçu)</TableHead>
                      {canManage && <TableHead className="text-right">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((po) => {
                      const meta = ORDER_STATUS_META[po.status];
                      const canReceive =
                        po.status === 'VALIDATED' || po.status === 'PARTIAL_RECEIVED';
                      const canPay =
                        po.status !== 'DRAFT' &&
                        po.status !== 'CANCELLED' &&
                        po.remainingToPayOnOrderXof > 0;
                      const canCancel =
                        (po.status === 'DRAFT' || po.status === 'VALIDATED') &&
                        po.receivedAmountXof === 0 &&
                        po.paidAmountXof === 0;

                      return (
                        <TableRow key={po.id}>
                          <TableCell>
                            <div className="font-mono text-xs font-semibold text-foreground">
                              {po.orderNumber}
                            </div>
                            <div className="font-mono text-xs tabular-nums text-muted-foreground">
                              {formatDateTimeFr(po.orderedAt)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-foreground">{po.supplierName}</div>
                            <div className="text-xs text-muted-foreground">
                              {po.items
                                .map((i) => `${i.orderedQty} ${i.unitName} ${i.productName}`)
                                .join(' · ')}
                            </div>
                          </TableCell>
                          <TableCell className={`text-xs ${meta.className}`}>{meta.label}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatFCFA(po.totalAmountXof)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatFCFA(po.receivedAmountXof)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatFCFA(po.paidAmountXof)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                            {formatFCFA(po.remainingToPayOnReceivedXof)}
                          </TableCell>
                          {canManage && (
                            <TableCell className="text-right">
                              <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                                {po.status === 'DRAFT' && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void handleValidateOrder(po)}
                                    disabled={validateMutation.isPending}
                                  >
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    Valider
                                  </Button>
                                )}
                                {canReceive && (
                                  <Button
                                    size="sm"
                                    variant="accent"
                                    onClick={() => setReceiveOrder(po)}
                                  >
                                    <PackagePlus className="h-3.5 w-3.5" />
                                    Réceptionner
                                  </Button>
                                )}
                                {canPay && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleOpenPayment(po)}
                                  >
                                    <Banknote className="h-3.5 w-3.5" />
                                    Régler
                                  </Button>
                                )}
                                {canCancel && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void handleCancelOrder(po)}
                                    disabled={cancelMutation.isPending}
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                    Annuler
                                  </Button>
                                )}
                              </div>
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

        {/* Onglet 2 : Bons de réception */}
        <TabsContent value="receipts">
          <Card>
            <CardContent className="p-0">
              {loadingReceipts ? (
                <div className="p-6">
                  <Skeleton className="h-44 w-full" />
                </div>
              ) : receipts.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Aucune réception validée pour le moment.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>N° Réception</TableHead>
                      <TableHead>Commande / BL</TableHead>
                      <TableHead>Fournisseur</TableHead>
                      <TableHead>Détail articles reçus</TableHead>
                      <TableHead>Opérateur</TableHead>
                      <TableHead className="text-right">Valeur reçue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {receipts.map((rec) => (
                      <TableRow key={rec.id}>
                        <TableCell>
                          <div className="font-mono text-xs font-semibold text-foreground">
                            {rec.receiptNumber}
                          </div>
                          <div className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDateTimeFr(rec.receivedAt)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">{rec.orderNumber}</div>
                          {rec.supplierInvoiceRef && (
                            <div className="font-mono text-xs text-muted-foreground">
                              BL {rec.supplierInvoiceRef}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="font-medium">{rec.supplierName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {rec.items
                            .map(
                              (i) => `${i.productName}: +${i.receivedQty} (+${i.baseQty} base)`
                            )
                            .join(' · ')}
                        </TableCell>
                        <TableCell className="text-xs">{rec.userName}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                          {formatFCFA(rec.totalReceivedXof)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Onglet 3 : Règlements fournisseurs */}
        <TabsContent value="payments">
          <Card>
            <CardContent className="p-0">
              {loadingPayments ? (
                <div className="p-6">
                  <Skeleton className="h-44 w-full" />
                </div>
              ) : payments.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Aucun règlement fournisseur enregistré.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>N° Paiement</TableHead>
                      <TableHead>Fournisseur</TableHead>
                      <TableHead>Bon rattaché</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Référence</TableHead>
                      <TableHead>Opérateur</TableHead>
                      <TableHead className="text-right">Montant réglé</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((pay) => (
                      <TableRow key={pay.id}>
                        <TableCell>
                          <div className="font-mono text-xs font-semibold text-foreground">
                            {pay.paymentNumber}
                          </div>
                          <div className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDateTimeFr(pay.createdAt)}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">{pay.supplierName}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {pay.orderNumber ?? 'Répartition FIFO'}
                        </TableCell>
                        <TableCell className="text-xs">
                          {PAYMENT_METHOD_LABELS[pay.paymentMethod] ?? pay.paymentMethod}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {pay.externalReference ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs">{pay.userName}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                          {formatFCFA(pay.amountXof)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Onglet 4 : Retours fournisseurs */}
        <TabsContent value="returns">
          {!canManage ? (
            <AccessDeniedCard
              requiredPermission="purchase.manage"
              userRoleName={currentUser.roleName}
            />
          ) : (
            <Card className="max-w-2xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Undo2 className="h-4 w-4 text-muted-foreground" />
                  Enregistrer un retour fournisseur
                </CardTitle>
                <CardDescription>
                  Décrémente le stock avec mouvement SUPPLIER_RETURN et ajuste la dette exigible sur la commande réceptionnée.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {receivedOrders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Aucune commande réceptionnée disponible pour un retour fournisseur.
                  </p>
                ) : (
                  <form onSubmit={returnForm.handleSubmit(onSubmitReturn)} className="space-y-4">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>Commande réceptionnée *</Label>
                        <Controller
                          name="purchaseOrderId"
                          control={returnForm.control}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={handleReturnOrderChange}>
                              <SelectTrigger>
                                <SelectValue placeholder="Choisir un bon" />
                              </SelectTrigger>
                              <SelectContent>
                                {receivedOrders.map((o) => (
                                  <SelectItem key={o.id} value={o.id}>
                                    {o.orderNumber} · {o.supplierName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label>Article reçu *</Label>
                        <Controller
                          name="productId"
                          control={returnForm.control}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={handleReturnProductChange}>
                              <SelectTrigger>
                                <SelectValue placeholder="Choisir un article" />
                              </SelectTrigger>
                              <SelectContent>
                                {returnableItems.map((i) => (
                                  <SelectItem key={i.id} value={i.productId}>
                                    {i.productName} (reçu : {i.receivedQty} {i.unitName})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="ret-qty">
                          Quantité retournée ({selectedReturnItem?.unitName ?? 'unité'}) *
                        </Label>
                        <Input
                          id="ret-qty"
                          type="number"
                          min={1}
                          max={selectedReturnItem?.receivedQty ?? undefined}
                          className="font-mono tabular-nums"
                          {...returnForm.register('quantity')}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="ret-note">Motif du retour</Label>
                        <Input
                          id="ret-note"
                          placeholder="Ex. Lot abîmé ou non conforme"
                          {...returnForm.register('note')}
                        />
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button
                        type="submit"
                        variant="accent"
                        disabled={returnMutation.isPending || !selectedReturnItem}
                      >
                        {returnMutation.isPending ? 'Enregistrement...' : 'Valider le retour'}
                      </Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <PurchaseOrderDialog
        open={createOrderOpen}
        onOpenChange={setCreateOrderOpen}
        suppliers={suppliers}
        products={products}
      />

      <ReceiveOrderDialog
        open={Boolean(receiveOrder)}
        onOpenChange={(v) => {
          if (!v) setReceiveOrder(null);
        }}
        order={receiveOrder}
      />

      <SupplierPaymentDialog
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
        suppliers={suppliers}
        targetOrder={paymentTargetOrder}
      />
    </div>
  );
}
