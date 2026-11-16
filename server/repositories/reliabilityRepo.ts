import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseLike } from '../db/driver.ts';
import type { SelfTestReportDTO, SelfTestCheckDTO } from './systemRepo.ts';

export interface ReliabilityCheckDTO {
  id: string;
  label: string;
  status: 'OK' | 'FAILED';
  details: string;
}

export interface ReliabilityDiagnosticsDTO {
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
  checks: ReliabilityCheckDTO[];
}

const REQUIRED_TABLES = [
  'system_meta',
  'schema_migrations',
  'users',
  'roles',
  'permissions',
  'role_permissions',
  'products',
  'stock_balances',
  'sales',
  'payments',
  'consignment_movements',
  'cash_sessions',
  'expenses',
  'audit_logs',
  'backup_history',
] as const;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * LOT 9 — Contrôles étendus de fiabilité, intégrité et non-régression.
 * Aucune écriture métier : uniquement des PRAGMA et des SELECT.
 */
export class ReliabilityRepository {
  private readonly migrationsDir: string;

  constructor(
    private readonly db: DatabaseLike,
    options: { migrationsDir?: string } = {}
  ) {
    this.migrationsDir = path.resolve(
      options.migrationsDir ?? path.resolve(process.cwd(), 'migrations')
    );
  }

  private scalar<T>(sql: string): T {
    return this.db.prepare(sql).get() as T;
  }

  private migrationChecksumMismatches(): { checked: number; mismatches: number } {
    const rows = this.db
      .prepare('SELECT filename, checksum_sha256 FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ filename: string; checksum_sha256: string }>;
    let mismatches = 0;
    for (const row of rows) {
      const file = path.join(this.migrationsDir, row.filename);
      if (!fs.existsSync(file)) {
        mismatches += 1;
        continue;
      }
      const checksum = crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8'), 'utf8').digest('hex');
      if (checksum !== row.checksum_sha256) mismatches += 1;
    }
    return { checked: rows.length, mismatches };
  }

  /** Détecte toute valeur monétaire non entière (flottant ou texte) dans les colonnes *_xof. */
  private nonIntegerMoneyColumns(): number {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    let offenders = 0;
    for (const table of tables) {
      const columns = this.db
        .prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
        .all() as Array<{ name: string }>;
      for (const column of columns) {
        if (!column.name.endsWith('_xof')) continue;
        const bad = this.db
          .prepare(
            `SELECT 1 FROM ${quoteIdentifier(table.name)}
             WHERE typeof(${quoteIdentifier(column.name)}) NOT IN ('integer', 'null')
             LIMIT 1`
          )
          .get();
        if (bad) offenders += 1;
      }
    }
    return offenders;
  }

  runDiagnostics(): ReliabilityDiagnosticsDTO {
    const start = Date.now();
    const checks: ReliabilityCheckDTO[] = [];
    const add = (id: string, label: string, passed: boolean, details: string) => {
      checks.push({ id, label, status: passed ? 'OK' : 'FAILED', details });
    };

    const wal = this.scalar<{ journal_mode: string }>('PRAGMA journal_mode;').journal_mode;
    const fk = this.scalar<{ foreign_keys: number }>('PRAGMA foreign_keys;').foreign_keys;
    add('wal-fk', 'Journal WAL et clés étrangères actifs', wal.toLowerCase() === 'wal' && fk === 1,
      `journal_mode=${wal.toUpperCase()} ; foreign_keys=${fk}`);

    const integrityResult = this.scalar<{ integrity_check: string }>(
      'PRAGMA integrity_check;'
    ).integrity_check;
    add('integrity-check', 'Intégrité physique complète (PRAGMA integrity_check)',
      integrityResult.toLowerCase() === 'ok', `Résultat : ${integrityResult}`);

    const fkRows = this.db.prepare('PRAGMA foreign_key_check;').all() as unknown[];
    add('foreign-key-check', 'Aucune référence orpheline (PRAGMA foreign_key_check)',
      fkRows.length === 0, `${fkRows.length} violation(s) détectée(s)`);

    const present = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    add('schema-tables', 'Schéma DepotPro CI complet', missing.length === 0,
      missing.length === 0 ? `${REQUIRED_TABLES.length} tables critiques présentes` : `Manquantes : ${missing.join(', ')}`);

    const migrationStatus = this.migrationChecksumMismatches();
    add('migration-checksums', 'Migrations versionnées non altérées (SHA-256)',
      migrationStatus.checked > 0 && migrationStatus.mismatches === 0,
      `${migrationStatus.checked} migration(s) vérifiée(s), ${migrationStatus.mismatches} anomalie(s)`);

    const currencyRow = this.db
      .prepare("SELECT value FROM system_meta WHERE key = 'app.currency'")
      .get() as { value: string } | undefined;
    const currency = currencyRow?.value ?? 'INCONNUE';
    add('currency-xof', 'Devise unique FCFA (XOF)', currency === 'XOF', `app.currency = ${currency}`);

    const moneyOffenders = this.nonIntegerMoneyColumns();
    add('xof-integers', 'Montants XOF strictement entiers en base',
      moneyOffenders === 0,
      moneyOffenders === 0
        ? 'Aucune valeur décimale ou texte dans les colonnes *_xof'
        : `${moneyOffenders} colonne(s) contiennent une valeur non entière`);

    const negativeStock = this.scalar<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM stock_balances WHERE quantity_base < 0 OR damaged_quantity_base < 0'
    ).cnt;
    add('no-negative-stock', 'Aucun stock négatif', negativeStock === 0,
      `${negativeStock} ligne(s) négative(s)`);

    const ownerBackup = this.scalar<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.code = 'backup.manage' AND r.code = 'OWNER'`
    ).cnt;
    const otherSystemRoles = this.scalar<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.code = 'backup.manage' AND r.code <> 'OWNER' AND r.is_system = 1`
    ).cnt;
    add('backup-rbac', 'Droit backup.manage réservé au Propriétaire',
      ownerBackup === 1 && otherSystemRoles === 0,
      `OWNER = ${ownerBackup > 0 ? 'oui' : 'non'} ; autres rôles système = ${otherSystemRoles}`);

