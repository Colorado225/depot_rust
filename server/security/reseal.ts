/**
 * LOT 11.6 — Maintenance des manifestes de sauvegarde.
 *
 * Deux opérations, toutes deux déclenchées explicitement (jamais au démarrage,
 * jamais en arrière-plan) et journalisées dans `audit_logs` :
 *
 *  1. `resealManifests` — un manifeste écrit par le LOT 11.1 (version 1, sans
 *     HMAC) reste bloquant : `inspectManifest` le classe `UNSEALED` et la
 *     restauration est refusée. C'est voulu (on ne peut pas prouver qu'il est
 *     authentique), mais une installation mise à jour se retrouve avec des
 *     sauvegardes inutilisables. Cet outil recalcule le HMAC à partir des
 *     champs du manifeste ET de l'empreinte SHA-256 réelle du fichier de
 *     sauvegarde : un manifeste dont le fichier a été modifié n'est donc PAS
 *     scellé silencieusement, il est signalé comme incohérent.
 *
 *  2. `rotateKeys` — remplace les clés base/scellement. La base est rechiffrée
 *     (cipher_migrate vérifié), PUIS les manifestes sont re-scellés avec la
 *     nouvelle clé. L'ordre importe : re-scellér avant de rechiffrer laisserait
 *     une fenêtre où un échec du rechiffrement rend les sauvegardes
 *     illisibles pour l'ancienne clé.
 *
 * Aucune de ces fonctions ne touche au contenu des fichiers de sauvegarde :
 * seuls les manifestes (JSON) sont réécrits, et chaque écriture passe par un
 * fichier temporaire + `rename` (remplacement atomique).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseLike } from '../db/driver.ts';
import { rekeyDatabase, type RawKey } from '../db/driver.ts';
import { restrictFile } from './fsGuard.ts';
import {
  MANIFEST_SEAL_CONTEXT,
  type ManifestSealFields,
  manifestSealMessage,
  sealManifest,
  verifyManifestSeal,
} from './localSeal.ts';
import { keyHex, loadOrCreateKey, writeKeyForRotation, type KeyKind } from './keys.ts';

/** Version de manifeste qui porte un sceau (LOT 11.2). */
export const SEALED_MANIFEST_VERSION = 2;

export interface ManifestRepairReport {
  scanned: number;
  resealed: string[];
  alreadySealed: string[];
  /** Manifeste présent mais fichier de sauvegarde absent ou modifié. */
  inconsistent: Array<{ backupId: string; reason: string }>;
  unreadable: Array<{ path: string; reason: string }>;
}

