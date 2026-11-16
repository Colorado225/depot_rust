import {
  openDatabase,
  encryptDatabase,
  databaseState,
  type DatabaseLike,
  type OpenResult,
} from './driver.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../error.ts';
import { ensurePrivateDir, restrictDatabaseFiles } from '../security/fsGuard.ts';
import { assertNotProductionInPreview, resolveDataPaths } from '../security/dataPaths.ts';
import { keyHex, loadOrCreateKey, type KeyStorage } from '../security/keys.ts';
import { type AppliedRestoreInfo, applyPendingRestore } from './pendingRestore.ts';

/**
 * LOT 11.6 — Chiffrement au repos de la base locale.
 *
 * Décision : clé brute de 32 octets (256 bits) tirée par `crypto.randomBytes`,
 * conservée dans le trousseau du système (option O1), appliquée via
 * `PRAGMA key="x'<hex>'"` — pas de phrase de passe, pas de dérivation : la clé
 * a déjà l'entropie maximale, une KDF ralentirait chaque ouverture sans rien
 * ajouter.
 *
 * Politique de démarrage (aucune conversion silencieuse) :
 *   1. base existante EN CLAIR + clé disponible → chiffrée sur place, avec une
 *      copie de sécurité horodatée et une lignée dans `backup_history` ;
 *   2. base CHIFFRÉE + clé absente → démarrage refusé avec un message
 *      exploitable (clé perdue = données perdues : il n'existe aucune
 *      récupération, c'est le prix du chiffrement) ;
 *   3. base EN CLAIR + clé absente et chiffrement non demandé → mode ouvert
 *      (preview web, tests).
 */

/** Variable d'environnement qui active/désactive le chiffrement de la base. */
export const DATABASE_ENCRYPTION_ENV = 'DEPOTPRO_DB_ENCRYPTION';

/**
 * `true` par défaut sur un poste installé (Tauri/desktop), `false` en preview
 * web où la base est jetable et où aucun trousseau n'existe.
 */
export function encryptionWanted(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const raw = process.env[DATABASE_ENCRYPTION_ENV];
  if (raw === undefined) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export interface SqliteConnectionResult {
  db: DatabaseLike;
  dbPath: string;
  migrationsAppliedNow: number;
  /** Renseigné uniquement lorsqu'une restauration LOT 9 vient d'être activée au démarrage. */
  restoreApplied: AppliedRestoreInfo | null;
  /** État du chiffrement au repos après démarrage. */
  encryption: DatabaseEncryptionInfo;
}

export interface DatabaseEncryptionInfo {
  /** `true` si la base est chiffrée à la sortie de l'initialisation. */
  encrypted: boolean;
  /** Où la clé est rangée ; `null` quand la base n'est pas chiffrée. */
  storage: KeyStorage | null;
  /** Copie de sécurité produite par la conversion de cette exécution. */
  preEncryptionCopyPath: string | null;
}

export interface InitOptions {
  /** Force le chiffrement (`true`) ou l'absence de chiffrement (`false`). */
  encryption?: boolean;
  /** Dossier de données ; sinon déduit du chemin de la base. */
  dataDir?: string;
  /**
   * Clé imposée par l'appelant (restauration d'une copie de sauvegarde, tests).
   * Elle doit être celle de la base ; absente, elle est lue/écrite dans le
   * trousseau du `dataDir`.
   */
  databaseKey?: { hex: string } | null;
}

/**
 * Nombre maximal de sauvegardes de conversion conservées : au-delà, la plus
 * ancienne est supprimée. Une copie en clair qui s'accumule annulerait le gain
 * du chiffrement.
 */
const MAX_PLAINTEXT_COPIES = 2;

function prunePlaintextCopies(dbFilePath: string): void {
  const dir = path.dirname(dbFilePath);
  const prefix = `${path.basename(dbFilePath, '.db')}.pre-encryption-`;
  let copies: string[];
  try {
    copies = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
      .sort();
  } catch {
    return;
  }
  while (copies.length > MAX_PLAINTEXT_COPIES) {
    const oldest = copies.shift();
    if (oldest) fs.rmSync(path.join(dir, oldest), { force: true });
  }
}

function preEncryptionCopyPath(dbFilePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(dbFilePath, '.db');
  return path.join(path.dirname(dbFilePath), `${base}.pre-encryption-${stamp}.db`);
}

export function initLocalSqlite(
  // LOT 10 : la coquille Rust peut fournir un dossier de données explicite.
  // Le serveur Node reste la référence web/preview, jamais un sidecar desktop.
  // La coquille Tauri fournit ces chemins via variables d'environnement ;
  // les valeurs par défaut restent celles du serveur de développement.
  dbFilePath = resolveDataPaths().dbPath,
  migrationsDir = process.env.DEPOTPRO_MIGRATIONS_DIR ??
    path.resolve(process.cwd(), 'migrations'),
  options: InitOptions = {}
): SqliteConnectionResult {
  // LOT 11.6 — un aperçu ne doit jamais ouvrir la base du poste installé.
  assertNotProductionInPreview(dbFilePath);

  // LOT 11 — le dossier de données est privé (0700) avant toute écriture.
  const dir = path.dirname(dbFilePath);
  ensurePrivateDir(dir);
  const dataDir = options.dataDir ?? dir;

  // LOT 11.6 — clé de chiffrement, jamais écrite en clair dans la base.
  // Elle est chargée AVANT la restauration : les sauvegardes d'une base
  // chiffrée sont chiffrées, leur contrôle d'intégrité exige la clé.
  const wantEncryption = encryptionWanted(options.encryption);
  const imposedKey = options.databaseKey ?? null;
  const loaded = imposedKey
    ? { key: Buffer.from(imposedKey.hex, 'hex'), storage: null }
    : wantEncryption
      ? loadOrCreateKey(dataDir, 'database', { create: true })
      : { key: null, storage: null };
  const databaseKey = loaded.key;
  const keyOption = databaseKey ? { hex: keyHex(databaseKey) } : null;

  // LOT 9 : une restauration préparée est activée AVANT toute ouverture de la
  // connexion applicative. Sans marqueur, cette étape est sans effet.
  const restoreApplied = applyPendingRestore(dbFilePath, { key: keyOption });

  let preEncryptionCopy: string | null = null;
  let opened: OpenResult;

  if (databaseKey && databaseState(dbFilePath) === 'plaintext') {
    // Conversion d'une installation antérieure au LOT 11.6.
    preEncryptionCopy = preEncryptionCopyPath(dbFilePath);
    encryptDatabase(dbFilePath, { hex: keyHex(databaseKey) }, {
      preEncryptionCopyPath: preEncryptionCopy,
    });
    prunePlaintextCopies(dbFilePath);
  }

  opened = openDatabase(dbFilePath, { key: keyOption });

  const db = opened.db;

  // Configuration critique SQLite : WAL + Clés étrangères + Synchronous NORMAL + Busy Timeout
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  // LOT 11 — base et sidecars WAL en 0600 : un autre compte local ne peut pas
  // copier les données financières (constat C4 du rapport de sécurité).
  restrictDatabaseFiles(dbFilePath);

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
    encryption: {
      encrypted: opened.encrypted,
      storage: opened.encrypted ? loaded.storage : null,
      preEncryptionCopyPath: preEncryptionCopy,
    },
  };
}
