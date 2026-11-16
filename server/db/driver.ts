/**
 * LOT 11 — Accès SQLite unique, CHIFFRABLE (SQLCipher).
 *
 * Toute la base passe par ce module : `node:sqlite` n'expose aucun `PRAGMA key`
 * fonctionnel (vérifié : le pragma est ignoré et la base reste en clair), donc
 * le chiffrement au repos impose un pilote qui embarque SQLCipher. On utilise
 * `better-sqlite3-multiple-ciphers` — prébuilds Windows/macOS/Linux, aucune
 * compilation sur le poste client.
 *
 * La façade reproduit les trois seules méthodes utilisées par les dépôts
 * (`prepare`, `exec`, `close`) et normalise les résultats :
 *   - `run()` renvoie `{ changes, lastInsertRowid }` (et non `numRowsModified`) ;
 *   - `get()` renvoie `undefined` (et non `null`) quand aucune ligne ne sort ;
 *     les tests et dépôts comparent à `undefined`, il ne faut pas changer ce
 *     contrat à la légère.
 *
 * Les bases NON chiffrées restent lisibles : un dépôt créé avant le LOT 11 est
 * détecté par son en-tête `SQLite format 3\0`, puis migré par `encryptDatabase`.
 */
import BetterSqlite from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';

export type SqlValue = string | number | bigint | null | Uint8Array;

