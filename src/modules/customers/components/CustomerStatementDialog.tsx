import { useState } from 'react';
import { Banknote } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/src/components/ui/dialog';
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
import type { Customer } from '@/src/types/customer';
import {
  CUSTOMER_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  useCustomerStatement,
} from '../services/customerService';

interface CustomerStatementDialogProps {
  customerId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canCollectDebt: boolean;
  onRequestPayment: (customer: Customer, saleId?: string, remainingXof?: number) => void;
}

export function CustomerStatementDialog({
  customerId,
  open,
  onOpenChange,
  canCollectDebt,
  onRequestPayment,
}: CustomerStatementDialogProps) {
  const [tab, setTab] = useState<'sales' | 'payments'>('sales');
  const { data: statement, isLoading } = useCustomerStatement(open ? customerId : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {statement ? `Relevé client — ${statement.customer.fullName}` : 'Relevé client'}
          </DialogTitle>
          <DialogDescription>
            {statement
              ? `${CUSTOMER_TYPE_LABELS[statement.customer.customerType]} · Échéance ${statement.customer.dueDays} jours · Plafond ${formatFCFA(statement.customer.creditLimitXof)}`
              : 'Historique des ventes à crédit, encaissements et consigne distincte.'}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !statement ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-44 w-full" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-border p-3.5">
                <p className="text-xs text-muted-foreground">Créance commerciale due</p>
                <p
                  className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
                    statement.customer.commercialDebtXof > 0
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-foreground'
                  }`}
                >
                  {formatFCFA(statement.customer.commercialDebtXof)}
                </p>
                {statement.customer.overdueDebtXof > 0 && (
                  <p className="mt-0.5 font-mono text-xs tabular-nums text-destructive">
                    Dont {formatFCFA(statement.customer.overdueDebtXof)} en retard
                  </p>
                )}
              </div>

              <div className="rounded-md border border-border p-3.5">
                <p className="text-xs text-muted-foreground">
                  Solde consignes (emballages distincts)
                </p>
                <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                  {formatFCFA(statement.customer.consignmentBalanceXof)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Jamais confondu avec les créances
                </p>
              </div>

              <div className="rounded-md border border-border p-3.5">
                <p className="text-xs text-muted-foreground">Volume d’achats validés</p>
                <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">
                  {formatFCFA(statement.customer.totalPurchasedXof)}
                </p>
                <p className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                  {statement.customer.salesCount} ticket(s)
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
                <button
                  type="button"
                  onClick={() => setTab('sales')}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    tab === 'sales'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Ventes ({statement.sales.length})
                </button>
                <button
                  type="button"
                  onClick={() => setTab('payments')}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    tab === 'payments'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Règlements ({statement.payments.length})
                </button>
              </div>

              {canCollectDebt && statement.customer.commercialDebtXof > 0 && (
                <Button
                  size="sm"
                  variant="accent"
                  onClick={() => onRequestPayment(statement.customer)}
                >
                  <Banknote className="h-4 w-4" />
                  Encaisser créance (FIFO)
                </Button>
              )}
            </div>

            {tab === 'sales' ? (
              <div className="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ticket</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Tarif</TableHead>
                      <TableHead className="text-right">Net à payer</TableHead>
                      <TableHead className="text-right">Payé</TableHead>
                      <TableHead className="text-right">Crédit dû</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.sales.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                          Aucune vente enregistrée pour ce client.
                        </TableCell>
                      </TableRow>
                    ) : (
                      statement.sales.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-mono text-xs font-medium">
                            {s.saleNumber}
                            {s.status === 'CANCELLED' ? ' · Annulée' : ''}
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDateTimeFr(s.createdAt)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {s.priceTier === 'WHOLESALE' ? 'Gros' : 'Détail'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatFCFA(s.totalPayableXof)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatFCFA(s.paidAmountXof)}
                          </TableCell>
                          <TableCell
                            className={`text-right font-mono text-xs font-semibold tabular-nums ${
                              s.isOverdue
                                ? 'text-destructive'
                                : s.creditAmountXof > 0
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : 'text-muted-foreground'
                            }`}
                          >
                            {formatFCFA(s.creditAmountXof)}
                            {s.isOverdue ? ' (Retard)' : ''}
                          </TableCell>
                          <TableCell className="text-right">
                            {canCollectDebt && s.status === 'VALIDATED' && s.creditAmountXof > 0 && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  onRequestPayment(statement.customer, s.id, s.creditAmountXof)
                                }
                              >
                                Régler
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reçu</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Canal</TableHead>
                      <TableHead>Ticket affecté</TableHead>
                      <TableHead>Référence</TableHead>
                      <TableHead className="text-right">Montant</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.payments.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                          Aucun règlement enregistré.
                        </TableCell>
                      </TableRow>
                    ) : (
                      statement.payments.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-mono text-xs font-medium">
                            {p.paymentNumber}
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDateTimeFr(p.createdAt)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {PAYMENT_METHOD_LABELS[p.paymentMethod]}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {p.saleNumber ?? 'Ventilation FIFO'}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {p.externalReference ?? '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                            {formatFCFA(p.amountXof)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
