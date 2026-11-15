import { useState } from 'react';
import {
  Archive,
  Banknote,
  Edit3,
  FileText,
  Plus,
  RotateCcw,
  Search,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Input } from '@/src/components/ui/input';
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
import type { Customer, CustomerType } from '@/src/types/customer';
import {
  CUSTOMER_TYPE_LABELS,
  useCustomers,
  useToggleCustomerActive,
} from '../services/customerService';
import { CustomerFormDialog } from './CustomerFormDialog';
import { CustomerPaymentDialog } from './CustomerPaymentDialog';
import { CustomerStatementDialog } from './CustomerStatementDialog';

interface CustomersViewProps {
  currentUser: AuthenticatedUser;
}

export function CustomersView({ currentUser }: CustomersViewProps) {
  const canManage = currentUser.permissions.includes('pos.sale.create');

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | CustomerType>('ALL');
  const [onlyWithDebt, setOnlyWithDebt] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);

  const [statementCustomerId, setStatementCustomerId] = useState<string | null>(null);
  const [paymentDialogState, setPaymentDialogState] = useState<{
    open: boolean;
    customer: Customer | null;
    saleId?: string | null;
    maxAmountXof?: number;
  }>({ open: false, customer: null });

  const { data: customers = [], isLoading } = useCustomers({
    search,
    customerType: typeFilter === 'ALL' ? undefined : typeFilter,
    onlyWithDebt,
    includeInactive,
  });
  const { data: allActiveCustomers = [] } = useCustomers();
  const toggleActiveMutation = useToggleCustomerActive();

  const totalCommercialDebtXof = allActiveCustomers.reduce(
    (sum, c) => sum + c.commercialDebtXof,
    0
  );
  const totalOverdueDebtXof = allActiveCustomers.reduce((sum, c) => sum + c.overdueDebtXof, 0);
  const totalConsignmentXof = allActiveCustomers.reduce(
    (sum, c) => sum + c.consignmentBalanceXof,
    0
  );

  const handleToggleActive = async (customer: Customer) => {
    try {
      await toggleActiveMutation.mutateAsync({ id: customer.id, isActive: !customer.isActive });
      toast.success(
        customer.isActive
          ? `Client « ${customer.fullName} » archivé.`
          : `Client « ${customer.fullName} » réactivé.`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action impossible');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Clients &amp; Créances commerciales
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Suivi des plafonds de crédit, recouvrements multi-canaux et séparation stricte des consignes.
          </p>
        </div>
        {canManage && (
          <Button
            variant="accent"
            onClick={() => {
              setEditingCustomer(null);
              setFormOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            Nouveau client
          </Button>
        )}
      </div>

      {/* KPIs Clients & Créances */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Clients actifs</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {allActiveCustomers.length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Créances commerciales dues</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums text-amber-700 dark:text-amber-400">
              {formatFCFA(totalCommercialDebtXof)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Créances en retard</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums text-destructive">
              {formatFCFA(totalOverdueDebtXof)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Consignes clients (séparées)</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {formatFCFA(totalConsignmentXof)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Filtres et tableau */}
      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher nom, téléphone, quartier..."
                className="pl-9"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setTypeFilter('ALL')}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                    typeFilter === 'ALL'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Tous
                </button>
                {(Object.keys(CUSTOMER_TYPE_LABELS) as CustomerType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setTypeFilter(type)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                      typeFilter === type
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {CUSTOMER_TYPE_LABELS[type]}
                  </button>
                ))}
              </div>

              <Button
                size="sm"
                variant={onlyWithDebt ? 'accent' : 'outline'}
                onClick={() => setOnlyWithDebt((v) => !v)}
              >
                Avec créance
              </Button>
              <Button
                size="sm"
                variant={includeInactive ? 'secondary' : 'outline'}
                onClick={() => setIncludeInactive((v) => !v)}
              >
                Archivés
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : customers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
              <Users className="h-8 w-8 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Aucun client trouvé</p>
                <p className="text-xs text-muted-foreground">
                  Créez vos comptes maquis, détaillants, revendeurs ou entreprises pour suivre le crédit.
                </p>
              </div>
              {canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingCustomer(null);
                    setFormOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Ajouter un client
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Téléphone &amp; Adresse</TableHead>
                  <TableHead className="text-right">Plafond crédit</TableHead>
                  <TableHead className="text-right">Créance due</TableHead>
                  <TableHead className="text-right">Consignes</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((customer) => (
                  <TableRow key={customer.id} className={!customer.isActive ? 'opacity-60' : ''}>
                    <TableCell>
                      <div className="font-medium text-foreground">{customer.fullName}</div>
                      <div className="text-xs text-muted-foreground">
                        {CUSTOMER_TYPE_LABELS[customer.customerType]} · Échéance {customer.dueDays} j
                        {!customer.isActive ? ' · Archivé' : ''}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>{customer.phone ?? '—'}</div>
                      <div className="truncate max-w-52">{customer.address ?? '—'}</div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatFCFA(customer.creditLimitXof)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                      <div
                        className={
                          customer.overdueDebtXof > 0
                            ? 'text-destructive'
                            : customer.commercialDebtXof > 0
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-muted-foreground'
                        }
                      >
                        {formatFCFA(customer.commercialDebtXof)}
                      </div>
                      {customer.overdueDebtXof > 0 && (
                        <div className="text-[11px] font-normal text-destructive">
                          Retard : {formatFCFA(customer.overdueDebtXof)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatFCFA(customer.consignmentBalanceXof)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setStatementCustomerId(customer.id)}
                          title="Relevé & historique"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          Relevé
                        </Button>
                        {canManage && customer.commercialDebtXof > 0 && (
                          <Button
                            size="sm"
                            variant="accent"
                            onClick={() =>
                              setPaymentDialogState({
                                open: true,
                                customer,
                                saleId: null,
                                maxAmountXof: customer.commercialDebtXof,
                              })
                            }
                          >
                            <Banknote className="h-3.5 w-3.5" />
                            Encaisser
                          </Button>
                        )}
                        {canManage && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingCustomer(customer);
                                setFormOpen(true);
                              }}
                              title="Modifier"
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void handleToggleActive(customer)}
                              title={customer.isActive ? 'Archiver' : 'Réactiver'}
                            >
                              {customer.isActive ? (
                                <Archive className="h-3.5 w-3.5" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </>
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

      <CustomerFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editingCustomer={editingCustomer}
      />

      <CustomerStatementDialog
        customerId={statementCustomerId}
        open={Boolean(statementCustomerId)}
        onOpenChange={(open) => {
          if (!open) setStatementCustomerId(null);
        }}
        canCollectDebt={canManage}
        onRequestPayment={(cust, saleId, remainingXof) => {
          setPaymentDialogState({
            open: true,
            customer: cust,
            saleId: saleId ?? null,
            maxAmountXof: remainingXof ?? cust.commercialDebtXof,
          });
        }}
      />

      <CustomerPaymentDialog
        open={paymentDialogState.open}
        onOpenChange={(open) => setPaymentDialogState((prev) => ({ ...prev, open }))}
        customer={paymentDialogState.customer}
        preselectedSaleId={paymentDialogState.saleId}
        maxAmountXof={paymentDialogState.maxAmountXof}
      />
    </div>
  );
}
