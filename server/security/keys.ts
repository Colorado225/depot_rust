/**
 * LOT 11.6 — Clés de l'installation (option O1 : trousseau du système).
 *
 * Deux clés distinctes, 32 octets chacune :
 *   - `database` : clé brute SQLCipher de `depotpro.db` (chiffrement au repos) ;
 *   - `seal`     : clé HMAC des marqueurs de restauration et des manifestes.
 *
 * Pourquoi deux clés : compromettre l'une ne doit pas ouvrir l'autre. Un sceau
 * de manifeste volé ne déchiffre pas la base, une copie de base ne permet pas
 * de forger un marqueur accepté.
 *
 * Stockage, par ordre de préférence :
 *   1. trousseau du système (Windows Credential Manager / macOS Keychain /
 *      Secret Service Linux) — choisi par la décision mono-utilisateur (O1) ;
 *   2. fichier `0600` à côté de la base — repli quand aucun trousseau n'est
 *      disponible (serveur sans session graphique, conteneur, poste bureau
 *      Linux minimal). Le repli est signalé (`backend: 'file'`) pour que
 *      l'écran de diagnostic l'affiche.
 *
 * Un repli silencieux serait dangereux : l'utilisateur croirait la clé
 * protégée par l'OS alors qu'elle est lisible par tout code tournant sous le
 * même compte. `keyStorage()` expose donc le mode effectif.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AppError } from '../error.ts';
import { ensurePrivateDir, restrictFile } from './fsGuard.ts';

export type KeyKind = 'database' | 'seal';

/** Nom du service dans le trousseau : visible par l'utilisateur. */
export const KEYRING_SERVICE = 'DepotPro';

/** Compte trousseau de chaque clé. */
export const KEYRING_ACCOUNTS: Record<KeyKind, string> = {
  database: 'database-key',
  seal: 'seal-key',
};

/** Fichiers de repli, dans le dossier de données. */
export const FALLBACK_FILENAMES: Record<KeyKind, string> = {
  database: '.depotpro-db.key',
  seal: '.depotpro-seal.key',
};

export type KeyBackend = 'os' | 'file';

export interface KeyStorage {
  backend: KeyBackend;
  /** Motif du repli fichier, `null` quand le trousseau est utilisé. */
  reason: string | null;
}

/** Encodage d'une clé sur disque : 64 caractères hexadécimaux + saut de ligne. */
function encodeKey(key: Buffer): string {
  return `${key.toString('hex')}\n`;
}

function decodeKey(raw: string, label: string): Buffer | null {
  const trimmed = raw.trim();
  if (!/^[a-f0-9]{64}$/i.test(trimmed)) {
    throw new AppError(
      'DATABASE_ERROR',
      `Clé ${label} illisible : 64 caractères hexadécimaux attendus.`,
      500
    );
  }
  return Buffer.from(trimmed, 'hex');
}

interface KeyringEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}

type KeyringFactory = (service: string, account: string) => KeyringEntry;

/**
 * Le module `@napi-rs/keyring` est natif : il peut manquer (plateforme non
 * fournie, paquet absent d'une installation allégée). L'absence doit dégrader
 * proprement vers le fichier, pas empêcher l'application de démarrer.
 */
function loadKeyring(): KeyringFactory | null {
  // Chargement synchrone volontaire : le module est natif (`.node`), donc
  // `createRequire` est nécessaire en ESM, et l'appel peut échouer sur un poste
  // où le binaire de la plateforme manque. L'échec est capturé ici et se
  // traduit par le repli fichier, jamais par un crash au démarrage.
  try {
    const requireFn = createRequire(import.meta.url);
    const mod = requireFn('@napi-rs/keyring') as {
      Entry: new (service: string, account: string) => KeyringEntry;
    };
    return (service, account) => new mod.Entry(service, account);
  } catch {
    return null;
  }
}

let keyringOverride: KeyringFactory | null | undefined;

