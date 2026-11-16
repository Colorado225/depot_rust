import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, type DatabaseLike } from '../db/driver.ts';
import { AppError } from '../error.ts';
import { ensurePrivateDir, restrictFile } from '../security/fsGuard.ts';
import { sealRestoreMarker, verifyRestoreMarkerSeal } from '../security/localSeal.ts';

/**
 * LOT 9 — Restauration différée au redémarrage.
 *
 * La base active reste ouverte par le serveur : on ne l'écrase JAMAIS à chaud.
 * Une restauration préparée dépose un marqueur `restore-pending.json` à côté de
 * la base. Au prochain démarrage, AVANT l'ouverture de la connexion applicative,
 * le fichier de sauvegarde vérifié remplace la base courante (dont une copie
 * brute est conservée). Tout fonctionne hors ligne, sans service externe.
 */

export const RESTORE_CONFIRMATION = 'RESTAURER';

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
  /**
   * LOT 11 — Sceau HMAC-SHA256 du marqueur (clé locale hors base).
   * Absent = marqueur non écrit par cette installation → restauration refusée.
   */
  seal?: string;
}

export interface AppliedRestoreInfo {
  backupId: string;
  stagedPath: string;
  preRestoreCopyPath: string | null;
  appliedAt: string;
  requestedByUserId: string | null;
}

export interface SqliteFileInspection {
  integrityResult: string;
  foreignKeyViolations: number;
  tablesCount: number;
  migrationsCount: number;
  hasMigrationsTable: boolean;
}

export function pendingRestoreMarkerPath(dbFilePath: string): string {
  return path.join(path.dirname(dbFilePath), 'restore-pending.json');
}

/** Empreinte SHA-256 calculée par blocs (mémoire bornée, sans dépendance réseau). */
export function sha256FileSync(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * LOT 11.6 — clé à fournir pour inspecter un fichier chiffré.
 * Les sauvegardes d'une base chiffrée sont elles-mêmes chiffrées (mesuré :
 * `VACUUM INTO` conserve le chiffrement) : sans clé, l'inspection d'une
 * sauvegarde saine échoue et l'application refuserait ses propres fichiers.
 */
export interface InspectOptions {
  key?: { hex: string } | null;
}

/** Ouvre un fichier SQLite en lecture seule et le valide complètement. */
export function inspectSqliteFile(filePath: string, options: InspectOptions = {}): SqliteFileInspection {
  if (!fs.existsSync(filePath)) {
    throw new AppError('NOT_FOUND', `Fichier SQLite introuvable : ${filePath}`, 404);
  }

  let db: DatabaseLike;
  try {
    db = openDatabase(filePath, { readOnly: true, key: options.key ?? null }).db;
  } catch (err) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Le fichier n'est pas une base SQLite lisible : ${err instanceof Error ? err.message : String(err)}`,
      400
    );
  }

  try {
    const integrityRow = db.prepare('PRAGMA integrity_check;').get() as
      | { integrity_check: string }
      | undefined;
    const fkRows = db.prepare('PRAGMA foreign_key_check;').all() as unknown[];
    const tablesRow = db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .get() as { cnt: number };
    const hasMigrations = Boolean(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
        )
        .get()
    );
    const migrationsCount = hasMigrations
      ? (db.prepare('SELECT COUNT(*) AS cnt FROM schema_migrations').get() as { cnt: number }).cnt
      : 0;

    return {
      integrityResult: integrityRow?.integrity_check ?? 'unknown',
      foreignKeyViolations: fkRows.length,
      tablesCount: tablesRow.cnt,
      migrationsCount,
      hasMigrationsTable: hasMigrations,
    };
  } catch (err) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Contrôle d'intégrité impossible sur la copie : ${err instanceof Error ? err.message : String(err)}`,
      400
    );
  } finally {
    db.close();
  }
}

