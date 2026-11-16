import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseLike } from '../db/driver.ts';
import { initLocalSqlite } from '../db/sqlite.ts';
import {
  RESTORE_CONFIRMATION,
  type AppliedRestoreInfo,
  type PendingRestore,
  assertSqliteFileHealthy,
  cancelPendingRestore,
  pendingRestoreMarkerPath,
  readPendingRestore,
  sha256FileSync,
  writePendingRestore,
} from '../db/pendingRestore.ts';
import { AppError } from '../error.ts';
import { ensurePrivateDir, restrictFile } from '../security/fsGuard.ts';
import { sealManifest, verifyManifestSeal } from '../security/localSeal.ts';

export type BackupType = 'MANUAL' | 'AUTO' | 'USB_EXPORT' | 'PRE_RESTORE';
export type BackupOrigin = 'LOCAL' | 'IMPORTED';
/** `UNSEALED` : manifeste v1 d'avant le scellement HMAC (LOT 11), à recréer. */
export type ManifestStatus = 'OK' | 'ABSENT' | 'MISMATCH' | 'UNREADABLE' | 'UNSEALED';

/** Manifeste scellé : format `depotpro-backup-manifest`, version 2. */
export const MANIFEST_FORMAT = 'depotpro-backup-manifest';
export const MANIFEST_VERSION = 2;

/** Limite d'import d'une sauvegarde externe (256 Mo), lue dans system_meta si présente. */
const DEFAULT_IMPORT_MAX_BYTES = 256 * 1024 * 1024;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

export interface BackupManifestDTO {
  format: typeof MANIFEST_FORMAT;
  version: typeof MANIFEST_VERSION;
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
  /** LOT 11 — HMAC-SHA256 du contenu du manifeste (clé locale hors base). */
  seal?: string;
}

export interface BackupConfigDTO {
  autoEnabled: boolean;
  autoIntervalHours: number;
  retentionCount: number;
}

