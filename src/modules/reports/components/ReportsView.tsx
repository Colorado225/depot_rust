import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, Download, FileSpreadsheet, FileText } from 'lucide-react';
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
import { downloadReportExport } from '@/src/lib/ipc';
import { formatFCFA } from '@/src/lib/money';
import type { AuthenticatedUser } from '@/src/types/auth';
import type { ReportDataset } from '@/src/types/reports';
import {
  REPORT_DATASET_LABELS,
  useBalanceSnapshot,
  useDailySeries,
  useProductMargins,
  useReportsOverview,
} from '../services/reportsService';

interface ReportsViewProps {
  currentUser: AuthenticatedUser;
}

export function ReportsView({ currentUser }: ReportsViewProps) {
  const canViewReports = currentUser.permissions.includes('reports.view');

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [exportDataset, setExportDataset] = useState<ReportDataset>('margins');
  const [exportingFormat, setExportingFormat] = useState<'csv' | 'pdf' | null>(null);

  const range = {
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  };

  const { data: overview, isLoading: loadingOverview } = useReportsOverview(range);
  const { data: productMargins = [], isLoading: loadingMargins } = useProductMargins(range);
  const { data: snapshot, isLoading: loadingSnapshot } = useBalanceSnapshot();
  const { data: dailySeries = [] } = useDailySeries(range);

  if (!canViewReports) {
    return (
      <AccessDeniedCard
        requiredPermission="reports.view"
        userRoleName={currentUser.roleName}
      />
    );
  }

  const applyPreset = (preset: 'ALL' | 'TODAY' | 'WEEK' | 'MONTH') => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (preset === 'ALL') {
      setStartDate('');
      setEndDate('');
    } else if (preset === 'TODAY') {
      setStartDate(today);
      setEndDate(today);
    } else if (preset === 'WEEK') {
      const prev = new Date(now.getTime() - 6 * 86400_000).toISOString().slice(0, 10);
      setStartDate(prev);
      setEndDate(today);
    } else {
      const monthStart = `${today.slice(0, 7)}-01`;
      setStartDate(monthStart);
      setEndDate(today);
    }
  };

  const handleExport = async (format: 'csv' | 'pdf') => {
    setExportingFormat(format);
    try {
      const filename = await downloadReportExport({
        format,
        dataset: exportDataset,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      toast.success(`Export téléchargé : ${filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'export");
    } finally {
      setExportingFormat(null);
    }
  };

  const marginRateFormatted = overview
    ? `${(overview.grossMarginRateTenths / 10).toFixed(1)}%`
    : '0.0%';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Rapports &amp; Analyse CUMP
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Marges brutes calculées sur le CUMP réel, état des créances/dettes/consignes et exports CSV/PDF alignés sur les écritures.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56">
            <Select
              value={exportDataset}
              onValueChange={(v) => setExportDataset(v as ReportDataset)}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REPORT_DATASET_LABELS) as ReportDataset[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {REPORT_DATASET_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={exportingFormat !== null}
            onClick={() => void handleExport('csv')}
          >
            <FileSpreadsheet className="h-4 w-4" />
            {exportingFormat === 'csv' ? 'Export...' : 'Exporter CSV'}
          </Button>
          <Button
            variant="accent"
            size="sm"
            disabled={exportingFormat !== null}
            onClick={() => void handleExport('pdf')}
          >
            <FileText className="h-4 w-4" />
            {exportingFormat === 'pdf' ? 'Export...' : 'Exporter PDF'}
          </Button>
        </div>
      </div>

      {/* Filtre de période */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-md">
            <div className="space-y-1">
              <Label htmlFor="rep-start" className="text-xs">
                Du
              </Label>
              <Input
                id="rep-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 font-mono text-xs tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rep-end" className="text-xs">
                Au
              </Label>
              <Input
                id="rep-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9 font-mono text-xs tabular-nums"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => applyPreset('TODAY')}>
              Aujourd’hui
            </Button>
            <Button size="sm" variant="outline" onClick={() => applyPreset('WEEK')}>
              7 jours
            </Button>
            <Button size="sm" variant="outline" onClick={() => applyPreset('MONTH')}>
              Mois en cours
            </Button>
            <Button size="sm" variant="outline" onClick={() => applyPreset('ALL')}>
              Tout l’historique
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* KPIs majeurs */}
      {loadingOverview || !overview ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Chiffre d’affaires net (liquide)</CardDescription>
              <CardTitle className="font-mono text-2xl tabular-nums">
                {formatFCFA(overview.salesRevenueXof)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {overview.salesCount} vente{overview.salesCount > 1 ? 's' : ''} validée
              {overview.salesCount > 1 ? 's' : ''} (hors consignes &amp; annulées)
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Marge brute réelle (CA - CUMP)</CardDescription>
              <CardTitle className="font-mono text-2xl tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatFCFA(overview.grossMarginXof)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              Taux de marge : <span className="font-mono font-semibold">{marginRateFormatted}</span> · COGS{' '}
              <span className="font-mono">{formatFCFA(overview.cogsXof)}</span>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Résultat d’exploitation estimé</CardDescription>
              <CardTitle
                className={`font-mono text-2xl tabular-nums ${
                  overview.operatingResultXof >= 0
                    ? 'text-foreground'
                    : 'text-destructive'
                }`}
              >
                {formatFCFA(overview.operatingResultXof)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              Marge - Dépenses ({formatFCFA(overview.expensesXof)}) - Casse/Pertes (
              {formatFCFA(overview.breakageLossCostXof)})
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Valorisation Stock (CUMP)</CardDescription>
              <CardTitle className="font-mono text-2xl tabular-nums">
                {formatFCFA(snapshot?.totalStockValuationXof ?? 0)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {snapshot?.activeProductsCount ?? 0} produits actifs ·{' '}
              {snapshot?.lowStockProductsCount ?? 0} sous seuil
            </CardContent>
          </Card>
        </div>
      )}

      {/* Graphique journalier */}
      {dailySeries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Évolution journalière : Ventes, Coût CUMP et Marge Brute
            </CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailySeries} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(value: unknown) => formatFCFA(Number(value) || 0)}
                />
                <Bar dataKey="salesRevenueXof" name="CA Net" fill="#0f766e" radius={[3, 3, 0, 0]} />
                <Bar dataKey="cogsXof" name="Coût CUMP" fill="#64748b" radius={[3, 3, 0, 0]} />
                <Bar dataKey="grossMarginXof" name="Marge Brute" fill="#d97706" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="margins">
        <TabsList>
          <TabsTrigger value="margins">Marges par produit ({productMargins.length})</TabsTrigger>
          <TabsTrigger value="balances">Créances, Dettes &amp; Consignes</TabsTrigger>
          <TabsTrigger value="pnl">Compte d’exploitation</TabsTrigger>
        </TabsList>

        {/* Onglet 1 : Marges réelles CUMP par produit */}
        <TabsContent value="margins">
          <Card>
            <CardContent className="p-0">
              {loadingMargins ? (
                <div className="p-6">
                  <Skeleton className="h-36 w-full" />
                </div>
              ) : productMargins.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
                  <Download className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">Aucune vente ni stock valorisé sur cette période</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produit</TableHead>
                      <TableHead>Catégorie</TableHead>
                      <TableHead className="text-right">Qté vendue (base)</TableHead>
                      <TableHead className="text-right">CA Brut</TableHead>
                      <TableHead className="text-right">Coût CUMP</TableHead>
                      <TableHead className="text-right">Marge brute</TableHead>
                      <TableHead className="text-right">Taux</TableHead>
                      <TableHead className="text-right">Stock valorisé CUMP</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {productMargins.map((row) => (
                      <TableRow key={row.productId}>
                        <TableCell>
                          <div className="font-medium text-foreground">{row.productName}</div>
                          <div className="font-mono text-xs text-muted-foreground">{row.sku}</div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {row.categoryName}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {row.qtySoldBase}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatFCFA(row.grossSalesXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {formatFCFA(row.cogsXof)}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono text-xs font-semibold tabular-nums ${
                            row.grossMarginXof >= 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-destructive'
                          }`}
                        >
                          {formatFCFA(row.grossMarginXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {(row.marginRateTenths / 10).toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          <div>{formatFCFA(row.stockValuationCumpXof)}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {row.currentStockBase} u · CUMP {formatFCFA(row.weightedAvgCostXof)}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Onglet 2 : Créances, Dettes et Consignes séparées */}
        <TabsContent value="balances" className="space-y-4">
          {loadingSnapshot || !snapshot ? (
            <Skeleton className="h-44 w-full" />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Créances commerciales clients</CardDescription>
                    <CardTitle className="font-mono text-xl tabular-nums text-amber-700 dark:text-amber-400">
                      {formatFCFA(snapshot.totalCustomerReceivablesXof)}
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Dettes commerciales fournisseurs</CardDescription>
                    <CardTitle className="font-mono text-xl tabular-nums">
                      {formatFCFA(snapshot.totalSupplierPayablesXof)}
                    </CardTitle>
                  </CardHeader>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Consignes clients (distinctes des créances)</CardDescription>
                    <CardTitle className="font-mono text-xl tabular-nums">
                      {snapshot.customerConsignmentQty} u ·{' '}
                      {formatFCFA(snapshot.customerConsignmentValueXof)}
                    </CardTitle>
                  </CardHeader>
                </Card>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Clients débiteurs &amp; consignes ({snapshot.topDebtors.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {snapshot.topDebtors.length === 0 ? (
                      <div className="p-6 text-center text-sm text-muted-foreground">
                        Aucune créance ni consigne client active.
                      </div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Client</TableHead>
                            <TableHead className="text-right">Créance commerciale</TableHead>
                            <TableHead className="text-right">Consignes</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {snapshot.topDebtors.map((d) => (
                            <TableRow key={d.id}>
                              <TableCell>
                                <div className="font-medium">{d.fullName}</div>
                                <div className="font-mono text-xs text-muted-foreground">
                                  {d.phone ?? '—'}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                                {formatFCFA(d.commercialDebtXof)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs tabular-nums">
                                {formatFCFA(d.consignmentBalanceXof)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Fournisseurs à régler ({snapshot.topCreditors.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {snapshot.topCreditors.length === 0 ? (
                      <div className="p-6 text-center text-sm text-muted-foreground">
                        Aucune dette fournisseur en cours.
                      </div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Fournisseur</TableHead>
                            <TableHead className="text-right">Dette due</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {snapshot.topCreditors.map((s) => (
                            <TableRow key={s.id}>
                              <TableCell>
                                <div className="font-medium">{s.name}</div>
                                <div className="font-mono text-xs text-muted-foreground">
                                  {s.phone ?? '—'}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                                {formatFCFA(s.balanceDueXof)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* Onglet 3 : Compte d'exploitation simplifié */}
        <TabsContent value="pnl">
          {overview && (
            <Card className="max-w-2xl">
              <CardHeader>
                <CardTitle className="text-base">Synthèse d’exploitation vérifiée</CardTitle>
                <CardDescription>
                  Calculée directement sur les ventes validées, le CUMP historique des sorties, les dépenses et la casse/perte.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border text-sm">
                  <div className="flex justify-between px-6 py-3">
                    <span>Chiffre d’affaires brut ventes validées</span>
                    <span className="font-mono tabular-nums">
                      {formatFCFA(overview.salesGrossSubtotalXof)}
                    </span>
                  </div>
                  <div className="flex justify-between px-6 py-3 text-muted-foreground">
                    <span>Remises accordées au POS (-)</span>
                    <span className="font-mono tabular-nums">
                      -{formatFCFA(overview.salesDiscountXof)}
                    </span>
                  </div>
                  <div className="flex justify-between px-6 py-3 font-medium">
                    <span>Chiffre d’affaires net liquide</span>
                    <span className="font-mono tabular-nums">{formatFCFA(overview.salesRevenueXof)}</span>
                  </div>
                  <div className="flex justify-between px-6 py-3 text-muted-foreground">
                    <span>Coût d’achat réel CUMP des marchandises vendues (-)</span>
                    <span className="font-mono tabular-nums">-{formatFCFA(overview.cogsXof)}</span>
                  </div>
                  <div className="flex justify-between px-6 py-3 font-semibold text-emerald-700 dark:text-emerald-400">
                    <span>Marge brute commerciale ({marginRateFormatted})</span>
                    <span className="font-mono tabular-nums">{formatFCFA(overview.grossMarginXof)}</span>
                  </div>
                  <div className="flex justify-between px-6 py-3 text-muted-foreground">
                    <span>Dépenses opérationnelles de la période (-)</span>
                    <span className="font-mono tabular-nums">-{formatFCFA(overview.expensesXof)}</span>
                  </div>
                  <div className="flex justify-between px-6 py-3 text-muted-foreground">
                    <span>Casse &amp; pertes stock valorisées au CUMP (-)</span>
                    <span className="font-mono tabular-nums">
                      -{formatFCFA(overview.breakageLossCostXof)}
                    </span>
                  </div>
                  <div className="flex justify-between bg-secondary/40 px-6 py-3.5 font-bold">
                    <span>Résultat d’exploitation estimé</span>
                    <span className="font-mono tabular-nums">
                      {formatFCFA(overview.operatingResultXof)}
                    </span>
                  </div>
                  <div className="flex justify-between px-6 py-2.5 text-xs text-muted-foreground">
                    <span>Pour mémoire — Consignes facturées sur ventes (non comptées en CA)</span>
                    <span className="font-mono tabular-nums">
                      {formatFCFA(overview.consignmentOnSalesXof)}
                    </span>
                  </div>
                  <div className="flex justify-between px-6 py-2.5 text-xs text-muted-foreground">
                    <span>
                      Pour mémoire — Ventes annulées ({overview.cancelledSalesCount})
                    </span>
                    <span className="font-mono tabular-nums">
                      {formatFCFA(overview.cancelledAmountXof)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