    const tablesCount = this.scalar<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).cnt;
    const migrationsCount = this.scalar<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM schema_migrations'
    ).cnt;
    const lastBackup = this.scalar<{ at: string | null }>(
      'SELECT MAX(created_at) AS at FROM backup_history'
    ).at;
    add('backup-history', 'Historique des sauvegardes disponible', true,
      `Dernière sauvegarde : ${lastBackup ?? 'aucune'} (historique consultable)`);

    return {
      overall: checks.every((c) => c.status === 'OK') ? 'OK' : 'FAILED',
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      integrityResult,
      foreignKeyViolations: fkRows.length,
      tablesCount,
      migrationsCount,
      migrationChecksumMismatches: migrationStatus.mismatches,
      nonIntegerMoneyColumns: moneyOffenders,
      negativeStockRows: negativeStock,
      currency,
      lastBackupAt: lastBackup,
      checks,
    };
  }

  /** Batterie de non-régression LOT 9 (même contrat de rapport que le LOT 0). */
  runLot9SelfTests(): SelfTestReportDTO {
    const diagnostics = this.runDiagnostics();
    const checks: SelfTestCheckDTO[] = diagnostics.checks.map((c) => ({
      id: c.id,
      label: c.label,
      passed: c.status === 'OK',
      details: c.details,
    }));

    // Atomicité : une écriture annulée ne laisse aucun résidu.
    const probeKey = 'selftest.lot9.rollback.probe';
    let rollbackOk = false;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare("INSERT INTO system_meta (key, value, category) VALUES (?, 'TEMP', 'TEST')")
        .run(probeKey);
      this.db.exec('ROLLBACK;');
      rollbackOk = this.db.prepare('SELECT value FROM system_meta WHERE key = ?').get(probeKey) === undefined;
    } catch {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // ignore
      }
      rollbackOk = false;
    }
    checks.push({
      id: 'tx-rollback',
      label: 'Rollback transactionnel sans résidu',
      passed: rollbackOk,
      details: rollbackOk ? 'Écriture de test annulée proprement' : 'Résidu détecté après ROLLBACK',
    });

    // Hors ligne : la licence locale ne peut pas bloquer le fonctionnement.
    const offline = this.scalar<{ offline_allowed: number }>(
      "SELECT offline_allowed FROM license_state WHERE id = 'local-license'"
    ).offline_allowed;
    checks.push({
      id: 'offline-ready',
      label: 'Fonctionnement 100 % hors ligne préservé',
      passed: offline === 1,
      details: offline === 1 ? 'Licence locale offline_allowed = 1, aucune dépendance réseau' : 'Mode hors ligne désactivé',
    });

    return {
      allPassed: checks.every((c) => c.passed),
      executedAt: new Date().toISOString(),
      checks,
    };
  }
}
