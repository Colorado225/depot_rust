/**
 * LOT 11 — Scellement local (HMAC-SHA256) des artefacts de contrôle.
 *
 * Objet : un utilisateur disposant d'un accès direct aux fichiers peut écrire
 * `restore-pending.json` à la main. Sans scellement, cette simple écriture
 * remplace la base au démarrage suivant, sans mot de passe et sans RBAC
 * (constat C1 du rapport `docs/LOT11_SECURITE_LOCALE.md`, mesuré).
 *
 * Le scellement ne remplace pas le RBAC : il ferme le contournement fichier.
 *
 * Limite assumée et documentée : la clé vit dans `data/.depotpro-seal.key`
 * (0600). Elle empêche la falsification par un **autre compte** et toute
 * modification accidentelle, mais un attaquant exécutant du code sous le
 * **même compte** peut lire la clé. La clé sera déplacée dans le trousseau OS
 * avec la clé de chiffrement de la base (lot 11.6, option O1).
 *
 * Format de la clé : 32 octets aléatoires, encodés en hexadécimal (64 car.).
 * Le message scellé est une CHAÎNE À ORDRE FIXE, jamais un JSON : Rust et Node
 * doivent produire exactement les mêmes octets (aucune dépendance à l'ordre
 * des clés d'un objet).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../error.ts';
import { loadOrCreateKey, type KeyStorage } from './keys.ts';

/**
 * Nom historique du fichier de clé (LOT 11.1). Depuis le LOT 11.6 la clé vit
 * dans le trousseau du système ; ce nom ne sert plus qu'à détecter et migrer
 * une installation antérieure.
 */
export const SEAL_KEY_FILENAME = '.depotpro-seal.key';

/** Préfixe de domaine : empêche le rejeu d'un sceau d'un autre usage. */
export const RESTORE_SEAL_CONTEXT = 'depotpro-restore-seal-v1';

/** Emplacement historique du fichier de clé (migration 11.1 → 11.6 uniquement). */
export function sealKeyPath(dbFilePath: string): string {
  return path.join(path.dirname(path.resolve(dbFilePath)), SEAL_KEY_FILENAME);
}

/** Dossier de données associé à une base : la clé y est rangée. */
function dataDirOf(dbFilePath: string): string {
  return path.dirname(path.resolve(dbFilePath));
}

/**
 * Charge la clé de scellement, ou la crée au premier usage.
 * `create: false` permet à la vérification de refuser un marqueur scellé
 * alors que l'installation n'a jamais généré de clé (marqueur étranger).
 *
 * LOT 11.6 : la clé est rangée dans le trousseau du système (option O1), avec
 * repli fichier 0600 quand aucun trousseau n'est disponible. `loadOrCreateKey`
 * migre de lui-même une clé laissée en fichier par le LOT 11.1.
 */
export function loadSealKey(dbFilePath: string, options: { create?: boolean } = {}): Buffer | null {
  return loadOrCreateKey(dataDirOf(dbFilePath), 'seal', options).key;
}

/** Où la clé de scellement est réellement rangée (diagnostic / écran de statut). */
export function sealKeyStorage(dbFilePath: string): KeyStorage {
  return loadOrCreateKey(dataDirOf(dbFilePath), 'seal', { create: false }).storage;
}

/** HMAC-SHA256 hexadécimal. */
export function hmacSha256Hex(key: Buffer, message: string): string {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/** Comparaison à temps constant de deux empreintes hexadécimales. */
export function secureHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Construit le message canonique du marqueur de restauration. */
export function restoreSealMessage(fields: {
  version: number;
  backupId: string;
  stagedPath: string;
  stagedChecksum: string;
  confirmation: string;
  requestedByUserId: string | null;
}): string {
  return [
    RESTORE_SEAL_CONTEXT,
    String(fields.version),
    fields.backupId,
    fields.stagedPath,
    fields.stagedChecksum,
    fields.confirmation,
    fields.requestedByUserId ?? '',
  ].join('|');
}

/** Calcule le sceau d'un marqueur (la clé est créée si nécessaire). */
export function sealRestoreMarker(
  dbFilePath: string,
  fields: Parameters<typeof restoreSealMessage>[0]
): string {
  const key = loadSealKey(dbFilePath, { create: true });
  if (!key) {
    throw new AppError('DATABASE_ERROR', 'Clé de scellement locale indisponible.', 500);
  }
  return hmacSha256Hex(key, restoreSealMessage(fields));
}

/**
 * Vérifie un sceau. Ne lève jamais : renvoie un motif lisible, pour que
 * l'appelant décide du message (démarrage refusé, écran de diagnostic…).
 */
export function verifyRestoreMarkerSeal(
  dbFilePath: string,
  fields: Parameters<typeof restoreSealMessage>[0],
  seal: string | null | undefined
): { ok: boolean; reason: string | null } {
  if (!seal) {
    return {
      ok: false,
      reason:
        "marqueur non scellé : il n'a pas été écrit par cette installation (falsification probable).",
    };
  }
  let key: Buffer | null;
  try {
    key = loadSealKey(dbFilePath, { create: false });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!key) {
    return {
      ok: false,
      reason:
        "aucune clé de scellement sur cette installation : marqueur provenant d'un autre poste.",
    };
  }
  const expected = hmacSha256Hex(key, restoreSealMessage(fields));
  if (!secureHexEqual(expected, seal)) {
    return { ok: false, reason: 'sceau HMAC invalide : marqueur modifié ou forgé.' };
  }
  return { ok: true, reason: null };
}

/** Contexte distinct : un sceau de marqueur ne peut pas servir de sceau de manifeste. */
export const MANIFEST_SEAL_CONTEXT = 'depotpro-manifest-seal-v2';

export interface ManifestSealFields {
  format: string;
  version: number;
  backupId: string;
  backupType: string;
  origin: string;
  fileName: string;
  fileSizeBytes: number;
  sha256: string;
  currentLot: string;
  createdAt: string;
}

/** Message canonique du manifeste de sauvegarde (ordre fixe, partagé Node/Rust). */
export function manifestSealMessage(fields: ManifestSealFields): string {
  return [
    MANIFEST_SEAL_CONTEXT,
    fields.format,
    String(fields.version),
    fields.backupId,
    fields.backupType,
    fields.origin,
    fields.fileName,
    String(fields.fileSizeBytes),
    fields.sha256,
    fields.currentLot,
    fields.createdAt,
  ].join('|');
}

export function sealManifest(dbFilePath: string, fields: ManifestSealFields): string {
  const key = loadSealKey(dbFilePath, { create: true });
  if (!key) {
    throw new AppError('DATABASE_ERROR', 'Clé de scellement locale indisponible.', 500);
  }
  return hmacSha256Hex(key, manifestSealMessage(fields));
}

/** Vérification non bloquante : renvoie le statut et un motif lisible. */
export function verifyManifestSeal(
  dbFilePath: string,
  fields: ManifestSealFields,
  seal: string | null | undefined
): { ok: boolean; reason: string | null } {
  if (!seal) {
    return {
      ok: false,
      reason:
        "manifeste non scellé (format v1) : recréez la sauvegarde pour obtenir un manifeste authentifié.",
    };
  }
  let key: Buffer | null;
  try {
    key = loadSealKey(dbFilePath, { create: false });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!key) {
    return { ok: false, reason: "aucune clé de scellement sur cette installation." };
  }
  const expected = hmacSha256Hex(key, manifestSealMessage(fields));
  if (!secureHexEqual(expected, seal)) {
    return { ok: false, reason: 'sceau HMAC invalide : manifeste modifié ou forgé.' };
  }
  return { ok: true, reason: null };
}