/** Résultat minimal d'une écriture — même forme que `StatementResultingChanges`. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Contrat commun aux deux pilotes (SQLCipher et lecture seule de compatibilité). */
export interface StatementLike {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

export interface DatabaseLike {
  prepare(sql: string): StatementLike;
  exec(sql: string): void;
  close(): void;
}

/** En-tête d'une base SQLite en clair (16 octets). */
export const SQLITE_PLAINTEXT_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

interface BetterStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function wrapStatement(statement: BetterStatement): StatementLike {
  return {
    run: (...params: SqlValue[]): RunResult => {
      const result = statement.run(...(params as unknown[]));
      return { changes: Number(result.changes ?? 0), lastInsertRowid: result.lastInsertRowid ?? 0 };
    },
    // `better-sqlite3` renvoie `undefined` quand aucune ligne ne correspond :
    // c'est exactement le contrat `node:sqlite` utilisé par les dépôts.
    get: (...params: SqlValue[]): unknown => statement.get(...(params as unknown[])),
    all: (...params: SqlValue[]): unknown[] => statement.all(...(params as unknown[])),
  };
}

function wrapDatabase(db: InstanceType<typeof BetterSqlite>): DatabaseLike {
  return {
    prepare: (sql: string) => wrapStatement(db.prepare(sql) as unknown as BetterStatement),
    exec: (sql: string) => {
      db.exec(sql);
    },
    close: () => {
      db.close();
    },
  };
}

/** Clé brute SQLCipher : 64 caractères hexadécimaux, appliquée sans dérivation. */
export interface RawKey {
  hex: string;
}

export interface OpenOptions {
  /** Clé de chiffrement. Absente = base en clair (mode preview / dépôt historique). */
  key?: RawKey | null;
  readOnly?: boolean;
  /** `false` pour ouvrir une base en clair sans tenter de chiffrer. */
  createIfMissing?: boolean;
}

export interface OpenResult {
  db: DatabaseLike;
  /** `true` si le fichier était chiffré (SQLCipher) à l'ouverture. */
  encrypted: boolean;
}

/**
 * État d'un fichier de base, sans l'ouvrir :
 *  - `missing`/`empty`  : à créer (le chiffrement s'applique dès la création) ;
 *  - `plaintext`        : SQLite en clair, convertible sur place ;
 *  - `encrypted`        : illisible sans clé (SQLCipher ou fichier étranger) ;
 *  - `unknown`          : moins de 16 octets mais non vide (fichier tronqué).
 */
export type DatabaseState = 'missing' | 'empty' | 'plaintext' | 'encrypted' | 'unknown';

export function databaseState(path: string): DatabaseState {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch {
    return 'missing';
  }
  if (stat.size === 0) return 'empty';
  if (stat.size < 16) return 'unknown';
  return isPlaintextSqlite(path) ? 'plaintext' : 'encrypted';
}

/** Vrai si le fichier existe et commence par l'en-tête SQLite en clair. */
export function isPlaintextSqlite(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, 'r');
    const header = Buffer.alloc(16);
    const read = fs.readSync(fd, header, 0, 16, 0);
    return read === 16 && header.equals(SQLITE_PLAINTEXT_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function rawKeyPragma(key: RawKey): string {
  return keyPragma('key', key);
}

function keyPragma(pragma: 'key' | 'rekey', key: RawKey): string {
  // `key="x'<hex>'"` : forme recommandée pour une clé brute, sans dérivation
  // PBKDF2 (la clé a déjà 256 bits d'entropie, une dérivation n'ajouterait rien
  // et ralentirait chaque ouverture).
  if (!/^[a-f0-9]{64}$/i.test(key.hex)) {
    throw new Error('Clé SQLCipher invalide : 64 caractères hexadécimaux attendus.');
  }
  return `${pragma}="x'${key.hex}'"`;
}

function openRaw(path: string, options: OpenOptions): InstanceType<typeof BetterSqlite> {
  const db = new BetterSqlite(path, {
    readonly: options.readOnly ?? false,
    fileMustExist: options.readOnly ?? false,
  });
  if (options.key) {
    db.pragma("cipher='sqlcipher'");
    db.pragma(rawKeyPragma(options.key));
  }
  return db;
}

/**
 * Ouvre une base, chiffrée ou non.
 *
 * - clé fournie + fichier en clair  → ouverture en clair (la migration de
 *   chiffrement est faite explicitement par `encryptDatabase`, jamais à la
 *   volée : on ne veut pas réécrire 40 Mo de données au démarrage sans preuve) ;
 * - clé fournie + fichier chiffré   → SQLCipher ;
 * - aucune clé                      → base en clair (preview web).
 */
/**
 * Erreur de clé manquante : distincte d'une corruption. Le message doit
 * orienter (clé perdue = données perdues, aucune récupération possible) au
 * lieu de laisser remonter « file is not a database », qui fait croire à une
 * base corrompue et pousse à la supprimer.
 */
export class MissingDatabaseKeyError extends Error {
  constructor(path: string) {
    super(
      `La base ${path} est chiffrée et aucune clé de chiffrement n'est disponible sur ce poste. ` +
        "Le trousseau du système a peut-être été réinitialisé ou le dossier de données a été copié depuis un autre poste. " +
        "Restaurez la clé (sauvegarde du trousseau) : sans elle, les données ne sont pas récupérables."
    );
    this.name = 'MissingDatabaseKeyError';
  }
}

export function openDatabase(path: string, options: OpenOptions = {}): OpenResult {
  const state = databaseState(path);

  // Base chiffrée sans clé : refus explicite (et non une erreur SQLite brute).
  if (!options.key && state === 'encrypted') {
    throw new MissingDatabaseKeyError(path);
  }

  // Sans clé, ou base déjà en clair : ouverture standard.
  if (!options.key || state === 'plaintext') {
    const db = openRaw(path, { ...options, key: null });
    return { db: wrapDatabase(db), encrypted: false };
  }

  // Fichier absent ou vide : c'est une création. La clé est posée AVANT la
  // première écriture, sinon la base naîtrait en clair et ne serait chiffrée
  // qu'au démarrage suivant (trou mesuré : un poste neuf restait en clair
  // pendant toute sa première session).
  if (state === 'missing' || state === 'empty') {
    const db = openRaw(path, options);
    return { db: wrapDatabase(db), encrypted: Boolean(options.key) };
  }

  try {
    const db = openRaw(path, options);
    // Première lecture réelle : une mauvaise clé échoue ici, pas à l'ouverture.
    db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
    return { db: wrapDatabase(db), encrypted: true };
  } catch (err) {
    throw new Error(
      `Base chiffrée illisible : clé SQLCipher incorrecte ou fichier corrompu (${
        err instanceof Error ? err.message : String(err)
      }). Aucune donnée n'a été modifiée.`
    );
  }
}

/** Chiffre une base en clair SUR PLACE, avec copie de sécurité et vérification. */
export function encryptDatabase(
  path: string,
  key: RawKey,
  options: { preEncryptionCopyPath?: string } = {}
): { bytes: number; copyPath: string | null } {
  if (!isPlaintextSqlite(path)) {
    throw new Error('La base est déjà chiffrée : aucune migration nécessaire.');
  }
  if (!/^[a-f0-9]{64}$/i.test(key.hex)) {
    throw new Error('Clé SQLCipher invalide : 64 caractères hexadécimaux attendus.');
  }

  // 1. Copie de sécurité AVANT toute réécriture (jamais de conversion à sec).
  let copyPath: string | null = null;
  if (options.preEncryptionCopyPath) {
    copyPath = options.preEncryptionCopyPath;
    fs.copyFileSync(path, copyPath);
    if (!isPlaintextSqlite(copyPath)) {
      throw new Error('Copie de sécurité invalide : chiffrement annulé, base intacte.');
    }
  }

  const before = fs.statSync(path).size;
  const db = new BetterSqlite(path);
  try {
    // Mesuré sur SQLite3MultipleCiphers 13.x : `cipher_migrate` échoue
    // (« Rekeying failed », SQLITE_NOTADB) et poser `key` sur une base en
    // clair la rend illisible. La séquence qui chiffre réellement sur place
    // est : choisir le chiffrement, puis `rekey` AVEC la clé brute — la base
    // étant en clair, `rekey` la chiffre au lieu de la rechiffrer.
    db.pragma("cipher='sqlcipher'");
    db.pragma(keyPragma('rekey', key));
    db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
  } finally {
    db.close();
  }

  if (isPlaintextSqlite(path)) {
    throw new Error(
      `Chiffrement non effectif (en-tête SQLite en clair conservé).${
        copyPath ? ` Base de secours : ${copyPath}.` : ''
      }`
    );
  }
  return { bytes: before, copyPath };
}

/**
 * Rechiffre une base DÉJÀ chiffrée avec une nouvelle clé (rotation).
 * Utilisé au lot 11.6 pour déplacer la clé du fichier local vers le trousseau.
 */
export function rekeyDatabase(path: string, currentKey: RawKey, nextKey: RawKey): void {
  const db = new BetterSqlite(path);
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma(rawKeyPragma(currentKey));
    // Première lecture réelle avec l'ancienne clé : sans elle, `rekey` échoue
    // et laisse la base dans son état d'origine (heureusement atomique).
    db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
    db.pragma(keyPragma('rekey', nextKey));
    db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
  } finally {
    db.close();
  }
}
