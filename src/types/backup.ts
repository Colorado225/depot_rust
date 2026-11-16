/** LOT 9 — Contrats des API de sauvegarde, restauration et fiabilisation. */

export type BackupType = 'MANUAL' | 'AUTO' | 'USB_EXPORT' | 'PRE_RESTORE';
export type BackupOrigin = 'LOCAL' | 'IMPORTED';
export type ManifestStatus = 'OK' | 'ABSENT' | 'MISMATCH' | 'UNREADABLE';

export const BACKUP_TYPE_LABELS: Record<BackupType, string> = {
  MANUAL: 'Manuelle',
  AUTO: 'Automatique',
  USB_EXPORT: 'Support USB',
  PRE_RESTORE: 'Avant restauration',
};

/** Manifeste JSON déposé à côté du .db, vérifiable hors ligne sans l'application. */
export interface BackupManifest {
  format: 'depotpro-backup-manifest';
  version: 1;
  app: 'DepotPro CI';
  currency: 'XOF';
  backupId: string;
  backupType: BackupType;
  origin: BackupOrigin;
  fileName: string;
  fileSizeBytes: number;
  sha256: string;
  integrityResult: string;
  foreignKeyViolations: number;
  currentLot: string;
  createdAt: string;
}

export interface BackupConfig {
  autoEnabled: boolean;
  autoIntervalHours: number;
  retentionCount: number;
}

export interface BackupHistoryEntry {
  id: string;
  backupType: BackupType;
  origin: BackupOrigin;
  fileName: string;
  filePath: string;
  fileSizeBytes: number;
  sha256Checksum: string;
  integrityStatus: 'VERIFIED' | 'FAILED';
  createdByUserId: string | null;
  createdByUsername: string | null;
  createdAt: string;
  fileExists: boolean;
  checksumMatches: boolean;
  manifestPresent: boolean;
}

export interface PendingRestore {
  version: 1;
  backupId: string;
  sourceChecksum: string;
  stagedPath: string;
  stagedChecksum: string;
  preRestoreBackupId: string | null;
  requestedByUserId: string | null;
  confirmation: string;
  createdAt: string;
}

export interface BackupOverview {
  backupsDir: string;
  totalBackups: number;
  totalBytes: number;
  lastBackupAt: string | null;
  lastAutoBackupAt: string | null;
  lastRestoreAt: string | null;
  config: BackupConfig;
  pendingRestore: PendingRestore | null;
  backups: BackupHistoryEntry[];
}

export interface BackupVerification {
  backupId: string;
  status: 'OK' | 'FAILED';
  integrityResult: string;
  foreignKeyViolations: number;
  requiredTablesPresent: boolean;
  tablesCount: number;
  migrationsCount: number;
  checksumStored: string;
  checksumComputed: string;
  checksumMatches: boolean;
  manifestStatus: ManifestStatus;
  checkedAt: string;
  reason: string | null;
}

export interface RestorePlan {
  mode: 'PENDING_RESTART' | 'VERIFIED_ONLY';
  backupId: string;
  verification: BackupVerification;
  preRestoreBackupId: string;
  stagedPath: string | null;
  stagedChecksum: string | null;
  migrationsAppliedOnStaged: number;
  rowsBefore: Record<string, number>;
  rowsAfter: Record<string, number>;
  requiresRestart: boolean;
  createdAt: string;
  message: string;
}

export interface ReliabilityCheck {
  id: string;
  label: string;
  status: 'OK' | 'FAILED';
  details: string;
}

export interface ReliabilityDiagnostics {
  overall: 'OK' | 'FAILED';
  checkedAt: string;
  durationMs: number;
  integrityResult: string;
  foreignKeyViolations: number;
  tablesCount: number;
  migrationsCount: number;
  migrationChecksumMismatches: number;
  nonIntegerMoneyColumns: number;
  negativeStockRows: number;
  currency: string;
  lastBackupAt: string | null;
  checks: ReliabilityCheck[];
}