export interface BackupHistoryEntryDTO {
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

export interface BackupOverviewDTO {
  backupsDir: string;
  totalBackups: number;
  totalBytes: number;
  lastBackupAt: string | null;
  lastAutoBackupAt: string | null;
  lastRestoreAt: string | null;
  config: BackupConfigDTO;
  pendingRestore: PendingRestore | null;
  /**
   * LOT 11 — motif du refus quand un marqueur existe mais n'est pas authentifié.
   * L'aperçu reste consultable (diagnostic) ; seule l'activation est bloquée.
   */
  pendingRestoreRejectedReason: string | null;
  backups: BackupHistoryEntryDTO[];
}

export interface BackupVerificationDTO {
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

export interface RestorePlanDTO {
  mode: 'PENDING_RESTART' | 'VERIFIED_ONLY';
  backupId: string;
  verification: BackupVerificationDTO;
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

export interface CreateBackupInput {
  type: BackupType;
  userId: string | null;
  reason?: string;
}

export interface ImportBackupInput {
  fileBuffer: Buffer;
  originalName: string;
  expectedSha256?: string | null;
  userId: string | null;
}

export interface RestoreBackupInput {
  backupId: string;
  confirmation: string;
  activateOnRestart?: boolean;
  userId: string | null;
}

export interface BackupFileDTO {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  sha256Checksum: string;
}

interface BackupRow {
  id: string;
  backup_type: BackupType;
  origin: BackupOrigin;
  file_path: string;
  file_size_bytes: number;
  sha256_checksum: string;
  integrity_status: 'VERIFIED' | 'FAILED';
  created_by_user_id: string | null;
  created_by_username: string | null;
  created_at: string;
}

/** Tables témoins comparées avant/après restauration (aucune donnée n'est supprimée). */
const SNAPSHOT_TABLES = [
  'users',
  'products',
  'stock_balances',
  'stock_movements',
  'sales',
  'sale_items',
  'payments',
  'customers',
  'suppliers',
  'purchase_orders',
  'goods_receipts',
  'consignment_movements',
  'cash_sessions',
  'expenses',
  'audit_logs',
  'backup_history',
  'schema_migrations',
] as const;

function countRowsSafe(db: DatabaseLike, table: string): number {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return 0;
  const safe = table.replaceAll('"', '""');
  return (db.prepare(`SELECT COUNT(*) AS cnt FROM "${safe}"`).get() as { cnt: number }).cnt;
}

function snapshotRows(db: DatabaseLike): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of SNAPSHOT_TABLES) {
    out[table] = countRowsSafe(db, table);
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function fileStamp(): string {
  return nowIso().replace(/[:.]/g, '-');
}

/** Le manifeste est stocké à côté du .db : contrôle hors ligne sans la base applicative. */
function manifestPath(dbFilePath: string): string {
  return `${dbFilePath}.manifest.json`;
}

function safeOriginalName(raw: string): string {
  return path.basename(raw).replace(/[^\w.\- ]/g, '_').slice(0, 120);
}

export class BackupRepository {
  /** Chemin de la base : nécessaire au scellement et aux outils de maintenance. */
  readonly dbPath: string;
  /** Connexion : les outils de maintenance écrivent leur audit par ce biais. */
  readonly db: DatabaseLike;
  /** Clé SQLCipher des fichiers de sauvegarde (`null` en base non chiffrée). */
  private readonly databaseKey: { hex: string } | null;
  private readonly backupsDir: string;
  private readonly restoreDir: string;
  private readonly migrationsDir: string;

  constructor(
    db: DatabaseLike,
    dbPath: string,
    options: {
      backupsDir?: string;
      restoreDir?: string;
      migrationsDir?: string;
      /**
       * LOT 11.6 — clé SQLCipher de la base.
       * Indispensable quand la base est chiffrée : `VACUUM INTO` produit alors
       * une sauvegarde CHIFFRÉE, et tout contrôle d'intégrité qui l'ouvre sans
       * clé la déclarerait corrompue — l'application refuserait ses propres
       * sauvegardes.
       */
      databaseKey?: { hex: string } | null;
    } = {}
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.databaseKey = options.databaseKey ?? null;
    const dataDir = path.dirname(path.resolve(dbPath));
    this.backupsDir = path.resolve(options.backupsDir ?? path.join(dataDir, 'backups'));
    this.restoreDir = path.resolve(options.restoreDir ?? path.join(dataDir, 'restore'));
    this.migrationsDir = path.resolve(
      options.migrationsDir ?? path.resolve(process.cwd(), 'migrations')
    );
  }

  // ---------------------------------------------------------------------------
  // Manifestes de sauvegarde (contrôle hors ligne, sans ouvrir l'application)
  // ---------------------------------------------------------------------------

  /** Dossier des sauvegardes (utilisé par les outils de maintenance du LOT 11.6). */
  get backupsDirectory(): string {
    return this.backupsDir;
  }

  private currentLot(): string {
    const row = this.db
      .prepare("SELECT value FROM system_meta WHERE key = 'app.lot_current'")
      .get() as { value: string } | undefined;
    return row?.value ?? 'INCONNU';
  }

  /**
   * LOT 11 — manifeste v2 SCELLÉ (HMAC-SHA256, clé locale hors base).
   *
   * v1 (LOT 9) ne contenait qu'un SHA-256 recalculé depuis le fichier : il
   * prouvait l'intégrité physique, jamais l'authenticité. Un manifeste v1 reste
   * lisible (`ABSENT`/`UNSEALED`) mais ne suffit plus à autoriser un
   * téléchargement ou une restauration : il faut le recréer.
   */
  private writeManifest(
    filePath: string,
    data: Omit<BackupManifestDTO, 'format' | 'version' | 'app' | 'currency' | 'seal'>
  ): void {
    const base = {
      format: MANIFEST_FORMAT as typeof MANIFEST_FORMAT,
      version: MANIFEST_VERSION as typeof MANIFEST_VERSION,
      app: 'DepotPro CI' as const,
      currency: 'XOF' as const,
      ...data,
    };
    const manifest: BackupManifestDTO = {
      ...base,
      seal: sealManifest(this.dbPath, {
        format: base.format,
        version: base.version,
        backupId: base.backupId,
        backupType: base.backupType,
        origin: base.origin,
        fileName: base.fileName,
        fileSizeBytes: base.fileSizeBytes,
        sha256: base.sha256,
        currentLot: base.currentLot,
        createdAt: base.createdAt,
      }),
    };
    const target = manifestPath(filePath);
    ensurePrivateDir(path.dirname(path.resolve(filePath)));
    fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    restrictFile(target);
  }

  /**
   * Compare le manifeste au fichier, à l'empreinte enregistrée en base ET à son
   * sceau HMAC (LOT 11). Statuts : `OK`, `ABSENT`, `MISMATCH`, `UNREADABLE`,
   * `UNSEALED` (manifeste v1 d'avant le scellement).
   */
  private inspectManifest(
    filePath: string,
    backupId: string,
    expectedSha256: string
  ): { status: ManifestStatus; reason: string | null } {
    const mPath = manifestPath(filePath);
    if (!fs.existsSync(mPath)) {
      return { status: 'ABSENT', reason: null };
    }
    let parsed: Partial<BackupManifestDTO>;
    try {
      parsed = JSON.parse(fs.readFileSync(mPath, 'utf8')) as Partial<BackupManifestDTO>;
    } catch {
      return { status: 'UNREADABLE', reason: 'Manifeste JSON illisible.' };
    }
    if (parsed.backupId !== backupId || parsed.sha256 !== expectedSha256) {
      return { status: 'MISMATCH', reason: 'Manifeste incohérent avec l’historique (identifiant ou empreinte).' };
    }
    if (parsed.format !== MANIFEST_FORMAT) {
      return { status: 'UNREADABLE', reason: 'Format de manifeste non reconnu.' };
    }
    if (parsed.version !== MANIFEST_VERSION) {
      return {
        status: 'UNSEALED',
        reason:
          'Manifeste v1 non scellé : recréez la sauvegarde (aucune donnée n’est perdue, le fichier .db reste intact).',
      };
    }
    const sealCheck = verifyManifestSeal(
      this.dbPath,
      {
        format: parsed.format,
        version: parsed.version,
        backupId: parsed.backupId!,
        backupType: parsed.backupType as string,
        origin: parsed.origin as string,
        fileName: parsed.fileName as string,
        fileSizeBytes: parsed.fileSizeBytes as number,
        sha256: parsed.sha256!,
        currentLot: parsed.currentLot as string,
        createdAt: parsed.createdAt as string,
      },
      parsed.seal
    );
    if (!sealCheck.ok) {
      return { status: 'MISMATCH', reason: `Manifeste non authentifié : ${sealCheck.reason}` };
    }
    return { status: 'OK', reason: null };
  }

  getManifest(backupId: string): BackupManifestDTO {
    const entry = this.getBackup(backupId);
    const mPath = manifestPath(entry.filePath);
    if (!fs.existsSync(mPath)) {
      throw new AppError('NOT_FOUND', 'Aucun manifeste associé à cette sauvegarde.', 404);
    }
    const { status, reason } = this.inspectManifest(
      entry.filePath,
      entry.id,
      entry.sha256Checksum
    );
    if (status !== 'OK') {
      throw new AppError('CONFLICT', `Manifeste non vérifié : ${reason ?? status}`, 409);
    }
    return JSON.parse(fs.readFileSync(mPath, 'utf8')) as BackupManifestDTO;
  }

  // ---------------------------------------------------------------------------
  // Configuration (system_meta)
  // ---------------------------------------------------------------------------

  /**
   * LOT 11 — l'aperçu ne doit pas échouer à cause d'un marqueur forgé : on
   * renvoie `null` + un motif, et l'écran de sauvegarde affiche l'alerte.
   * Le démarrage, lui, refuse toujours la restauration (cf. `readPendingRestore`).
   */
  private readPendingRestoreForDisplay(): {
    pendingRestore: PendingRestore | null;
    pendingRestoreRejectedReason: string | null;
  } {
    try {
      return { pendingRestore: readPendingRestore(this.dbPath), pendingRestoreRejectedReason: null };
    } catch (err) {
      return {
        pendingRestore: null,
        pendingRestoreRejectedReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM system_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO system_meta (key, value, category, description)
         VALUES (?, ?, 'BACKUP', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      )
      .run(key, value, `Paramètre LOT 9 : ${key}`);
  }

  getConfig(): BackupConfigDTO {
    const enabled = this.getMeta('backup.auto_enabled') !== '0';
    const hours = Number.parseInt(this.getMeta('backup.auto_interval_hours') ?? '24', 10);
    const retention = Number.parseInt(this.getMeta('backup.retention_count') ?? '7', 10);
    return {
      autoEnabled: enabled,
      autoIntervalHours: Number.isSafeInteger(hours) && hours > 0 ? hours : 24,
      retentionCount: Number.isSafeInteger(retention) && retention > 0 ? retention : 7,
    };
  }

  updateConfig(input: BackupConfigDTO): BackupConfigDTO {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.setMeta('backup.auto_enabled', input.autoEnabled ? '1' : '0');
      this.setMeta('backup.auto_interval_hours', String(input.autoIntervalHours));
      this.setMeta('backup.retention_count', String(input.retentionCount));
      this.writeAudit(
        null,
        'BACKUP_CONFIG_UPDATED',
        'system_meta',
        'backup',
        JSON.stringify(input)
      );
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw new AppError(
        'DATABASE_ERROR',
        `Impossible d'enregistrer la configuration des sauvegardes : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }
    return this.getConfig();
  }

  // ---------------------------------------------------------------------------
  // Historique
  // ---------------------------------------------------------------------------

  private listRows(limit = 50): BackupRow[] {
    return this.db
      .prepare(
        `SELECT b.id, b.backup_type, b.origin, b.file_path, b.file_size_bytes, b.sha256_checksum,
                b.integrity_status, b.created_by_user_id, u.username AS created_by_username,
                b.created_at
         FROM backup_history b
         LEFT JOIN users u ON u.id = b.created_by_user_id
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT ?`
      )
      .all(limit) as unknown as BackupRow[];
  }

  private toEntry(row: BackupRow): BackupHistoryEntryDTO {
    const fileExists = fs.existsSync(row.file_path);
    let checksumMatches = false;
    if (fileExists) {
      try {
        checksumMatches = sha256FileSync(row.file_path) === row.sha256_checksum;
      } catch {
        checksumMatches = false;
      }
    }
    return {
      id: row.id,
      backupType: row.backup_type,
      origin: row.origin ?? 'LOCAL',
      fileName: path.basename(row.file_path),
      filePath: row.file_path,
      fileSizeBytes: row.file_size_bytes,
      sha256Checksum: row.sha256_checksum,
      integrityStatus: row.integrity_status,
      createdByUserId: row.created_by_user_id,
      createdByUsername: row.created_by_username,
      createdAt: row.created_at,
      fileExists,
      checksumMatches,
      manifestPresent: fs.existsSync(manifestPath(row.file_path)),
    };
  }

  // Le recalcul SHA-256 est borné aux 20 sauvegardes les plus récentes :
  // les contrôles complets restent disponibles à la demande (verify/download/restore).
  getOverview(limit = 20): BackupOverviewDTO {
    const rows = this.listRows(limit);
    const backups = rows.map((r) => this.toEntry(r));
    const totals = this.db
      .prepare(
        'SELECT COUNT(*) AS cnt, COALESCE(SUM(file_size_bytes), 0) AS bytes FROM backup_history'
      )
      .get() as { cnt: number; bytes: number };
    const last = this.db
      .prepare('SELECT MAX(created_at) AS at FROM backup_history')
      .get() as { at: string | null };

    return {
      backupsDir: this.backupsDir,
      totalBackups: totals.cnt,
      totalBytes: totals.bytes,
      lastBackupAt: last.at,
      lastAutoBackupAt: this.getMeta('backup.last_auto_at') || null,
      lastRestoreAt: this.getMeta('backup.last_restore_at') || null,
      config: this.getConfig(),
      ...this.readPendingRestoreForDisplay(),
      backups,
    };
  }

  private writeAudit(
    userId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    payload: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), userId, action, entityType, entityId, payload);
  }

  // ---------------------------------------------------------------------------
  // Sauvegarde : instantané cohérent WAL via VACUUM INTO + SHA-256
  // ---------------------------------------------------------------------------

  createBackup(input: CreateBackupInput): BackupHistoryEntryDTO {
    ensurePrivateDir(this.backupsDir);
    const id = crypto.randomUUID();
    const fileName = `depotpro-${input.type.toLowerCase()}-${fileStamp()}-${id.slice(0, 8)}.db`;
    const finalPath = path.join(this.backupsDir, fileName);
    const tmpPath = `${finalPath}.tmp`;

    if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    if (fs.existsSync(finalPath)) {
      throw new AppError('CONFLICT', `Un fichier de sauvegarde existe déjà : ${fileName}`, 409);
    }

    let size = 0;
    let checksum = '';
    try {
      // VACUUM INTO produit une copie compactée et transactionnellement cohérente,
      // y compris les frames WAL validés : c'est la méthode recommandée pour WAL.
      this.db.prepare('VACUUM INTO ?').run(tmpPath);
      assertSqliteFileHealthy(tmpPath, { key: this.databaseKey });
      size = fs.statSync(tmpPath).size;
      checksum = sha256FileSync(tmpPath);
      fs.renameSync(tmpPath, finalPath);
      restrictFile(finalPath);
      this.writeManifest(finalPath, {
        backupId: id,
        backupType: input.type,
        origin: 'LOCAL',
        fileName,
        fileSizeBytes: size,
        sha256: checksum,
        integrityResult: 'ok',
        foreignKeyViolations: 0,
        currentLot: this.currentLot(),
        createdAt: nowIso(),
      });
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(finalPath, { force: true });
      fs.rmSync(manifestPath(finalPath), { force: true });
      if (err instanceof AppError) throw err;
      throw new AppError(
        'DATABASE_ERROR',
        `Échec de la sauvegarde SQLite : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO backup_history
             (id, backup_type, origin, file_path, file_size_bytes, sha256_checksum,
              integrity_status, created_by_user_id)
           VALUES (?, ?, 'LOCAL', ?, ?, ?, 'VERIFIED', ?)`
        )
        .run(id, input.type, finalPath, size, checksum, input.userId);
      this.writeAudit(
        input.userId,
        `BACKUP_${input.type}_CREATED`,
        'backup_history',
        id,
        JSON.stringify({ fileName, fileSizeBytes: size, sha256: checksum, reason: input.reason ?? null })
      );
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      fs.rmSync(finalPath, { force: true });
      throw new AppError(
        'DATABASE_ERROR',
        `Sauvegarde créée mais historisation impossible : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }

    if (input.type === 'AUTO') {
      this.setMeta('backup.last_auto_at', nowIso());
      this.pruneAutoBackups(this.getConfig().retentionCount);
    }

    return this.getBackup(id);
  }

  /** Purge uniquement les copies automatiques les plus anciennes (jamais les écritures métier). */
  pruneAutoBackups(retentionCount: number): number {
    const rows = this.db
      .prepare(
        `SELECT id, file_path FROM backup_history
         WHERE backup_type = 'AUTO'
         ORDER BY created_at DESC, id DESC`
      )
      .all() as Array<{ id: string; file_path: string }>;
    const toPrune = rows.slice(Math.max(1, retentionCount));
    let removed = 0;
    for (const row of toPrune) {
      try {
        if (fs.existsSync(row.file_path)) {
          fs.rmSync(row.file_path, { force: true });
          removed += 1;
        }
      } catch {
        // Le fichier reste en place ; l'historique signale fileExists = false.
      }
      this.writeAudit(null, 'BACKUP_AUTO_PRUNED', 'backup_history', row.id, '{}');
    }
    return removed;
  }

  /** Sauvegarde automatique au démarrage / à intervalle régulier, sans réseau. */
  runAutoBackupIfDue(): BackupHistoryEntryDTO | null {
    const config = this.getConfig();
    if (!config.autoEnabled) return null;
    const lastAuto = this.getMeta('backup.last_auto_at');
    const lastTime = lastAuto ? Date.parse(lastAuto) : Number.NaN;
    const elapsed = Number.isFinite(lastTime) ? Date.now() - lastTime : Number.POSITIVE_INFINITY;
    if (elapsed < config.autoIntervalHours * 3_600_000) return null;
    return this.createBackup({ type: 'AUTO', userId: null, reason: 'Sauvegarde automatique locale' });
  }

  // ---------------------------------------------------------------------------
  // Vérification & téléchargement (export clé USB)
  // ---------------------------------------------------------------------------

  getBackup(id: string): BackupHistoryEntryDTO {
    const row = this.db
      .prepare(
        `SELECT b.id, b.backup_type, b.origin, b.file_path, b.file_size_bytes, b.sha256_checksum,
                b.integrity_status, b.created_by_user_id, u.username AS created_by_username,
                b.created_at
         FROM backup_history b
         LEFT JOIN users u ON u.id = b.created_by_user_id
         WHERE b.id = ?`
      )
      .get(id) as unknown as BackupRow | undefined;
    if (!row) {
      throw new AppError('NOT_FOUND', `Sauvegarde introuvable : ${id}`, 404);
    }
    return this.toEntry(row);
  }

  verifyBackup(id: string, userId: string | null = null): BackupVerificationDTO {
    const entry = this.getBackup(id);
    let checksumComputed = '';
    let integrityResult = 'non vérifié';
    let foreignKeyViolations = 0;
    let requiredTablesPresent = false;
    let tablesCount = 0;
    let migrationsCount = 0;
    let reason: string | null = null;
    let manifestStatus: ManifestStatus = 'ABSENT';

    try {
      if (!entry.fileExists) throw new Error('Fichier de sauvegarde absent du disque');
      checksumComputed = sha256FileSync(entry.filePath);
      const inspection = assertSqliteFileHealthy(entry.filePath, { key: this.databaseKey });
      integrityResult = inspection.integrityResult;
      foreignKeyViolations = inspection.foreignKeyViolations;
      requiredTablesPresent = inspection.hasMigrationsTable;
      tablesCount = inspection.tablesCount;
      migrationsCount = inspection.migrationsCount;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    const checksumMatches = checksumComputed === entry.sha256Checksum;
    if (!reason) {
      const manifest = this.inspectManifest(entry.filePath, entry.id, entry.sha256Checksum);
      manifestStatus = manifest.status;
      // Un manifeste absent est toléré (sauvegarde ancienne) ; un manifeste
      // falsifié, illisible ou non scellé (v1 du LOT 9) est bloquant : la
      // restauration et le téléchargement exigent une preuve d'authenticité.
      if (
        manifestStatus === 'MISMATCH' ||
        manifestStatus === 'UNREADABLE' ||
        manifestStatus === 'UNSEALED'
      ) {
        reason = manifest.reason;
      }
    }
    const status: 'OK' | 'FAILED' =
      !reason && checksumMatches && integrityResult.toLowerCase() === 'ok' && foreignKeyViolations === 0
        ? 'OK'
        : 'FAILED';

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare('UPDATE backup_history SET integrity_status = ? WHERE id = ?')
        .run(status === 'OK' ? 'VERIFIED' : 'FAILED', id);
      this.writeAudit(
        userId,
        'BACKUP_VERIFIED',
        'backup_history',
        id,
        JSON.stringify({ status, checksumMatches, manifestStatus, reason })
      );
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw new AppError(
        'DATABASE_ERROR',
        `Impossible d'enregistrer le contrôle : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }

    return {
      backupId: id,
      status,
      integrityResult,
      foreignKeyViolations,
      requiredTablesPresent,
      tablesCount,
      migrationsCount,
      checksumStored: entry.sha256Checksum,
      checksumComputed,
      checksumMatches,
      manifestStatus,
      checkedAt: nowIso(),
      reason: reason ?? (checksumMatches ? null : 'Empreinte SHA-256 différente de celle enregistrée'),
    };
  }

  readBackupFile(id: string): BackupFileDTO {
    const entry = this.getBackup(id);
    if (!entry.fileExists) {
      throw new AppError('NOT_FOUND', 'Le fichier de sauvegarde a été déplacé ou supprimé.', 404);
    }
    const verification = this.verifyBackup(id);
    if (verification.status !== 'OK') {
      throw new AppError(
        'CONFLICT',
        `Téléchargement refusé : sauvegarde non vérifiée (${verification.reason ?? 'intégrité incertaine'}).`,
        409
      );
    }
    return {
      filePath: entry.filePath,
      fileName: entry.fileName,
      fileSizeBytes: entry.fileSizeBytes,
      sha256Checksum: entry.sha256Checksum,
    };
  }

  // ---------------------------------------------------------------------------
  // Import d'une sauvegarde externe (clé USB, autre poste, nouvelle installation)
  // ---------------------------------------------------------------------------

  /**
   * Importe un fichier .db fourni par l'utilisateur. Le nom d'origine n'est
   * JAMAIS utilisé pour construire un chemin : seul un nom généré par UUID est
   * écrit dans le dossier local des sauvegardes.
   */
  importExternalBackup(input: ImportBackupInput): BackupHistoryEntryDTO {
    const maxBytesValue = Number.parseInt(
      this.getMeta('backup.import_max_bytes') ?? String(DEFAULT_IMPORT_MAX_BYTES),
      10
    );
    const maxBytes = Number.isSafeInteger(maxBytesValue) && maxBytesValue > 0
      ? maxBytesValue
      : DEFAULT_IMPORT_MAX_BYTES;

    if (!Buffer.isBuffer(input.fileBuffer) || input.fileBuffer.length < 512) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Fichier vide ou tronqué : une sauvegarde DepotPro CI est un fichier SQLite complet.',
        400
      );
    }
    if (input.fileBuffer.length > maxBytes) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Sauvegarde trop volumineuse (${input.fileBuffer.length} octets, limite ${maxBytes} octets).`,
        413
      );
    }
    if (!input.fileBuffer.subarray(0, 16).equals(SQLITE_MAGIC)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Le fichier n’est pas une base SQLite (en-tête « SQLite format 3 » absent).',
        400
      );
    }

    const expected = input.expectedSha256?.trim().toLowerCase() ?? null;
    if (expected && !/^[a-f0-9]{64}$/.test(expected)) {
      throw new AppError('VALIDATION_ERROR', 'Empreinte SHA-256 de transfert invalide.', 400);
    }

    ensurePrivateDir(this.backupsDir);
    const id = crypto.randomUUID();
    const fileName = `depotpro-import-${fileStamp()}-${id.slice(0, 8)}.db`;
    const finalPath = path.join(this.backupsDir, fileName);
    const tmpPath = `${finalPath}.tmp`;
    const originalName = safeOriginalName(input.originalName || 'sauvegarde.db');

    if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });

    let size = 0;
    let checksum = '';
    let integrityResult = 'ok';
    let foreignKeyViolations = 0;
    try {
      fs.writeFileSync(tmpPath, input.fileBuffer, { mode: 0o600 });
      checksum = sha256FileSync(tmpPath);
      if (expected && expected !== checksum) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Empreinte SHA-256 de transfert différente du fichier reçu : copie interrompue ou modifiée.',
          400
        );
      }
      const inspection = assertSqliteFileHealthy(tmpPath, { key: this.databaseKey });
      integrityResult = inspection.integrityResult;
      foreignKeyViolations = inspection.foreignKeyViolations;
      size = fs.statSync(tmpPath).size;
      fs.renameSync(tmpPath, finalPath);
      restrictFile(finalPath);
      this.writeManifest(finalPath, {
        backupId: id,
        backupType: 'USB_EXPORT',
        origin: 'IMPORTED',
        fileName,
        fileSizeBytes: size,
        sha256: checksum,
        integrityResult,
        foreignKeyViolations,
        currentLot: this.currentLot(),
        createdAt: nowIso(),
      });
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(finalPath, { force: true });
      fs.rmSync(manifestPath(finalPath), { force: true });
      if (err instanceof AppError) throw err;
      throw new AppError(
        'VALIDATION_ERROR',
        `Import refusé : ${err instanceof Error ? err.message : String(err)}`,
        400
      );
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO backup_history
             (id, backup_type, origin, file_path, file_size_bytes, sha256_checksum,
              integrity_status, created_by_user_id)
           VALUES (?, 'USB_EXPORT', 'IMPORTED', ?, ?, ?, 'VERIFIED', ?)`
        )
        .run(id, finalPath, size, checksum, input.userId);
      this.writeAudit(
        input.userId,
        'BACKUP_IMPORTED',
        'backup_history',
        id,
        JSON.stringify({ originalName, fileName, fileSizeBytes: size, sha256: checksum })
      );
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      fs.rmSync(finalPath, { force: true });
      fs.rmSync(manifestPath(finalPath), { force: true });
      throw new AppError(
        'DATABASE_ERROR',
        `Fichier importé mais historisation impossible : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }

