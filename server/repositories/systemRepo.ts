import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { AppError } from '../error.ts';
import { addXof, mulXofQty, subXof } from '../domain/money.ts';

export interface SystemHealthDTO {
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
}

export interface MigrationRecordDTO {
  version: number;
  filename: string;
  description: string;
  checksumSha256: string;
  executionMs: number;
  appliedAt: string;
}

export interface TableStatDTO {
  name: string;
  rowCount: number;
}

export interface ArchitectureDecisionDTO {
  key: string;
  value: string;
  category: string;
  description: string | null;
  updatedAt: string;
}

export interface LicenseStateDTO {
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

export interface IntegrityCheckResultDTO {
  status: 'OK' | 'FAILED';
  rawResult: string;
  checkedAt: string;
  durationMs: number;
}

export interface SelfTestCheckDTO {
  id: string;
  label: string;
  passed: boolean;
  details: string;
}

export interface SelfTestReportDTO {
  allPassed: boolean;
  executedAt: string;
  checks: SelfTestCheckDTO[];
}

export class SystemRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly dbPath: string
  ) {}

  getHealth(): SystemHealthDTO {
    const verRow = this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    const walRow = this.db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
    const fkRow = this.db.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number };
    const migRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM schema_migrations').get() as { cnt: number };
    const tblRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get() as { cnt: number };
    const lotRow = this.db
      .prepare("SELECT value FROM system_meta WHERE key = 'app.lot_current'")
      .get() as { value: string } | undefined;

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(this.dbPath).size;
    } catch {
      dbSizeBytes = 0;
    }

    return {
      appName: 'DepotPro CI',
      version: '0.1.0',
      runtime: 'NODE_SQLITE_LOCAL_BRIDGE',
      sqliteVersion: verRow.v,
      journalMode: String(walRow.journal_mode).toUpperCase(),
      foreignKeysEnabled: fkRow.foreign_keys === 1,
      dbPath: this.dbPath,
      dbSizeBytes,
      appliedMigrationsCount: migRow.cnt,
      tablesCount: tblRow.cnt,
      currentLot: lotRow?.value ?? 'LOT_0',
      offlineReady: true,
      checkedAt: new Date().toISOString(),
    };
  }

  getMigrations(): { migrations: MigrationRecordDTO[]; tables: TableStatDTO[] } {
    const migrations = this.db
      .prepare(
        `SELECT version, filename, description, checksum_sha256 AS checksumSha256,
                execution_ms AS executionMs, applied_at AS appliedAt
         FROM schema_migrations ORDER BY version ASC`
      )
      .all() as unknown as MigrationRecordDTO[];

    const tableNames = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
      )
      .all() as Array<{ name: string }>;

    const tables: TableStatDTO[] = tableNames.map((t) => {
      const safeName = t.name.replace(/"/g, '""');
      const countRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM "${safeName}"`).get() as { cnt: number };
      return {
        name: t.name,
        rowCount: countRow.cnt,
      };
    });

    return { migrations, tables };
  }

  getDecisions(): ArchitectureDecisionDTO[] {
    return this.db
      .prepare(
        `SELECT key, value, category, description, updated_at AS updatedAt
         FROM system_meta ORDER BY category ASC, key ASC`
      )
      .all() as unknown as ArchitectureDecisionDTO[];
  }

  getLicenseState(): LicenseStateDTO {
    const row = this.db
      .prepare(
        `SELECT id, edition, status, license_key_masked AS licenseKeyMasked,
                installation_id AS installationId, depot_name_bound AS depotNameBound,
                activated_at AS activatedAt, expires_at AS expiresAt,
                offline_allowed AS offlineAllowed, updated_at AS updatedAt
         FROM license_state WHERE id = 'local-license'`
      )
      .get() as
      | (Omit<LicenseStateDTO, 'offlineAllowed'> & { offlineAllowed: number })
      | undefined;

    if (!row) {
      throw new AppError('NOT_FOUND', 'État de licence locale introuvable', 404);
    }

    return {
      ...row,
      offlineAllowed: row.offlineAllowed === 1,
    };
  }

  activateLocalLicense(licenseKey: string, depotNameBound: string): LicenseStateDTO {
    const cleanKey = licenseKey.trim().toUpperCase();
    if (!/^DPCI-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cleanKey)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Format de clé locale invalide. Format attendu : DPCI-XXXX-XXXX.',
        400
      );
    }

    const cleanDepot = depotNameBound.trim();
    if (cleanDepot.length < 2) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Veuillez saisir le nom du dépôt à lier à cette licence locale.',
        400
      );
    }

    const masked = `DPCI-****-${cleanKey.slice(-4)}`;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE license_state
           SET status = 'ACTIVE_OFFLINE',
               license_key_masked = ?,
               depot_name_bound = ?,
               activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = 'local-license'`
        )
        .run(masked, cleanDepot);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, NULL, 'LICENSE_LOCAL_ACTIVATED', 'license_state', 'local-license', ?)`
        )
        .run(
          crypto.randomUUID(),
          JSON.stringify({ depotNameBound: cleanDepot, licenseKeyMasked: masked })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw new AppError(
        'DATABASE_ERROR',
        `Erreur lors de l'activation locale : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }

    return this.getLicenseState();
  }

  resetTrialLicense(): LicenseStateDTO {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE license_state
           SET status = 'TRIAL_OFFLINE',
               license_key_masked = NULL,
               depot_name_bound = NULL,
               activated_at = NULL,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = 'local-license'`
        )
        .run();

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, NULL, 'LICENSE_LOCAL_RESET_TRIAL', 'license_state', 'local-license', '{}')`
        )
        .run(crypto.randomUUID());

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw new AppError('DATABASE_ERROR', 'Impossible de réinitialiser la licence locale', 500);
    }

    return this.getLicenseState();
  }

  runIntegrityCheck(): IntegrityCheckResultDTO {
    const start = Date.now();
    const row = this.db.prepare('PRAGMA quick_check;').get() as { quick_check: string };
    const durationMs = Date.now() - start;
    const ok = row.quick_check.toLowerCase() === 'ok';
    return {
      status: ok ? 'OK' : 'FAILED',
      rawResult: row.quick_check,
      checkedAt: new Date().toISOString(),
      durationMs,
    };
  }

  runFoundationSelfTests(): SelfTestReportDTO {
    const checks: SelfTestCheckDTO[] = [];

    // 1. Vérification WAL
    const walRow = this.db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
    checks.push({
      id: 'sqlite-wal',
      label: 'Journalisation SQLite WAL active',
      passed: walRow.journal_mode.toLowerCase() === 'wal',
      details: `PRAGMA journal_mode = ${walRow.journal_mode.toUpperCase()}`,
    });

    // 2. Vérification Clés Étrangères + rejet réel d'une violation FK sous transaction annulée
    const fkRow = this.db.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number };
    let fkRejectedInvalidInsert = false;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          "INSERT INTO users (id, username, password_hash, role_id) VALUES ('selftest-fk', 'selftest_fk', 'hash', 'role-inexistant')"
        )
        .run();
      fkRejectedInvalidInsert = false;
    } catch {
      fkRejectedInvalidInsert = true;
    } finally {
      this.db.exec('ROLLBACK;');
    }
    checks.push({
      id: 'sqlite-fk',
      label: 'Intégrité référentielle (Clés étrangères SQLite)',
      passed: fkRow.foreign_keys === 1 && fkRejectedInvalidInsert,
      details:
        fkRow.foreign_keys === 1 && fkRejectedInvalidInsert
          ? 'PRAGMA foreign_keys = ON et insertion orpheline bloquée par SQLite'
          : 'Échec de contrainte FK détecté',
    });

    // 3. Vérification des rôles initiaux et permissions
    const rolesCount = (this.db.prepare('SELECT COUNT(*) AS c FROM roles').get() as { c: number }).c;
    const permsCount = (this.db.prepare('SELECT COUNT(*) AS c FROM permissions').get() as { c: number }).c;
    checks.push({
      id: 'rbac-seed',
      label: 'Référentiel des 4 rôles et permissions initiales',
      passed: rolesCount === 4 && permsCount >= 14,
      details: `${rolesCount} rôles initiaux et ${permsCount} permissions chargées en base`,
    });

    // 4. Vérification arithmétique entière XOF sans flottant
    const crateTotal = mulXofQty(9600, 10);
    const netTotal = subXof(addXof(crateTotal, 2400), 1000);
    let floatRejected = false;
    try {
      mulXofQty(100.5, 2);
    } catch {
      floatRejected = true;
    }
    checks.push({
      id: 'xof-integer-math',
      label: 'Calculs financiers XOF strictement entiers',
      passed: netTotal === 97400 && floatRejected,
      details: `10 × 9 600 + 2 400 - 1 000 = ${netTotal} FCFA ; décimal rejeté = ${floatRejected}`,
    });

    // 5. Vérification atomicité transactionnelle (Rollback SQLite)
    let rollbackOk = false;
    const testKey = 'selftest.rollback.probe';
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare("INSERT INTO system_meta (key, value, category) VALUES (?, 'TEMP', 'TEST')")
        .run(testKey);
      this.db.exec('ROLLBACK;');
      const probe = this.db.prepare('SELECT value FROM system_meta WHERE key = ?').get(testKey);
      rollbackOk = probe === undefined;
    } catch {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore
      }
      rollbackOk = false;
    }
    checks.push({
      id: 'sqlite-tx-rollback',
      label: 'Atomicité et rollback transactionnel SQLite',
      passed: rollbackOk,
      details: rollbackOk
        ? 'Écriture annulée proprement via ROLLBACK sans résidu'
        : 'Résidu détecté après ROLLBACK',
    });

    return {
      allPassed: checks.every((c) => c.passed),
      executedAt: new Date().toISOString(),
      checks,
    };
  }
}