/**
 * Point d'injection des tests : `setKeyring({ backend })`.
 *  - `undefined` → détection réelle ;
 *  - `null`      → simule l'absence de trousseau (repli fichier) ;
 *  - fonction    → trousseau en mémoire.
 */
export function setKeyringForTests(keyring: KeyringFactory | null | undefined): void {
  keyringOverride = keyring;
}

/** Trousseau en mémoire, pour les tests (jamais utilisé en production). */
export function createMemoryKeyring(): KeyringFactory {
  const store = new Map<string, string>();
  return (service, account) => {
    const id = `${service}/${account}`;
    return {
      setPassword: (password: string) => {
        store.set(id, password);
      },
      getPassword: () => store.get(id) ?? null,
      deletePassword: () => store.delete(id),
    };
  };
}

function keyring(): KeyringFactory | null {
  if (keyringOverride !== undefined) return keyringOverride;
  return loadKeyring();
}

/** Vrai si un trousseau exploitable répond (lecture d'un compte témoin). */
export function keyStorage(): KeyStorage {
  const factory = keyring();
  if (!factory) {
    return {
      backend: 'file',
      reason: "le module de trousseau du système n'est pas disponible sur ce poste.",
    };
  }
  try {
    const probe = factory(KEYRING_SERVICE, '__probe__');
    // Un `getPassword` sur un compte absent doit répondre `null` sans lever :
    // s'il lève, le service de trousseau est présent mais inutilisable
    // (session sans déverrouillage, démon Secret Service absent…).
    probe.getPassword();
    return { backend: 'os', reason: null };
  } catch (err) {
    return {
      backend: 'file',
      reason: `trousseau du système injoignable (${
        err instanceof Error ? err.message : String(err)
      }).`,
    };
  }
}

function fallbackPath(dataDir: string, kind: KeyKind): string {
  return path.join(dataDir, FALLBACK_FILENAMES[kind]);
}

function readFallback(dataDir: string, kind: KeyKind): Buffer | null {
  const filePath = fallbackPath(dataDir, kind);
  if (!fs.existsSync(filePath)) return null;
  return decodeKey(fs.readFileSync(filePath, 'utf8'), kind);
}

/** Écrit la clé de repli en 0600 (répertoire déjà privé). */
function writeFallback(dataDir: string, kind: KeyKind, key: Buffer): void {
  ensurePrivateDir(dataDir);
  const filePath = fallbackPath(dataDir, kind);
  fs.writeFileSync(filePath, encodeKey(key), { encoding: 'utf8', mode: 0o600 });
  restrictFile(filePath);
}

function readFromKeyring(kind: KeyKind): Buffer | null {
  const factory = keyring();
  if (!factory) return null;
  try {
    const raw = factory(KEYRING_SERVICE, KEYRING_ACCOUNTS[kind]).getPassword();
    if (!raw || raw.trim().length === 0) return null;
    return decodeKey(raw, kind);
  } catch {
    return null;
  }
}

function writeToKeyring(kind: KeyKind, key: Buffer): boolean {
  const factory = keyring();
  if (!factory) return false;
  try {
    factory(KEYRING_SERVICE, KEYRING_ACCOUNTS[kind]).setPassword(key.toString('hex'));
    return true;
  } catch {
    return false;
  }
}

export interface LoadKeyOptions {
  /** `false` : ne rien créer (vérification d'un sceau existant). */
  create?: boolean;
  /** Force le fichier de repli, même si un trousseau répond (tests, dépannage). */
  forceFile?: boolean;
}

export interface LoadedKey {
  key: Buffer | null;
  storage: KeyStorage;
}

/**
 * Charge (ou crée) une clé. Ordre : trousseau → fichier existant → création.
 *
 * Le fichier existant est lu AVANT de créer une clé dans le trousseau : une
 * installation mise à jour depuis le LOT 11.1 possède déjà sa clé de scellement
 * en fichier ; la remplacer casserait tous les manifestes déjà scellés.
 */
