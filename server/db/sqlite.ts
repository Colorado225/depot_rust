import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../error.ts';
import { type AppliedRestoreInfo, applyPendingRestore } from './pendingRestore.ts';

export interface SqliteConnectionResult {
  db: DatabaseSync;
  dbPath: string;
  migrationsAppliedNow: number;
  /** Renseigné uniquement lorsqu'une restauration LOT 9 vient d'être activée au démarrage. */
  restoreApplied: AppliedRestoreInfo | null;
}

export function initLocalSqlite(
  // LOT 10 : la coquille Rust peut fournir un dossier de données explicite.
  // Le serveur Node reste la référence web/preview, jamais un sidecar desktop.
  // La coquille Tauri fournit ces chemins via variables d'environnement ;
  // les valeurs par défaut restent celles du serveur de développement.
  dbFilePath = process.env.DEPOTPRO_DATA_DIR
    ? path.join(process.env.DEPOTPRO_DATA_DIR, 'depotpro.db')
    : path.resolve(process.cwd(), 'data', 'depotpro.db'),
  migrationsDir = process.env.DEPOTPRO_MIGRATIONS_DIR ??
    path.resolve(process.cwd(), 'migrations')
): SqliteConnectionResult {
  const dir = path.dirname(dbFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // LOT 9 : une restauration préparée est activée AVANT toute ouverture de la
  // connexion applicative. Sans marqueur, cette étape est sans effet.
  const restoreApplied = applyPendingRestore(dbFilePath);

  const db = new DatabaseSync(dbFilePath);

  // Configuration critique SQLite : WAL + Clés étrangères + Synchronous NORMAL + Busy Timeout
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  // Table de suivi des migrations SQL versionnées
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      execution_ms INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  if (!fs.existsSync(migrationsDir)) {
    throw new AppError('DATABASE_ERROR', `Répertoire des migrations introuvable : ${migrationsDir}`, 500);
  }

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = db
    .prepare('SELECT version, filename, checksum_sha256 FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: number; filename: string; checksum_sha256: string }>;

  const appliedByVersion = new Map(appliedRows.map((r) => [r.version, r]));
  let migrationsAppliedNow = 0;

  for (const file of migrationFiles) {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) continue;

    const version = Number.parseInt(match[1], 10);
    const description = match[2].replaceAll('_', ' ');
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');

    const existing = appliedByVersion.get(version);
    if (existing) {
      if (existing.checksum_sha256 !== checksum) {
        throw new AppError(
          'DATABASE_ERROR',
          `Somme de contrôle modifiée pour la migration déjà appliquée ${file}`,
          500
        );
      }
      continue;
    }

    const start = Date.now();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(sql);
      const elapsed = Date.now() - start;
      db.prepare(
        'INSERT INTO schema_migrations (version, filename, description, checksum_sha256, execution_ms) VALUES (?, ?, ?, ?, ?)'
      ).run(version, file, description, checksum, elapsed);
      db.exec('COMMIT;');
      migrationsAppliedNow += 1;
    } catch (err) {
      db.exec('ROLLBACK;');
      throw new AppError(
        'DATABASE_ERROR',
        `Échec d'application de la migration ${file} : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }
  }

  return {
    db,
    dbPath: dbFilePath,
    migrationsAppliedNow,
    restoreApplied,
  };
}
