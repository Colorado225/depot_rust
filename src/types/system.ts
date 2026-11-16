export interface SystemHealth {
  appName: string;
  version: string;
  runtime: string;
  sqliteVersion: string;
  journalMode: string;
  foreignKeysEnabled: boolean;
  dbPath: string;
  dbSizeBytes: number;
  appliedMigrationsCount: number;
  tablesCount: number;
  currentLot: string;
  offlineReady: boolean;
  checkedAt: string;
  /** LOT 11.6 — chiffrement au repos et emplacement de la clé. */
  databaseEncryption?: {
    encrypted: boolean;
    keyStorage: 'os' | 'file' | 'none';
    note: string | null;
  };
}

export interface MigrationRecord {
  version: number;
  filename: string;
  description: string;
  checksumSha256: string;
  executionMs: number;
  appliedAt: string;
}

export interface TableStat {
  name: string;
  rowCount: number;
}

export interface MigrationsOverview {
  migrations: MigrationRecord[];
  tables: TableStat[];
}

export interface ArchitectureDecision {
  key: string;
  value: string;
  category: string;
  description: string | null;
  updatedAt: string;
}

export interface LicenseState {
  id: string;
  edition: string;
  status: 'TRIAL_OFFLINE' | 'ACTIVE_OFFLINE' | 'EXPIRED_GRACE';
  licenseKeyMasked: string | null;
  installationId: string;
  depotNameBound: string | null;
  activatedAt: string | null;
  expiresAt: string | null;
  offlineAllowed: boolean;
  updatedAt: string;
}

export interface IntegrityCheckResult {
  status: 'OK' | 'FAILED';
  rawResult: string;
  checkedAt: string;
  durationMs: number;
}

export interface SelfTestCheck {
  id: string;
  label: string;
  passed: boolean;
  details: string;
}

export interface SelfTestReport {
  allPassed: boolean;
  executedAt: string;
  checks: SelfTestCheck[];
}