export function loadOrCreateKey(
  dataDir: string,
  kind: KeyKind,
  options: LoadKeyOptions = {}
): LoadedKey {
  const storageProbe = keyStorage();
  const useKeyring = !options.forceFile && storageProbe.backend === 'os';

  if (useKeyring) {
    const fromKeyring = readFromKeyring(kind);
    if (fromKeyring) {
      return { key: fromKeyring, storage: { backend: 'os', reason: null } };
    }
  }

  const fromFile = readFallback(dataDir, kind);
  if (fromFile) {
    // Migration ascendante : la clé existait en fichier (LOT 11.1). On la
    // recopie dans le trousseau puis on retire le fichier, sinon deux copies
    // de la même clé coexistent et la seconde devient une fuite.
    if (useKeyring && writeToKeyring(kind, fromFile)) {
      const filePath = fallbackPath(dataDir, kind);
      fs.rmSync(filePath, { force: true });
      return { key: fromFile, storage: { backend: 'os', reason: null } };
    }
    return { key: fromFile, storage: { backend: 'file', reason: storageProbe.reason } };
  }

  if (options.create === false) {
    return { key: null, storage: { backend: useKeyring ? 'os' : 'file', reason: storageProbe.reason } };
  }

  const generated = crypto.randomBytes(32);
  if (useKeyring && writeToKeyring(kind, generated)) {
    return { key: generated, storage: { backend: 'os', reason: null } };
  }
  writeFallback(dataDir, kind, generated);
  return {
    key: generated,
    storage: {
      backend: 'file',
      reason: storageProbe.reason ?? "trousseau du système indisponible à l'écriture.",
    },
  };
}

/** Copie (ou déplace) la clé de scellement historique vers le stockage courant. */
export function migrateSealKeyFile(dbFilePath: string, dataDir: string): {
  migrated: boolean;
  storage: KeyStorage;
} {
  const legacyPath = path.join(path.dirname(path.resolve(dbFilePath)), FALLBACK_FILENAMES.seal);
  if (!fs.existsSync(legacyPath)) {
    return { migrated: false, storage: keyStorage() };
  }
  const legacy = decodeKey(fs.readFileSync(legacyPath, 'utf8'), 'seal');
  if (!legacy) return { migrated: false, storage: keyStorage() };

  const loaded = loadOrCreateKey(dataDir, 'seal', { create: false });
  if (loaded.key && !loaded.key.equals(legacy)) {
    throw new AppError(
      'DATABASE_ERROR',
      "Deux clés de scellement différentes existent : le trousseau et le fichier local divergent. Sauvegardes scellées possiblement illisibles ; intervention manuelle requise.",
      500
    );
  }
  const written =
    loaded.storage.backend === 'os'
      ? writeToKeyring('seal', legacy)
      : (writeFallback(dataDir, 'seal', legacy), true);
  if (!written) {
    throw new AppError(
      'DATABASE_ERROR',
      'Impossible de déplacer la clé de scellement vers le trousseau ou le dossier de données.',
      500
    );
  }
  if (path.resolve(legacyPath) !== path.resolve(fallbackPath(dataDir, 'seal'))) {
    fs.rmSync(legacyPath, { force: true });
  }
  return { migrated: true, storage: loaded.storage };
}

/**
 * Écrit une clé en REMPLACEMENT de l'existante (rotation uniquement).
 * `loadOrCreateKey` ne convient pas : il renverrait l'ancienne valeur.
 * Le trousseau est prioritaire ; le fichier de repli est supprimé s'il existe,
 * sinon une ancienne clé resterait lisible sur disque après rotation.
 */
export function writeKeyForRotation(
  dataDir: string,
  kind: KeyKind,
  key: Buffer
): { backend: KeyBackend } {
  if (keyStorage().backend === 'os' && writeToKeyring(kind, key)) {
    fs.rmSync(fallbackPath(dataDir, kind), { force: true });
    return { backend: 'os' };
  }
  writeFallback(dataDir, kind, key);
  return { backend: 'file' };
}

/** Clé base 64 caractères hexadécimaux, forme attendue par SQLCipher. */
export function keyHex(key: Buffer): string {
  return key.toString('hex');
}
