import { useState } from 'react';
import {
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Separator } from '@/src/components/ui/separator';
import { Skeleton } from '@/src/components/ui/skeleton';
import { formatBytes, formatDateTimeFr, formatFCFA } from '@/src/lib/money';
import type { IntegrityCheckResult } from '@/src/types/system';
import { useIntegrityCheck, useSystemHealth } from '../services/systemService';

export function SystemOverviewView() {
  const { data: health, isLoading, isError, error, refetch, isFetching } = useSystemHealth();
  const integrityMutation = useIntegrityCheck();
  const [lastIntegrity, setLastIntegrity] = useState<IntegrityCheckResult | null>(null);

  const handleRunIntegrity = async () => {
    try {
      const result = await integrityMutation.mutateAsync();
      setLastIntegrity(result);
      if (result.status === 'OK') {
        toast.success(`Intégrité SQLite vérifiée (${result.durationMs} ms)`);
      } else {
        toast.error(`Anomalie détectée : ${result.rawResult}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de la vérification d'intégrité");
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Skeleton key={idx} className="h-28 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !health) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <XCircle className="h-5 w-5" />
            Impossible de joindre la base locale SQLite
          </CardTitle>
          <CardDescription>
            {error instanceof Error ? error.message : 'Erreur de communication avec le moteur local.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => void refetch()} variant="outline">
            <RefreshCw className="h-4 w-4" />
            Réessayer la connexion
          </Button>
        </CardContent>
      </Card>
    );
  }

  const runtimeLabel =
    health.runtime === 'TAURI_RUST_SQLX'
      ? 'Desktop Tauri 2 (Rust / SQLx)'
      : 'Serveur local Node.js / SQLite (Pont IPC)';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Socle technique &amp; Diagnostic système
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            LOT 0 — Fondations · Devise FCFA ({formatFCFA(1000).replace('1 000 ', '')}) · Fonctionnement hors ligne vérifié
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            Actualiser
          </Button>
          <Button
            variant="accent"
            onClick={() => void handleRunIntegrity()}
            disabled={integrityMutation.isPending}
          >
            <ShieldCheck className="h-4 w-4" />
            {integrityMutation.isPending ? 'Vérification...' : 'Vérifier intégrité SQLite'}
          </Button>
        </div>
      </div>

      {/* Grille KPI 4 colonnes : données réelles SQLite */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Moteur SQLite &amp; Journal</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              v{health.sqliteVersion}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              Mode {health.journalMode} actif
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Intégrité référentielle</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {health.foreignKeysEnabled ? 'ACTIVÉE' : 'INACTIVE'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              PRAGMA foreign_keys = {health.foreignKeysEnabled ? 'ON' : 'OFF'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Schéma &amp; Migrations SQL</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {health.tablesCount} tables
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground tabular-nums">
              {health.appliedMigrationsCount} migrations versionnées appliquées
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Stockage local persistant</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {formatBytes(health.dbSizeBytes)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Base locale autonome sans dépendance réseau
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Panneau détails d'exécution et résultat quick_check */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              Environnement d&apos;exécution local
            </CardTitle>
            <CardDescription>
              Paramètres vérifiés en temps réel auprès du moteur de persistance local.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Application</p>
                <p className="font-medium text-foreground">
                  {health.appName} · v{health.version}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Runtime actif</p>
                <p className="font-medium text-foreground">{runtimeLabel}</p>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <p className="text-xs text-muted-foreground">Emplacement du fichier SQLite</p>
                <p className="break-all font-mono text-xs text-foreground">{health.dbPath}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Lot d&apos;exécution courant</p>
                <p className="font-mono text-sm font-medium text-foreground">{health.currentLot}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Dernière vérification</p>
                <p className="font-mono text-xs tabular-nums text-foreground">
                  {formatDateTimeFr(health.checkedAt)}
                </p>
              </div>
            </div>

            {lastIntegrity && (
              <>
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-sm">
                  <div className="flex items-center gap-2">
                    {lastIntegrity.status === 'OK' ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive" />
                    )}
                    <span className="font-medium">
                      Contrôle PRAGMA quick_check : {lastIntegrity.rawResult}
                    </span>
                  </div>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {lastIntegrity.durationMs} ms · {formatDateTimeFr(lastIntegrity.checkedAt)}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              Garanties financières &amp; Stock
            </CardTitle>
            <CardDescription>
              Règles fondamentales verrouillées dès le LOT 0.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p className="text-muted-foreground">
                Montants XOF stockés exclusivement en entiers <span className="font-mono text-foreground">INTEGER</span> sans flottants.
              </p>
            </div>
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p className="text-muted-foreground">
                Séparation en schéma entre stock commercial, bouteilles/casiers consignés et créances clients.
              </p>
            </div>
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p className="text-muted-foreground">
                Suppression physique interdite sur toutes les opérations validées (<span className="font-mono text-foreground">ON DELETE RESTRICT</span>).
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
