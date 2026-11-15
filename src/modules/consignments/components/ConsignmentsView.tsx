import { useState } from 'react';
import { ArrowLeftRight, Boxes, Plus, Undo2 } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
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
import type { AuthenticatedUser } from '@/src/types/auth';
import type { ConsignmentBalance } from '@/src/types/consignment';
import {
  CONSIGNMENT_MOVEMENT_LABELS,
  PACKAGING_KIND_LABELS,
  useConsignmentBalances,
  useConsignmentMovements,
  useConsignmentSummary,
} from '../services/consignmentService';
import { ConsignmentOperationDialog } from './ConsignmentOperationDialog';
import { CustomerReturnDialog } from './CustomerReturnDialog';

interface ConsignmentsViewProps {
  currentUser: AuthenticatedUser;
}

export function ConsignmentsView({ currentUser }: ConsignmentsViewProps) {
  const canManage = currentUser.permissions.includes('consignment.manage');

  const [activeTab, setActiveTab] = useState<'CUSTOMER' | 'SUPPLIER' | 'DEPOT' | 'MOVEMENTS'>(
    'CUSTOMER'
  );
  const [kindFilter, setKindFilter] = useState<'ALL' | 'BOTTLE' | 'CRATE'>('ALL');
  const [opDialogOpen, setOpDialogOpen] = useState(false);
  const [returnBalance, setReturnBalance] = useState<ConsignmentBalance | null>(null);

  const { data: summary } = useConsignmentSummary();
  const { data: balances = [], isLoading: loadingBalances } = useConsignmentBalances({
    holderType: activeTab === 'MOVEMENTS' ? undefined : activeTab,
    kind: kindFilter === 'ALL' ? undefined : kindFilter,
    onlyNonZero: true,
  });
  const { data: movements = [], isLoading: loadingMovements } = useConsignmentMovements({
    limit: 120,
  });

  const defaultScope: 'CUSTOMER' | 'SUPPLIER' | 'DEPOT' =
    activeTab === 'SUPPLIER' ? 'SUPPLIER' : activeTab === 'DEPOT' ? 'DEPOT' : 'CUSTOMER';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Consignes &amp; Emballages vides
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Suivi distinct des bouteilles vides, casiers vides, consignes clients/fournisseurs, retours et remboursements.
          </p>
        </div>

        {canManage && (
          <Button variant="accent" onClick={() => setOpDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            Nouveau mouvement consigne
          </Button>
        )}
      </div>

      {/* KPIs strictement séparés du stock de boissons pleines et des créances commerciales */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Bouteilles vides au dépôt</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {summary?.depotBottlesQty ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Casiers vides au dépôt</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {summary?.depotCratesQty ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Emballages détenus par clients</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums text-amber-700 dark:text-amber-400">
              {summary?.customerQty ?? 0} · {formatFCFA(summary?.customerValueXof ?? 0)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Emballages dus aux fournisseurs</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {summary?.supplierQty ?? 0} · {formatFCFA(summary?.supplierValueXof ?? 0)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 overflow-x-auto">
              {(
                [
                  ['CUSTOMER', 'Soldes Clients'],
                  ['SUPPLIER', 'Soldes Fournisseurs'],
                  ['DEPOT', 'Vides au Dépôt'],
                  ['MOVEMENTS', 'Journal des mouvements'],
                ] as const
              ).map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => setActiveTab(tabKey)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                    activeTab === tabKey
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeTab !== 'MOVEMENTS' && (
              <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 self-start">
                {(
                  [
                    ['ALL', 'Tous types'],
                    ['BOTTLE', 'Bouteilles'],
                    ['CRATE', 'Casiers'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKindFilter(k)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                      kindFilter === k
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {activeTab === 'MOVEMENTS' ? (
            loadingMovements ? (
              <div className="space-y-2 p-6">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : movements.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
                <ArrowLeftRight className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">Aucun mouvement de consigne journalisé</p>
                <p className="text-xs text-muted-foreground">
                  Les consignes facturées au POS, retours clients et mouvements dépôt apparaîtront ici.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Opération</TableHead>
                    <TableHead>Tiers / Dépôt</TableHead>
                    <TableHead>Emballage</TableHead>
                    <TableHead className="text-right">Variation qté</TableHead>
                    <TableHead className="text-right">Valeur consigne</TableHead>
                    <TableHead>Note &amp; Opérateur</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.map((mov) => (
                    <TableRow key={mov.id}>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                        {formatDateTimeFr(mov.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs font-medium">
                        {CONSIGNMENT_MOVEMENT_LABELS[mov.movementType]}
                      </TableCell>
                      <TableCell className="text-sm">{mov.holderName}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {mov.packagingName} · {PACKAGING_KIND_LABELS[mov.packagingKind]}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono text-xs font-semibold tabular-nums ${
                          mov.quantityDelta > 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {mov.quantityDelta > 0 ? `+${mov.quantityDelta}` : mov.quantityDelta}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {formatFCFA(mov.amountXof)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <div>{mov.note ?? '—'}</div>
                        <div className="text-[11px]">{mov.userName}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          ) : loadingBalances ? (
            <div className="space-y-2 p-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : balances.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-10 text-center">
              <Boxes className="h-8 w-8 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  Aucun solde d’emballage actif dans cette vue
                </p>
                <p className="text-xs text-muted-foreground">
                  Enregistrez une consigne client, une réception fournisseur ou un stock vide dépôt.
                </p>
              </div>
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => setOpDialogOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Ajouter un mouvement
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Titulaire</TableHead>
                  <TableHead>Emballage</TableHead>
                  <TableHead>Catégorie</TableHead>
                  <TableHead className="text-right">Quantité</TableHead>
                  <TableHead className="text-right">Tarif unitaire</TableHead>
                  <TableHead className="text-right">Valeur totale</TableHead>
                  {activeTab === 'CUSTOMER' && canManage && (
                    <TableHead className="text-right">Action</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.map((bal) => (
                  <TableRow key={bal.id}>
                    <TableCell className="font-medium">{bal.holderName}</TableCell>
                    <TableCell>
                      <div>{bal.packagingName}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {bal.packagingCode}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {PACKAGING_KIND_LABELS[bal.packagingKind]}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold tabular-nums">
                      {bal.quantity}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatFCFA(bal.depositAmountXof)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                      {formatFCFA(bal.depositValueXof)}
                    </TableCell>
                    {activeTab === 'CUSTOMER' && canManage && (
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="accent"
                          onClick={() => setReturnBalance(bal)}
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                          Retour / Remb.
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConsignmentOperationDialog
        open={opDialogOpen}
        onOpenChange={setOpDialogOpen}
        defaultScope={defaultScope}
      />

      <CustomerReturnDialog
        balance={returnBalance}
        open={Boolean(returnBalance)}
        onOpenChange={(open) => {
          if (!open) setReturnBalance(null);
        }}
      />
    </div>
  );
}