/** Valide un fichier SQLite : utilisé avant tout téléchargement ou restauration. */
export function assertSqliteFileHealthy(
  filePath: string,
  options: InspectOptions = {}
): SqliteFileInspection {
  const inspection = inspectSqliteFile(filePath, options);
  if (inspection.integrityResult.toLowerCase() !== 'ok') {
    throw new AppError(
      'VALIDATION_ERROR',
      `Copie SQLite corrompue (PRAGMA integrity_check = ${inspection.integrityResult}).`,
      400
    );
  }
  if (inspection.foreignKeyViolations > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Copie SQLite incohérente : ${inspection.foreignKeyViolations} violation(s) de clé étrangère.`,
      400
    );
  }
  if (!inspection.hasMigrationsTable || inspection.tablesCount < 20) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Le fichier ne contient pas un schéma DepotPro CI complet (migrations absentes).',
      400
    );
  }
  return inspection;
}

export function writePendingRestore(dbFilePath: string, pending: PendingRestore): void {
  if (pending.confirmation !== RESTORE_CONFIRMATION) {
    throw new AppError('VALIDATION_ERROR', 'Confirmation de restauration invalide.', 400);
  }
  ensurePrivateDir(path.dirname(path.resolve(dbFilePath)));
  const marker = pendingRestoreMarkerPath(dbFilePath);
  // LOT 11 — le marqueur est scellé AVANT écriture : un utilisateur qui accède
  // aux fichiers ne peut plus le forger pour déclencher une restauration.
  const sealed: PendingRestore = {
    ...pending,
    seal: sealRestoreMarker(dbFilePath, {
      version: pending.version,
      backupId: pending.backupId,
      stagedPath: pending.stagedPath,
      stagedChecksum: pending.stagedChecksum,
      confirmation: pending.confirmation,
      requestedByUserId: pending.requestedByUserId,
    }),
  };
  fs.writeFileSync(marker, `${JSON.stringify(sealed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  restrictFile(marker);
}

export function readPendingRestore(dbFilePath: string): PendingRestore | null {
  const marker = pendingRestoreMarkerPath(dbFilePath);
  if (!fs.existsSync(marker)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    throw new AppError(
      'DATABASE_ERROR',
      `Marqueur de restauration illisible (${marker}). Aucune base n'a été remplacée : supprimez ou corrigez ce fichier puis redémarrez.`,
      500
    );
  }

  const p = parsed as Partial<PendingRestore>;
  if (
    p.version !== 1 ||
    typeof p.backupId !== 'string' ||
    typeof p.stagedPath !== 'string' ||
    typeof p.stagedChecksum !== 'string' ||
    p.confirmation !== RESTORE_CONFIRMATION
  ) {
    throw new AppError(
      'DATABASE_ERROR',
      `Marqueur de restauration invalide (${marker}). Aucune base n'a été remplacée : vérifiez le fichier puis redémarrez.`,
      500
    );
  }

  // LOT 11 — contrôle du sceau AVANT toute autre étape. Un marqueur forgé à la
  // main est refusé, la base courante reste intacte et le fichier est laissé en
  // place pour diagnostic (comme pour un marqueur illisible).
  const sealCheck = verifyRestoreMarkerSeal(
    dbFilePath,
    {
      version: p.version,
      backupId: p.backupId,
      stagedPath: p.stagedPath,
      stagedChecksum: p.stagedChecksum,
      confirmation: p.confirmation,
      requestedByUserId: p.requestedByUserId ?? null,
    },
    p.seal
  );
  if (!sealCheck.ok) {
    throw new AppError(
      'DATABASE_ERROR',
      `Restauration refusée : ${sealCheck.reason} Aucune base n'a été remplacée. Supprimez ${marker} pour démarrer normalement.`,
      500
    );
  }
  return p as PendingRestore;
}

/**
 * LOT 11 — Annulation tracée : le sceau est vérifié d'abord, ce qui permet de
 * journaliser un identifiant de sauvegarde fiable, puis le marqueur est retiré.
 */
export function cancelPendingRestore(dbFilePath: string): boolean {
  const marker = pendingRestoreMarkerPath(dbFilePath);
  if (!fs.existsSync(marker)) return false;
  fs.rmSync(marker, { force: true });
  return true;
}

function removeWalSidecars(dbFilePath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(`${dbFilePath}${suffix}`, { force: true });
    } catch {
      // Un sidecar verrouillé par un autre processus est ignoré : SQLite le gérera.
    }
  }
}

/**
 * Applique une restauration préparée. À appeler UNIQUEMENT avant l'ouverture de la
 * connexion applicative. Renvoie `null` quand aucun marqueur n'est présent.
 *
 * Sécurité : en cas d'échec à n'importe quelle étape, la base courante est
 * laissée intacte et le marqueur est conservé (échec explicite au démarrage).
 */
export function applyPendingRestore(
  dbFilePath: string,
  options: InspectOptions = {}
): AppliedRestoreInfo | null {
  const pending = readPendingRestore(dbFilePath);
  if (!pending) return null;

  // 1. La copie préparée doit être intacte et cohérente.
  if (!fs.existsSync(pending.stagedPath)) {
    throw new AppError(
      'DATABASE_ERROR',
      `Copie de restauration introuvable (${pending.stagedPath}). Base courante conservée.`,
      500
    );
  }
  if (sha256FileSync(pending.stagedPath) !== pending.stagedChecksum) {
    throw new AppError(
      'DATABASE_ERROR',
      'Empreinte SHA-256 de la copie de restauration modifiée. Restauration refusée, base courante conservée.',
      500
    );
  }
  // La copie préparée est chiffrée comme la base : la clé doit être fournie,
  // sinon une sauvegarde saine serait déclarée illisible (faux négatif qui
  // bloquerait toute restauration sur une installation chiffrée).
  assertSqliteFileHealthy(pending.stagedPath, options);

  // 2. Checkpoint WAL : les écritures de la session précédente sont repliées dans
  //    le fichier principal, puis les sidecars sont retirés pour éviter qu'un WAL
  //    de l'ancienne base soit appliqué à la nouvelle.
  if (fs.existsSync(dbFilePath)) {
    const current = openDatabase(dbFilePath, { key: options.key ?? null }).db;
    try {
      current.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      current.close();
    }
    removeWalSidecars(dbFilePath);
  }

  // 3. Copie brute de sécurité de la base courante (en plus de la sauvegarde
  //    PRE_RESTORE déjà inscrite dans backup_history).
  let preRestoreCopyPath: string | null = null;
  if (fs.existsSync(dbFilePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    preRestoreCopyPath = path.join(
      path.dirname(dbFilePath),
      `depotpro.pre-restore-${stamp}.db`
    );
    fs.renameSync(dbFilePath, preRestoreCopyPath);
  }

  // 4. Activation : copie (pas de déplacement) pour garder la source vérifiable.
  try {
    fs.copyFileSync(pending.stagedPath, dbFilePath);
    removeWalSidecars(dbFilePath);
  } catch (err) {
    // Rollback fichier : on remet la base d'origine si elle avait été déplacée.
    if (preRestoreCopyPath && fs.existsSync(preRestoreCopyPath)) {
      fs.rmSync(dbFilePath, { force: true });
      fs.renameSync(preRestoreCopyPath, dbFilePath);
    }
    throw new AppError(
      'DATABASE_ERROR',
      `Échec de l'activation de la restauration : ${err instanceof Error ? err.message : String(err)}. Base courante restaurée.`,
      500
    );
  }

  fs.rmSync(pendingRestoreMarkerPath(dbFilePath), { force: true });

  return {
    backupId: pending.backupId,
    stagedPath: pending.stagedPath,
    preRestoreCopyPath,
    appliedAt: new Date().toISOString(),
    requestedByUserId: pending.requestedByUserId,
  };
}