    return this.getBackup(id);
  }

  // ---------------------------------------------------------------------------
  // Restauration : vérification sur base séparée, puis activation au redémarrage
  // ---------------------------------------------------------------------------

  restoreBackup(input: RestoreBackupInput): RestorePlanDTO {
    if (input.confirmation !== RESTORE_CONFIRMATION) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Confirmation requise : saisissez exactement « ${RESTORE_CONFIRMATION} » pour restaurer.`,
        400
      );
    }
    if (input.activateOnRestart !== false && readPendingRestore(this.dbPath)) {
      throw new AppError(
        'CONFLICT',
        'Une restauration est déjà programmée. Annulez-la ou redémarrez l’application avant d’en préparer une autre.',
        409
      );
    }

    const verification = this.verifyBackup(input.backupId, input.userId);
    if (verification.status !== 'OK') {
      throw new AppError(
        'CONFLICT',
        `Restauration refusée : la sauvegarde n'est pas intègre (${verification.reason ?? 'contrôle échoué'}).`,
        409
      );
    }
    const entry = this.getBackup(input.backupId);

    // 1. Sauvegarde préalable obligatoire de la base active (jamais d'écrasement à sec).
    const preRestore = this.createBackup({
      type: 'PRE_RESTORE',
      userId: input.userId,
      reason: `Avant restauration de ${input.backupId}`,
    });

    // 2. Restauration RÉELLE sur une base séparée : la copie est ouverte,
    //    les migrations manquantes y sont appliquées, puis elle est revérifiée.
    ensurePrivateDir(this.restoreDir);
    const stagedPath = path.join(
      this.restoreDir,
      `restore-staging-${fileStamp()}-${crypto.randomUUID().slice(0, 8)}.db`
    );
    fs.copyFileSync(entry.filePath, stagedPath);

    const rowsBefore = snapshotRows(this.db);
    let rowsAfter: Record<string, number> = {};
    let migrationsAppliedOnStaged = 0;
    let stagedDb: DatabaseLike | null = null;
    try {
      const staged = initLocalSqlite(stagedPath, this.migrationsDir, {
        encryption: Boolean(this.databaseKey),
        databaseKey: this.databaseKey,
        dataDir: this.restoreDir,
      });
      stagedDb = staged.db;
      migrationsAppliedOnStaged = staged.migrationsAppliedNow;
      rowsAfter = snapshotRows(staged.db);
      const stagedIntegrity = staged.db.prepare('PRAGMA integrity_check;').get() as {
        integrity_check: string;
      };
      if (stagedIntegrity.integrity_check.toLowerCase() !== 'ok') {
        throw new Error('PRAGMA integrity_check a échoué sur la base restaurée');
      }
      const stagedFk = staged.db.prepare('PRAGMA foreign_key_check;').all() as unknown[];
      if (stagedFk.length > 0) {
        throw new Error(`${stagedFk.length} violation(s) de clé étrangère sur la base restaurée`);
      }
      // Repasse la copie en journal DELETE : fichier autonome, sans sidecar WAL.
      staged.db.exec('PRAGMA journal_mode = DELETE;');
      staged.db.close();
      stagedDb = null;
      fs.rmSync(`${stagedPath}-wal`, { force: true });
      fs.rmSync(`${stagedPath}-shm`, { force: true });
    } catch (err) {
      if (stagedDb) {
        try {
          stagedDb.close();
        } catch {
          // ignore
        }
      }
      throw new AppError(
        'DATABASE_ERROR',
        `Restauration interrompue, base active intacte : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }

    assertSqliteFileHealthy(stagedPath, { key: this.databaseKey });
    const stagedChecksum = sha256FileSync(stagedPath);

    const activateOnRestart = input.activateOnRestart !== false;
    if (activateOnRestart) {
      const pending: PendingRestore = {
        version: 1,
        backupId: entry.id,
        sourceChecksum: entry.sha256Checksum,
        stagedPath,
        stagedChecksum,
        preRestoreBackupId: preRestore.id,
        requestedByUserId: input.userId,
        confirmation: RESTORE_CONFIRMATION,
        createdAt: nowIso(),
      };
      writePendingRestore(this.dbPath, pending);
    }

    this.writeAudit(
      input.userId,
      activateOnRestart ? 'BACKUP_RESTORE_PREPARED' : 'BACKUP_RESTORE_VERIFIED_ONLY',
      'backup_history',
      entry.id,
      JSON.stringify({
        stagedPath,
        stagedChecksum,
        preRestoreBackupId: preRestore.id,
        migrationsAppliedOnStaged,
      })
    );

    return {
      mode: activateOnRestart ? 'PENDING_RESTART' : 'VERIFIED_ONLY',
      backupId: entry.id,
      verification,
      preRestoreBackupId: preRestore.id,
      stagedPath,
      stagedChecksum,
      migrationsAppliedOnStaged,
      rowsBefore,
      rowsAfter,
      requiresRestart: activateOnRestart,
      createdAt: nowIso(),
      message: activateOnRestart
        ? `Restauration vérifiée sur une base séparée (${verification.tablesCount} tables). Redémarrez DepotPro CI hors connexion pour l'activer ; la base actuelle reste intacte d'ici là.`
        : 'Restauration vérifiée sur une base séparée uniquement. La base active n’a pas été modifiée.',
    };
  }

  cancelRestore(userId: string | null): boolean {
    // LOT 11 — le marqueur est scellé : on lit (et authentifie) son identifiant
    // AVANT de le supprimer, pour que le journal nomme la restauration annulée
    // au lieu d'écrire un identifiant factice après coup.
    const pending = readPendingRestore(this.dbPath);
    const cancelled = cancelPendingRestore(this.dbPath);
    if (cancelled) {
      this.writeAudit(
        userId,
        'BACKUP_RESTORE_CANCELLED',
        'backup_history',
        pending?.backupId ?? 'restore-pending',
        JSON.stringify({ backupId: pending?.backupId ?? null, stagedPath: pending?.stagedPath ?? null })
      );
    }
    return cancelled;
  }

  /** Appelé au démarrage quand une restauration a effectivement été activée. */
  recordRestoreApplied(info: AppliedRestoreInfo): void {
    this.setMeta('backup.last_restore_at', info.appliedAt);
    this.writeAudit(
      info.requestedByUserId,
      'BACKUP_RESTORE_APPLIED',
      'backup_history',
      info.backupId,
      JSON.stringify(info)
    );
  }

  getPendingRestoreMarkerPath(): string {
    return pendingRestoreMarkerPath(this.dbPath);
  }
}
