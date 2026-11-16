import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  DatabaseBackup,
  Download,
  HardDrive,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  Usb,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { AccessDeniedCard } from '@/src/components/AccessDeniedCard';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/src/components/ui/dialog';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import { Skeleton } from '@/src/components/ui/skeleton';
import { Switch } from '@/src/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/src/components/ui/table';
import { downloadBackupFile } from '@/src/lib/ipc';
import { formatBytes, formatDateTimeFr } from '@/src/lib/money';
import type { AuthenticatedUser } from '@/src/types/auth';
import {
  BACKUP_TYPE_LABELS,
  type BackupConfig,
  type BackupHistoryEntry,
  type ReliabilityDiagnostics,
  type RestorePlan,
} from '@/src/types/backup';
import type { SelfTestReport } from '@/src/types/system';
import {
  useBackupDiagnostics,
  useBackupOverview,
  useCancelPendingRestore,
  useCreateBackup,
  useImportBackup,
  useLot9SelfTest,
  useRestoreBackup,
  useRunAutoBackup,
  useUpdateBackupConfig,
  useVerifyBackup,
} from '../services/backupService';

const RESTORE_CONFIRMATION = 'RESTAURER';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Une erreur inattendue est survenue.';
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
      <XCircle className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

export function BackupRestoreView({ currentUser }: { currentUser: AuthenticatedUser }) {
  const allowed = currentUser.permissions.includes('backup.manage');
  const { data, isLoading, isError, error, refetch, isFetching } = useBackupOverview();
  const createBackup = useCreateBackup();
  const importBackup = useImportBackup();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runAutoBackup = useRunAutoBackup();
  const updateConfig = useUpdateBackupConfig();
  const verifyBackup = useVerifyBackup();
  const restoreBackup = useRestoreBackup();
  const cancelRestore = useCancelPendingRestore();
  const diagnosticsMutation = useBackupDiagnostics();
  const selfTestMutation = useLot9SelfTest();

  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupHistoryEntry | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [diagnostics, setDiagnostics] = useState<ReliabilityDiagnostics | null>(null);
  const [selfTest, setSelfTest] = useState<SelfTestReport | null>(null);
  const [lastPlan, setLastPlan] = useState<RestorePlan | null>(null);

  useEffect(() => {
    if (data?.config) {
      setConfig({
        autoEnabled: data.config.autoEnabled,
        autoIntervalHours: data.config.autoIntervalHours,
        retentionCount: data.config.retentionCount,
      });
    }
  }, [data?.config]);

  if (!allowed) {
    return (
      <AccessDeniedCard
        requiredPermission="backup.manage"
        userRoleName={currentUser.roleName}
      />
    );
  }

  const handleCreate = async (type: 'MANUAL' | 'USB_EXPORT') => {
    try {
      const entry = await createBackup.mutateAsync(type);
      if (type === 'USB_EXPORT') {
        const filename = await downloadBackupFile(entry.id);
        toast.success(`Sauvegarde créée et téléchargée : ${filename}`);
        toast.info('Copiez ce fichier .db sur votre clé USB, hors connexion.');
      } else {
        toast.success(`Sauvegarde vérifiée (${formatBytes(entry.fileSizeBytes)})`);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const entry = await importBackup.mutateAsync(file);
      toast.success(`Sauvegarde importée et vérifiée : ${entry.fileName}`);
      toast.info('Vous pouvez maintenant la restaurer depuis l’historique.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownload = async (entry: BackupHistoryEntry) => {
    try {
      const filename = await downloadBackupFile(entry.id);
      toast.success(`Téléchargement vérifié : ${filename}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleVerify = async (entry: BackupHistoryEntry) => {
    try {
      const result = await verifyBackup.mutateAsync(entry.id);
      if (result.status === 'OK') {
        toast.success(`Intégrité confirmée (${result.tablesCount} tables, SHA-256 identique)`);
      } else {
        toast.error(`Sauvegarde invalide : ${result.reason ?? 'contrôle échoué'}`);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    try {
      const plan = await restoreBackup.mutateAsync({
        id: restoreTarget.id,
        confirmation,
        activateOnRestart: true,
      });
      setLastPlan(plan);
      setRestoreTarget(null);
      setConfirmation('');
      toast.success(plan.message);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleSaveConfig = async () => {
    if (!config) return;
    try {
      await updateConfig.mutateAsync(config);
      toast.success('Configuration des sauvegardes enregistrée');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleDiagnostics = async () => {
    try {
      const result = await diagnosticsMutation.mutateAsync();
      setDiagnostics(result);
      toast[result.overall === 'OK' ? 'success' : 'error'](
        result.overall === 'OK'
          ? `Diagnostic complet conforme (${result.durationMs} ms)`
          : 'Anomalie détectée par le diagnostic'
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleSelfTest = async () => {
    try {
      const result = await selfTestMutation.mutateAsync();
      setSelfTest(result);
      toast[result.allPassed ? 'success' : 'error'](
        result.allPassed ? 'Tous les tests de non-régression LOT 9 ont réussi' : 'Un contrôle LOT 9 a échoué'
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const handleCancelRestore = async () => {
    try {
      const result = await cancelRestore.mutateAsync();
      toast[result.cancelled ? 'success' : 'info'](
        result.cancelled ? 'Restauration programmée annulée' : 'Aucune restauration en attente'
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Service de sauvegarde indisponible</CardTitle>
          <CardDescription>{errorMessage(error)}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void refetch()}>
            <RefreshCw className="h-4 w-4" />
            Réessayer
          </Button>
        </CardContent>
      </Card>
    );
  }

  const pending = data.pendingRestore;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Sauvegardes, Restauration &amp; Fiabilisation
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            LOT 9 · Instantanés SQLite cohérents WAL, empreinte SHA-256, restauration vérifiée sur base séparée · manifestes scellés HMAC (LOT 11) · 100 % hors ligne
          </p>
        </div>
        <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {/* LOT 11 — un marqueur de restauration non authentifié est signalé ici :
          l'aperçu reste consultable, l'activation est refusée au démarrage. */}
      {data.pendingRestoreRejectedReason && (
        <Card className="border-destructive/60 bg-destructive/5">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-4 w-4" />
              Marqueur de restauration refusé (sécurité LOT 11)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{data.pendingRestoreRejectedReason}</p>
            <p className="text-xs text-muted-foreground">
              Aucune base n&apos;a été remplacée. Supprimez
              <code className="mx-1 rounded bg-muted px-1">restore-pending.json</code>
              du dossier de données pour démarrer normalement.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Indicateurs */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Sauvegardes enregistrées</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{data.totalBackups}</p>
            <p className="mt-1 text-xs text-muted-foreground">Volume total {formatBytes(data.totalBytes)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Dernière sauvegarde</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">{formatDateTimeFr(data.lastBackupAt)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Auto : {formatDateTimeFr(data.lastAutoBackupAt)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Dernière restauration</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">{formatDateTimeFr(data.lastRestoreAt)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Activation au redémarrage</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Emplacement local</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="break-all font-mono text-xs text-foreground">{data.backupsDir}</p>
            <p className="mt-1 text-xs text-muted-foreground">Aucun envoi sur un serveur distant</p>
          </CardContent>
        </Card>
      </div>

      {/* Restauration en attente */}
      {pending && (
        <Card className="border-amber-500/60 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" />
              Restauration programmée au prochain démarrage
            </CardTitle>
            <CardDescription>
              Sauvegarde « {pending.backupId.slice(0, 8)}… » préparée le {formatDateTimeFr(pending.createdAt)}.
              La base actuelle reste intacte tant que l&apos;application n&apos;a pas été redémarrée.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Fermez puis relancez DepotPro CI hors connexion pour activer la restauration. Une copie
              de sécurité de la base actuelle est conservée automatiquement.
            </p>
            <Button variant="outline" onClick={() => void handleCancelRestore()} disabled={cancelRestore.isPending}>
              <Trash2 className="h-4 w-4" />
              Annuler la restauration
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Actions principales */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DatabaseBackup className="h-5 w-5" />
              Sauvegarde manuelle &amp; export USB
            </CardTitle>
            <CardDescription>
              VACUUM INTO produit une copie compactée incluant toutes les écritures WAL validées.
              Chaque fichier est contrôlé (integrity_check, foreign_key_check), signé par une
              empreinte SHA-256 et accompagné d&apos;un manifeste JSON vérifiable hors ligne.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="accent"
                onClick={() => void handleCreate('MANUAL')}
                disabled={createBackup.isPending}
              >
                <DatabaseBackup className="h-4 w-4" />
                {createBackup.isPending ? 'Sauvegarde...' : 'Créer une sauvegarde'}
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleCreate('USB_EXPORT')}
                disabled={createBackup.isPending}
              >
                <Usb className="h-4 w-4" />
                Exporter pour clé USB
              </Button>
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={importBackup.isPending}
              >
                <Upload className="h-4 w-4" />
                {importBackup.isPending ? 'Import...' : 'Importer un .db'}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".db,application/x-sqlite3,application/octet-stream"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportFile(file);
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Import d&apos;une sauvegarde provenant d&apos;une clé USB ou d&apos;un autre poste :
              le fichier est contrôlé avant d&apos;apparaître dans l&apos;historique (256 Mo maximum).
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Sauvegarde automatique
            </CardTitle>
            <CardDescription>
              Exécutée localement au démarrage puis à intervalles réguliers, sans réseau. Seules les
              copies automatiques surnuméraires sont purgées ; aucune écriture commerciale n&apos;est supprimée.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="backup-auto-enabled">Activer la sauvegarde automatique</Label>
              <Switch
                id="backup-auto-enabled"
                checked={config?.autoEnabled ?? false}
                onCheckedChange={(checked) =>
                  setConfig((c) => (c ? { ...c, autoEnabled: checked } : c))
                }
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="backup-interval">Intervalle (heures)</Label>
                <Input
                  id="backup-interval"
                  type="number"
                  min={1}
                  max={720}
                  value={config?.autoIntervalHours ?? 24}
                  onChange={(e) =>
                    setConfig((c) =>
                      c ? { ...c, autoIntervalHours: Number(e.target.value) || 1 } : c
                    )
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="backup-retention">Copies conservées</Label>
                <Input
                  id="backup-retention"
                  type="number"
                  min={1}
                  max={365}
                  value={config?.retentionCount ?? 7}
                  onChange={(e) =>
                    setConfig((c) => (c ? { ...c, retentionCount: Number(e.target.value) || 1 } : c))
                  }
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void handleSaveConfig()} disabled={updateConfig.isPending || !config}>
                Enregistrer la configuration
              </Button>
              <Button variant="ghost" onClick={() => void runAutoBackup.mutateAsync().then(() => toast.success('Sauvegarde automatique exécutée')).catch((err: unknown) => toast.error(errorMessage(err)))} disabled={runAutoBackup.isPending}>
                <Play className="h-4 w-4" />
                Exécuter maintenant
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Contrôles */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Intégrité, sécurité &amp; non-régression
          </CardTitle>
          <CardDescription>
            Contrôles réels exécutés sur la base locale : schéma, migrations SHA-256, références
            orphelines, montants XOF entiers, stocks négatifs, droits et atomicité transactionnelle.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void handleDiagnostics()} disabled={diagnosticsMutation.isPending}>
              <Activity className="h-4 w-4" />
              Diagnostic complet
            </Button>
            <Button variant="outline" onClick={() => void handleSelfTest()} disabled={selfTestMutation.isPending}>
              <ShieldCheck className="h-4 w-4" />
              Tests LOT 9
            </Button>
          </div>

          {diagnostics && (
            <div className="space-y-3 rounded-md border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusPill ok={diagnostics.overall === 'OK'} label={diagnostics.overall === 'OK' ? 'Base conforme' : 'Anomalie détectée'} />
                <span className="font-mono text-xs text-muted-foreground">
                  {formatDateTimeFr(diagnostics.checkedAt)} · {diagnostics.durationMs} ms · {diagnostics.tablesCount} tables
                </span>
              </div>
              <div className="divide-y divide-border rounded-md border border-border">
                {diagnostics.checks.map((check) => (
                  <div key={check.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <span className="flex items-center gap-2 text-sm">
                      {check.status === 'OK' ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                      )}
                      {check.label}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{check.details}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {selfTest && (
            <div className="rounded-md border border-border p-4">
              <StatusPill ok={selfTest.allPassed} label={selfTest.allPassed ? 'Non-régression LOT 9 validée' : 'Échec de non-régression'} />
              <p className="mt-2 text-xs text-muted-foreground">
                {selfTest.checks.filter((c) => c.passed).length}/{selfTest.checks.length} contrôles réussis · {formatDateTimeFr(selfTest.executedAt)}
              </p>
            </div>
          )}

          {lastPlan && (
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm">
              <p className="font-medium text-foreground">Dernière restauration préparée</p>
              <p className="mt-1 text-muted-foreground">{lastPlan.message}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {lastPlan.rowsBefore.products} produit(s) avant → {lastPlan.rowsAfter.products} après · {lastPlan.migrationsAppliedOnStaged} migration(s) appliquée(s) sur la copie
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Historique */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            Historique des sauvegardes
          </CardTitle>
          <CardDescription>
            Chaque opération est journalisée dans audit_logs. Une sauvegarde altérée ne peut être ni
            téléchargée ni restaurée.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.backups.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Aucune sauvegarde pour l&apos;instant. Créez-en une avant toute opération sensible.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Taille</TableHead>
                  <TableHead>Empreinte</TableHead>
                  <TableHead>État</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.backups.map((entry) => {
                  const healthy = entry.fileExists && entry.checksumMatches && entry.integrityStatus === 'VERIFIED';
                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {BACKUP_TYPE_LABELS[entry.backupType]}
                        {entry.origin === 'IMPORTED' && (
                          <span className="ml-1.5 inline-flex rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                            Importée
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTimeFr(entry.createdAt)}
                      </TableCell>
                      <TableCell className="tabular-nums whitespace-nowrap">
                        {formatBytes(entry.fileSizeBytes)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {entry.sha256Checksum.slice(0, 12)}…
                      </TableCell>
                      <TableCell>
                        <StatusPill ok={healthy} label={healthy ? 'Vérifiée' : 'À contrôler'} />
                        {entry.manifestPresent && (
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            + manifeste JSON
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => void handleVerify(entry)} disabled={verifyBackup.isPending}>
                            Vérifier
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void handleDownload(entry)}>
                            <Download className="h-3.5 w-3.5" />
                            Télécharger
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setRestoreTarget(entry);
                              setConfirmation('');
                            }}
                            disabled={!healthy}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Restaurer
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialogue de confirmation */}
      <Dialog open={Boolean(restoreTarget)} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmer la restauration</DialogTitle>
            <DialogDescription>
              La sauvegarde du {formatDateTimeFr(restoreTarget?.createdAt)} sera d&apos;abord
              restaurée et vérifiée sur une base séparée. Une sauvegarde de la base actuelle sera
              créée automatiquement. La base active ne sera remplacée qu&apos;au prochain
              redémarrage de l&apos;application, hors connexion.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="restore-confirmation">
              Saisissez <span className="font-mono font-semibold">{RESTORE_CONFIRMATION}</span> pour confirmer
            </Label>
            <Input
              id="restore-confirmation"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={RESTORE_CONFIRMATION}
              autoComplete="off"
            />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              Les données enregistrées après cette sauvegarde seront remplacées (une copie de
              sécurité reste conservée).
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRestore()}
              disabled={confirmation !== RESTORE_CONFIRMATION || restoreBackup.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              {restoreBackup.isPending ? 'Préparation...' : 'Préparer la restauration'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