interface StoredManifest {
  format?: string;
  version?: number;
  backupId?: string;
  backupType?: string;
  origin?: string;
  fileName?: string;
  fileSizeBytes?: number;
  sha256?: string;
  currentLot?: string;
  createdAt?: string;
  seal?: string | null;
  [key: string]: unknown;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    let read = fs.readSync(fd, buffer, 0, buffer.length, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Écriture atomique : le manifeste est soit l'ancien, soit le nouveau. */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  restrictFile(tmp);
  fs.renameSync(tmp, filePath);
}

function manifestFields(manifest: StoredManifest): ManifestSealFields | null {
  const required = [
    'format',
    'version',
    'backupId',
    'backupType',
    'origin',
    'fileName',
    'fileSizeBytes',
    'sha256',
    'currentLot',
    'createdAt',
  ] as const;
  for (const key of required) {
    if (manifest[key] === undefined || manifest[key] === null) return null;
  }
  return {
    format: String(manifest.format),
    version: Number(manifest.version),
    backupId: String(manifest.backupId),
    backupType: String(manifest.backupType),
    origin: String(manifest.origin),
    fileName: String(manifest.fileName),
    fileSizeBytes: Number(manifest.fileSizeBytes),
    sha256: String(manifest.sha256),
    currentLot: String(manifest.currentLot),
    createdAt: String(manifest.createdAt),
  };
}

/**
 * Re-scelle les manifestes v1 d'un dossier de sauvegardes.
 *
 * Les manifestes DÉJÀ scellés et valides ne sont jamais réécrits (idempotence :
 * une seconde exécution ne fait rien). Un manifeste dont le SHA-256 ne
 * correspond plus au fichier n'est pas réparé : il est listé en `inconsistent`,
 * car le sceller reviendrait à blanchir une altération.
 */
export function resealManifests(
  dbFilePath: string,
  backupsDir: string,
  options: { dryRun?: boolean } = {}
): ManifestRepairReport {
  const report: ManifestRepairReport = {
    scanned: 0,
    resealed: [],
    alreadySealed: [],
    inconsistent: [],
    unreadable: [],
  };

  let entries: string[];
  try {
    entries = fs.readdirSync(backupsDir).filter((name) => name.endsWith('.manifest.json'));
  } catch (err) {
    report.unreadable.push({
      path: backupsDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  for (const name of entries) {
    const manifestPath = path.join(backupsDir, name);
    report.scanned += 1;

    let manifest: StoredManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as StoredManifest;
    } catch (err) {
      report.unreadable.push({ path: manifestPath, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const fields = manifestFields(manifest);
    if (!fields) {
      report.unreadable.push({ path: manifestPath, reason: 'champs obligatoires absents' });
      continue;
    }

    if (manifest.seal) {
      const verified = verifyManifestSeal(dbFilePath, fields, manifest.seal);
      if (verified.ok) {
        report.alreadySealed.push(fields.backupId);
        continue;
      }
      report.inconsistent.push({ backupId: fields.backupId, reason: verified.reason ?? 'sceau invalide' });
      continue;
    }

    // v1 non scellé : le fichier de sauvegarde doit prouver son intégrité.
    const backupPath = path.join(backupsDir, fields.fileName);
    if (!fs.existsSync(backupPath)) {
      report.inconsistent.push({
        backupId: fields.backupId,
        reason: `fichier de sauvegarde absent (${fields.fileName}) : manifeste non scellable.`,
      });
      continue;
    }
    const size = fs.statSync(backupPath).size;
    if (size !== fields.fileSizeBytes) {
      report.inconsistent.push({
        backupId: fields.backupId,
        reason: `taille du fichier différente du manifeste (${size} ≠ ${fields.fileSizeBytes}).`,
      });
      continue;
    }
    const digest = sha256File(backupPath);
    if (digest !== fields.sha256) {
      report.inconsistent.push({
        backupId: fields.backupId,
        reason: 'empreinte SHA-256 du fichier de sauvegarde différente du manifeste.',
      });
      continue;
    }

    if (options.dryRun) {
      report.resealed.push(fields.backupId);
      continue;
    }

    const seal = sealManifest(dbFilePath, { ...fields, version: SEALED_MANIFEST_VERSION });
    writeJsonAtomic(manifestPath, {
      ...manifest,
      version: SEALED_MANIFEST_VERSION,
      seal,
      sealContext: MANIFEST_SEAL_CONTEXT,
    });
    report.resealed.push(fields.backupId);
  }

  return report;
}

export interface KeyRotationReport {
  databaseRekeyed: boolean;
  manifestsResealed: ManifestRepairReport | null;
  storage: { database: string; seal: string };
}

/**
 * Rotation des deux clés.
 *
 * `apply` est obligatoire et nommé : une rotation accidentelle rend les
 * sauvegardes illisibles pour l'ancienne clé, et il n'existe aucun recours
 * hors sauvegarde du trousseau. L'appelant (route protégée, opérateur) doit
 * l'écrire explicitement.
 */
export function rotateKeys(args: {
  dbFilePath: string;
  backupsDir: string | null;
  /** Écrivain d'audit : fourni par l'appelant pour ne pas coupler ce module aux dépôts. */
  audit: (entry: { action: string; details: Record<string, unknown> }) => void;
}): KeyRotationReport {
  const dataDir = path.dirname(path.resolve(args.dbFilePath));

  const previousDatabase = loadOrCreateKey(dataDir, 'database', { create: false });
  if (!previousDatabase.key) {
    throw new Error(
      "Rotation impossible : aucune clé de chiffrement de base n'existe. Activez d'abord le chiffrement (DEPOTPRO_DB_ENCRYPTION=1)."
    );
  }

  const nextDatabase = newNextKey(dataDir, 'database');
  rekeyDatabase(args.dbFilePath, { hex: keyHex(previousDatabase.key) }, { hex: keyHex(nextDatabase.key) });

  // Après le rechiffrement seulement : les manifestes sont re-scellés avec la
  // NOUVELLE clé de scellement, et seulement si la base a bien changé de clé.
  const previousSeal = loadOrCreateKey(dataDir, 'seal', { create: false });
  const nextSeal = newNextKey(dataDir, 'seal');
  let manifests: ManifestRepairReport | null = null;
  if (args.backupsDir) {
    manifests = resealManifestsAfterRotation(args.dbFilePath, args.backupsDir, previousSeal.key, nextSeal.key);
  }

  args.audit({
    action: 'SECURITY_KEYS_ROTATED',
    details: {
      databaseRekeyed: true,
      previousSealExisted: Boolean(previousSeal.key),
      manifestsResealed: manifests?.resealed.length ?? 0,
      manifestsInconsistent: manifests?.inconsistent.length ?? 0,
      storage: { database: nextDatabase.storage.backend, seal: nextSeal.storage.backend },
    },
  });

  return {
    databaseRekeyed: true,
    manifestsResealed: manifests,
    storage: { database: nextDatabase.storage.backend, seal: nextSeal.storage.backend },
  };
}

function newNextKey(dataDir: string, kind: KeyKind): { key: Buffer; storage: { backend: string } } {
  // `crypto.randomBytes` : pas de `Math.random`, pas de dérivation depuis un
  // mot de passe. Pendant une rotation la clé doit être REMPLACÉE, pas
  // « chargée ou créée » (ce qui renverrait l'ancienne) : on écrit donc
  // directement la nouvelle valeur.
  const generated = crypto.randomBytes(32);
  const storage = writeKeyForRotation(dataDir, kind, generated);
  return { key: generated, storage };
}

/**
 * Re-scellement post-rotation : les manifestes portent un sceau calculé avec
 * l'ancienne clé. On les réécrit avec la nouvelle, sans toucher aux fichiers.
 */
function resealManifestsAfterRotation(
  dbFilePath: string,
  backupsDir: string,
  _previousSeal: Buffer | null,
  _nextSeal: Buffer
): ManifestRepairReport {
  const report: ManifestRepairReport = {
    scanned: 0,
    resealed: [],
    alreadySealed: [],
    inconsistent: [],
    unreadable: [],
  };
  let entries: string[];
  try {
    entries = fs.readdirSync(backupsDir).filter((name) => name.endsWith('.manifest.json'));
  } catch (err) {
    report.unreadable.push({ path: backupsDir, reason: err instanceof Error ? err.message : String(err) });
    return report;
  }

  for (const name of entries) {
    const manifestPath = path.join(backupsDir, name);
    report.scanned += 1;
    let manifest: StoredManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as StoredManifest;
    } catch (err) {
      report.unreadable.push({ path: manifestPath, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const fields = manifestFields(manifest);
    if (!fields) {
      report.unreadable.push({ path: manifestPath, reason: 'champs obligatoires absents' });
      continue;
    }
    // Intégrité du fichier AVANT de re-sceller : une rotation ne doit pas
    // blanchir une sauvegarde altérée.
    const backupPath = path.join(backupsDir, fields.fileName);
    if (!fs.existsSync(backupPath) || sha256File(backupPath) !== fields.sha256) {
      report.inconsistent.push({
        backupId: fields.backupId,
        reason: 'fichier de sauvegarde absent ou empreinte différente : manifeste non re-scellé.',
      });
      continue;
    }
    const seal = sealManifest(dbFilePath, { ...fields, version: SEALED_MANIFEST_VERSION });
    writeJsonAtomic(manifestPath, {
      ...manifest,
      version: SEALED_MANIFEST_VERSION,
      seal,
      sealContext: MANIFEST_SEAL_CONTEXT,
    });
    report.resealed.push(fields.backupId);
  }
  return report;
}

/** Journalise un re-scellement dans `audit_logs` (appelé par la route dédiée). */
export function auditReseal(db: DatabaseLike, report: ManifestRepairReport, userId: string | null): void {
  db.prepare(
    `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details_json, created_at)
     VALUES (?, ?, 'BACKUP_MANIFESTS_RESEALED', 'backup', NULL, ?)`
  ).run(
    crypto.randomUUID(),
    userId,
    JSON.stringify({
      scanned: report.scanned,
      resealed: report.resealed.length,
      alreadySealed: report.alreadySealed.length,
      inconsistent: report.inconsistent.length,
      unreadable: report.unreadable.length,
    })
  );
}

/** Utilitaire exposé aux tests : message canonique d'un manifeste re-scellé. */
export function resealedManifestMessage(fields: ManifestSealFields): string {
  return manifestSealMessage({ ...fields, version: SEALED_MANIFEST_VERSION });
}

/** Jointure sûre : refuse de sortir du dossier des sauvegardes. */
export function safeJoin(dir: string, name: string): string | null {
  const resolved = path.resolve(dir, name);
  return resolved.startsWith(path.resolve(dir) + path.sep) ? resolved : null;
}

export type { RawKey };
