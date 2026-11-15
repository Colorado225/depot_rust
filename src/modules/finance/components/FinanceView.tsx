import { useState } from 'react';
import {
  ArrowLeftRight,
  Banknote,
  Calculator,
  Eye,
  Lock,
  Plus,
  Receipt,
  Unlock,
} from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
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
import { PAYMENT_METHOD_LABELS } from '@/src/modules/customers/services/customerService';
import type { AuthenticatedUser } from '@/src/types/auth';
import type { CustomerPaymentMethod } from '@/src/types/customer';
import {
  useCashSessions,
  useExpenseCategories,
  useExpenses,
  useFinanceOverview,
  useTreasuryPayments,
} from '../services/financeService';
import { CloseSessionDialog } from './CloseSessionDialog';
import { ExpenseDialog } from './ExpenseDialog';
import { ManualMovementDialog } from './ManualMovementDialog';
import { OpenSessionDialog } from './OpenSessionDialog';
import { SessionDetailDialog } from './SessionDetailDialog';

const ALL_FILTER = '__ALL__';

interface FinanceViewProps {
  currentUser: AuthenticatedUser;
}

export function FinanceView({ currentUser }: FinanceViewProps) {
  const canOperateCash = currentUser.permissions.includes('cash.session.operate');
  const canOverrideCash = currentUser.permissions.includes('cash.session.override');
  const canWriteExpense = currentUser.permissions.includes('expense.write');

  const [openSessionModal, setOpenSessionModal] = useState(false);
  const [closeSessionModal, setCloseSessionModal] = useState(false);
  const [manualMoveModal, setManualMoveModal] = useState(false);
  const [expenseModal, setExpenseModal] = useState(false);
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);

  const [expenseCategoryFilter, setExpenseCategoryFilter] = useState('');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<CustomerPaymentMethod | ''>('');

  const { data: overview, isLoading: loadingOverview } = useFinanceOverview();
  const { data: sessions = [], isLoading: loadingSessions } = useCashSessions(40);
  const { data: categories = [] } = useExpenseCategories();
  const { data: expenses = [], isLoading: loadingExpenses } = useExpenses({
    categoryId: expenseCategoryFilter || undefined,
    paymentMethod: paymentMethodFilter || undefined,
    limit: 120,
  });
  const { data: payments = [], isLoading: loadingPayments } = useTreasuryPayments({
    paymentMethod: paymentMethodFilter || undefined,
    limit: 120,
  });

  const activeSession = overview?.activeSession ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Finances, Caisse &amp; Réconciliation
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sessions de caisse, dépenses opérationnelles, contrôle des écarts de clôture et suivi multi-canaux.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canWriteExpense && (
            <Button variant="outline" onClick={() => setExpenseModal(true)}>
              <Receipt className="h-4 w-4" />
              Nouvelle dépense
            </Button>
          )}
          {canOperateCash && !activeSession && (
            <Button variant="accent" onClick={() => setOpenSessionModal(true)}>
              <Unlock className="h-4 w-4" />
              Ouvrir la caisse
            </Button>
          )}
          {canOperateCash && activeSession && (
            <>
              <Button variant="outline" onClick={() => setManualMoveModal(true)}>
                <ArrowLeftRight className="h-4 w-4" />
                Apport / Retrait
              </Button>
              <Button variant="accent" onClick={() => setCloseSessionModal(true)}>
                <Lock className="h-4 w-4" />
                Clôturer la caisse
              </Button>
            </>
          )}
        </div>
      </div>

      {/* KPIs de trésorerie */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              {activeSession ? `Caisse active (${activeSession.registerCode})` : 'Session de caisse'}
            </CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {activeSession ? formatFCFA(activeSession.theoreticalClosingXof) : 'Fermée'}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {activeSession
              ? `Ouverte par ${activeSession.openedByName} · fond ${formatFCFA(
                  activeSession.openingBalanceXof
                )}`
              : 'Aucune session ouverte en cours'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total encaissements (tous canaux)</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums text-emerald-700 dark:text-emerald-400">
              {formatFCFA(overview?.totalInboundXof ?? 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Ventes comptant &amp; recouvrements clients
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Dépenses opérationnelles</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums text-amber-700 dark:text-amber-400">
              {formatFCFA(overview?.totalExpensesXof ?? 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Charges enregistrées ({expenses.length} écritures affichées)
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Cumul écarts de clôture</CardDescription>
            <CardTitle
              className={`font-mono text-2xl tabular-nums ${
                (overview?.cumulativeVarianceXof ?? 0) < 0
                  ? 'text-destructive'
                  : (overview?.cumulativeVarianceXof ?? 0) > 0
                    ? 'text-sky-700 dark:text-sky-400'
                    : ''
              }`}
            >
              {(overview?.cumulativeVarianceXof ?? 0) > 0
                ? `+${formatFCFA(overview?.cumulativeVarianceXof ?? 0)}`
                : formatFCFA(overview?.cumulativeVarianceXof ?? 0)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Sur {overview?.closedSessionsCount ?? 0} session
            {(overview?.closedSessionsCount ?? 0) > 1 ? 's' : ''} clôturée
            {(overview?.closedSessionsCount ?? 0) > 1 ? 's' : ''}
          </CardContent>
        </Card>
      </div>

      {/* Panneau d'ouverture de caisse dédié au début de service du caissier */}
      {!activeSession && canOperateCash && (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base">Démarrage de service — Caisse fermée</CardTitle>
              <CardDescription>
                Ouvrez votre session de caisse avec le fond initial du tiroir pour enregistrer les encaissements espèces du jour.
              </CardDescription>
            </div>
            <Button variant="accent" onClick={() => setOpenSessionModal(true)}>
              <Unlock className="h-4 w-4" />
              Ouvrir ma session de caisse
            </Button>
          </CardHeader>
        </Card>
      )}

      {/* Panneau session active si ouverte */}
      {activeSession && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base">
                  Session en cours : {activeSession.registerCode} — {activeSession.registerName}
                </CardTitle>
                <CardDescription>
                  Ouverte le {formatDateTimeFr(activeSession.openedAt)} par {activeSession.openedByName}
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDetailSessionId(activeSession.id)}
              >
                <Eye className="h-3.5 w-3.5" />
                Journal détaillé
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">Fond initial</div>
                <div className="font-mono text-sm font-semibold tabular-nums">
                  {formatFCFA(activeSession.openingBalanceXof)}
                </div>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">Entrées espèces (+)</div>
                <div className="font-mono text-sm font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                  +{formatFCFA(activeSession.cashInXof)}
                </div>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">Sorties espèces (-)</div>
                <div className="font-mono text-sm font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                  -{formatFCFA(activeSession.cashOutXof)}
                </div>
              </div>
              <div className="rounded-md border border-border bg-secondary/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">Solde théorique tiroir</div>
                <div className="font-mono text-sm font-bold tabular-nums text-foreground">
                  {formatFCFA(activeSession.theoreticalClosingXof)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="sessions">
        <TabsList>
          <TabsTrigger value="sessions">Sessions de caisse ({sessions.length})</TabsTrigger>
          <TabsTrigger value="channels">Rapprochement multi-canaux</TabsTrigger>
          <TabsTrigger value="expenses">Dépenses ({expenses.length})</TabsTrigger>
        </TabsList>

        {/* Onglet 1 : Historique et contrôle des écarts de caisse */}
        <TabsContent value="sessions">
          <Card>
            <CardContent className="p-0">
              {loadingSessions ? (
                <div className="space-y-2 p-6">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
                  <Banknote className="h-8 w-8 text-muted-foreground" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      Aucune session de caisse enregistrée
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Ouvrez une session de caisse pour tracer les encaissements espèces et clôtures.
                    </p>
                  </div>
                  {canOperateCash && (
                    <Button size="sm" variant="accent" onClick={() => setOpenSessionModal(true)}>
                      <Unlock className="h-4 w-4" />
                      Ouvrir la caisse
                    </Button>
                  )}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Caisse / Ouverture</TableHead>
                      <TableHead>Caissier</TableHead>
                      <TableHead>Statut</TableHead>
                      <TableHead className="text-right">Fond initial</TableHead>
                      <TableHead className="text-right">Théorique</TableHead>
                      <TableHead className="text-right">Compté</TableHead>
                      <TableHead className="text-right">Écart</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessions.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="font-medium text-foreground">
                            {s.registerCode} — {s.registerName}
                          </div>
                          <div className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDateTimeFr(s.openedAt)}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{s.openedByName}</div>
                          {s.closedByName && (
                            <div className="text-muted-foreground">Clôture : {s.closedByName}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs font-medium">
                          {s.status === 'OPEN' ? (
                            <span className="text-emerald-700 dark:text-emerald-400">Ouverte</span>
                          ) : (
                            <span className="text-muted-foreground">Clôturée</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatFCFA(s.openingBalanceXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatFCFA(s.theoreticalClosingXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {s.declaredClosingXof !== null ? formatFCFA(s.declaredClosingXof) : '—'}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono text-xs font-semibold tabular-nums ${
                            s.varianceXof === null || s.varianceXof === 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : s.varianceXof > 0
                                ? 'text-sky-700 dark:text-sky-400'
                                : 'text-destructive'
                          }`}
                        >
                          {s.varianceXof === null
                            ? '—'
                            : s.varianceXof === 0
                              ? '0 FCFA'
                              : `${s.varianceXof > 0 ? '+' : ''}${formatFCFA(s.varianceXof)}`}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDetailSessionId(s.id)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            Détails
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Onglet 2 : Réconciliation multi-canaux */}
        <TabsContent value="channels" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Calculator className="h-4 w-4 text-muted-foreground" />
                Synthèse par canal de règlement
              </CardTitle>
              <CardDescription>
                Agrégation exacte des paiements encaissés, règlements fournisseurs/consignes et dépenses par canal.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {loadingOverview || !overview ? (
                <div className="p-6">
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Canal</TableHead>
                      <TableHead className="text-right">Transactions</TableHead>
                      <TableHead className="text-right">Encaissements (+)</TableHead>
                      <TableHead className="text-right">Décaissements tiers (-)</TableHead>
                      <TableHead className="text-right">Dépenses (-)</TableHead>
                      <TableHead className="text-right">Solde net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.channels.map((ch) => (
                      <TableRow key={ch.paymentMethod}>
                        <TableCell className="font-medium">
                          {PAYMENT_METHOD_LABELS[ch.paymentMethod]}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {ch.transactionCount}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-emerald-700 dark:text-emerald-400">
                          {formatFCFA(ch.inboundXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {formatFCFA(ch.outboundPaymentsXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {formatFCFA(ch.expensesXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                          {formatFCFA(ch.netXof)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base">Journal des flux financiers</CardTitle>
                <CardDescription>
                  Encaissements clients, règlements fournisseurs et remboursements de consignes.
                </CardDescription>
              </div>
              <div className="w-full sm:w-56">
                <Select
                  value={paymentMethodFilter || ALL_FILTER}
                  onValueChange={(v) =>
                    setPaymentMethodFilter(v === ALL_FILTER ? '' : (v as CustomerPaymentMethod))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Tous les canaux" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER}>Tous les canaux</SelectItem>
                    {(Object.keys(PAYMENT_METHOD_LABELS) as CustomerPaymentMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loadingPayments ? (
                <div className="p-6">
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : payments.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Aucun flux de paiement enregistré pour ce filtre.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Référence / Date</TableHead>
                      <TableHead>Tiers</TableHead>
                      <TableHead>Canal</TableHead>
                      <TableHead>Réf. externe</TableHead>
                      <TableHead>Opérateur</TableHead>
                      <TableHead className="text-right">Montant</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="font-mono text-xs font-semibold">{p.paymentNumber}</div>
                          <div className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDateTimeFr(p.createdAt)}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{p.partyName}</TableCell>
                        <TableCell className="text-xs">
                          {PAYMENT_METHOD_LABELS[p.paymentMethod]}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {p.externalReference ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{p.userName}</TableCell>
                        <TableCell
                          className={`text-right font-mono text-xs font-semibold tabular-nums ${
                            p.direction === 'INBOUND'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {p.direction === 'INBOUND' ? '+' : '-'}
                          {formatFCFA(p.amountXof)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Onglet 3 : Dépenses opérationnelles */}
        <TabsContent value="expenses" className="space-y-4">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-lg">
                <Select
                  value={expenseCategoryFilter || ALL_FILTER}
                  onValueChange={(v) => setExpenseCategoryFilter(v === ALL_FILTER ? '' : v)}
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

                <Select
                  value={paymentMethodFilter || ALL_FILTER}
                  onValueChange={(v) =>
                    setPaymentMethodFilter(v === ALL_FILTER ? '' : (v as CustomerPaymentMethod))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Tous canaux" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER}>Tous canaux</SelectItem>
                    {(Object.keys(PAYMENT_METHOD_LABELS) as CustomerPaymentMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {canWriteExpense && (
                <Button variant="accent" onClick={() => setExpenseModal(true)}>
                  <Plus className="h-4 w-4" />
                  Enregistrer une dépense
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {loadingExpenses ? (
                <div className="p-6">
                  <Skeleton className="h-32 w-full" />
                </div>
              ) : expenses.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
                  <Receipt className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">Aucune dépense enregistrée</p>
                  <p className="text-xs text-muted-foreground">
                    Tracez vos charges de transport, carburant, électricité ou manutention.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Catégorie</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Justificatif</TableHead>
                      <TableHead>Opérateur</TableHead>
                      <TableHead className="text-right">Montant</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expenses.map((ex) => (
                      <TableRow key={ex.id}>
                        <TableCell className="font-mono text-xs tabular-nums whitespace-nowrap">
                          {ex.expenseDate}
                        </TableCell>
                        <TableCell className="text-xs font-medium">{ex.categoryName}</TableCell>
                        <TableCell className="text-sm">{ex.description}</TableCell>
                        <TableCell className="text-xs">
                          {PAYMENT_METHOD_LABELS[ex.paymentMethod]}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {ex.receiptReference ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{ex.userName}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                          -{formatFCFA(ex.amountXof)}
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

      <OpenSessionDialog
        open={openSessionModal}
        onOpenChange={setOpenSessionModal}
        registers={overview?.registers ?? []}
      />

      <CloseSessionDialog
        session={activeSession}
        open={closeSessionModal}
        onOpenChange={setCloseSessionModal}
      />

      <ManualMovementDialog
        session={activeSession}
        open={manualMoveModal}
        onOpenChange={setManualMoveModal}
      />

      <ExpenseDialog
        open={expenseModal}
        onOpenChange={setExpenseModal}
        categories={categories}
      />

      <SessionDetailDialog
        sessionId={detailSessionId}
        open={Boolean(detailSessionId)}
        onOpenChange={(v) => {
          if (!v) setDetailSessionId(null);
        }}
        canOverride={canOverrideCash}
      />
    </div>
  );
}
