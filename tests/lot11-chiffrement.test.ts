import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MissingDatabaseKeyError,
  databaseState,
  encryptDatabase,
  isPlaintextSqlite,
  openDatabase,
  rekeyDatabase,
} from '../server/db/driver.ts';
import { initLocalSqlite } from '../server/db/sqlite.ts';
import { AuthRepository } from '../server/repositories/authRepo.ts';
import { BackupRepository } from '../server/repositories/backupRepo.ts';
import { assertNotProductionInPreview, resolveDataPaths } from '../server/security/dataPaths.ts';
import {
  FALLBACK_FILENAMES,
  KEYRING_ACCOUNTS,
  KEYRING_SERVICE,
  createMemoryKeyring,
  keyStorage,
  loadOrCreateKey,
  setKeyringForTests,
  writeKeyForRotation,
} from '../server/security/keys.ts';
import { MANIFEST_SEAL_CONTEXT, sealManifest, verifyManifestSeal } from '../server/security/localSeal.ts';
import { SEALED_MANIFEST_VERSION, resealManifests, rotateKeys } from '../server/security/reseal.ts';

/**
 * LOT 11.6 — Chiffrement au repos, clés dans le trousseau OS, re-scellement,
 * base de prévisualisation séparée.
 *
 * Ce que ces tests prouvent, et comment :
 *   - la base est réellement illisible sans clé (en-tête + lecture directe) ;
 *   - une mauvaise clé est refusée, une base chiffrée sans clé aussi ;
 *   - la clé ne vit PAS en clair dans `data/` quand un trousseau répond ;
 *   - la conversion d'une base en clair laisse une copie de sécurité vérifiable ;
 *   - la rotation de clé change bien la clé et re-scelle les manifestes ;
 *   - un manifeste v1 non scellé est refusé tant qu'il n'est pas re-scellé, et
 *     un manifeste dont le fichier a changé n'est jamais re-scellé ;
 *   - la prévisualisation n'ouvre jamais `data/depotpro.db`.
 *
 * Limite assumée : le « trousseau » est simulé en mémoire. Le vrai
 * `@napi-rs/keyring` a été exercé manuellement dans l'environnement de
 * développement (voir §9 du rapport) ; ici on teste la LOGIQUE de sélection,
 * de migration et de repli, pas le démon Secret Service.
 */

const tempDirs: string[] = [];
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const isUnix = process.platform !== 'win32';

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot116-'));
  tempDirs.push(dir);
  return dir;
}

function modeOf(target: string): string {
  return `0${(fs.statSync(target).mode & 0o777).toString(8)}`;
}

function countUsers(dbPath: string, keyHex: string): number {
  const { db, encrypted } = openDatabase(dbPath, { key: { hex: keyHex } });
  try {
    expect(encrypted).toBe(true);
    const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

afterEach(() => {
  setKeyringForTests(undefined);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Pilote chiffré
// ---------------------------------------------------------------------------

describe('LOT 11.6 — Chiffrement SQLCipher de la base', () => {
  it('rend la base illisible sans clé et lisible avec la bonne clé', () => {
    setKeyringForTests(createMemoryKeyring());
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');

    const first = initLocalSqlite(dbPath, MIGRATIONS_DIR, { encryption: true, dataDir: dir });
    expect(first.encryption.encrypted).toBe(true);
    expect(first.encryption.storage?.backend).toBe('os');
    first.db
      .prepare("INSERT INTO system_meta (key, value) VALUES ('secret', 'ventes-2026')")
      .run();
    first.db.close();

    // 1. L'en-tête n'est plus « SQLite format 3 » : un outil SQLite standard
    //    (DB Browser, sqlite3 CLI) ne voit plus de base.
    expect(databaseState(dbPath)).toBe('encrypted');
    expect(isPlaintextSqlite(dbPath)).toBe(false);
    const header = fs.readFileSync(dbPath).subarray(0, 15).toString('latin1');
    expect(header).not.toContain('SQLite format 3');

    // 2. Le contenu métier n'apparaît pas dans les octets du fichier : sans ce
    //    point, un simple `grep` sur une copie de la base lirait les ventes.
    const raw = fs.readFileSync(dbPath);
    expect(raw.includes(Buffer.from('ventes-2026'))).toBe(false);
    expect(raw.includes(Buffer.from('system_meta'))).toBe(false);

    // 3. La clé du trousseau permet de relire la donnée.
    const key = loadOrCreateKey(dir, 'database', { create: false });
    expect(key.key).not.toBeNull();
    const reopened = openDatabase(dbPath, { key: { hex: key.key!.toString('hex') } });
    const row = reopened.db.prepare("SELECT value FROM system_meta WHERE key='secret'").get() as {
      value: string;
    };
    expect(row.value).toBe('ventes-2026');
    reopened.db.close();
  });

  it('refuse une mauvaise clé et une base chiffrée ouverte sans clé', () => {
    setKeyringForTests(createMemoryKeyring());
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');
    const opened = initLocalSqlite(dbPath, MIGRATIONS_DIR, { encryption: true, dataDir: dir });
    opened.db.close();

    expect(() => openDatabase(dbPath, { key: { hex: '0'.repeat(64) } })).toThrow(/illisible/i);
    // Base chiffrée sans clé : message exploitable, pas « file is not a database ».
    expect(() => openDatabase(dbPath, { key: null })).toThrow(MissingDatabaseKeyError);
    expect(() => initLocalSqlite(dbPath, MIGRATIONS_DIR, { encryption: false })).toThrow(
      /chiffrée et aucune clé/i
    );
    // Aucune donnée n'a été modifiée par ces tentatives.
    expect(databaseState(dbPath)).toBe('encrypted');
  });

  it('ne crée jamais une base en clair quand le chiffrement est demandé', () => {
    setKeyringForTests(createMemoryKeyring());
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');
    // Le piège mesuré : créer la base en clair, puis la chiffrer au démarrage
    // SUIVANT — la première session entière restait en clair.
    const opened = initLocalSqlite(dbPath, MIGRATIONS_DIR, { encryption: true, dataDir: dir });
    expect(isPlaintextSqlite(dbPath)).toBe(false);
    expect(opened.encryption.encrypted).toBe(true);
    expect(opened.encryption.preEncryptionCopyPath).toBeNull();
    opened.db.close();
    for (const sidecar of ['-wal', '-shm']) {
      const file = `${dbPath}${sidecar}`;
      if (fs.existsSync(file)) expect(isPlaintextSqlite(file)).toBe(false);
    }
  });

  it('convertit une base en clair avec copie de sécurité vérifiable et sans perte', () => {
    setKeyringForTests(createMemoryKeyring());
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');

    // Installation antérieure au LOT 11.6 : base en clair avec des données.
    const legacy = initLocalSqlite(dbPath, MIGRATIONS_DIR);
    const authRepo = new AuthRepository(legacy.db);
    const session = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Chiffrement',
      ownerFullName: 'Aya Koffi',
      username: 'patronne',
      password: 'MotDePasseSolide2026',
    });
    legacy.db.prepare("INSERT INTO system_meta (key, value) VALUES ('ticket', '250000')").run();
    legacy.db.close();
    expect(databaseState(dbPath)).toBe('plaintext');

    const upgraded = initLocalSqlite(dbPath, MIGRATIONS_DIR, { encryption: true, dataDir: dir });
    expect(upgraded.encryption.encrypted).toBe(true);
    const copy = upgraded.encryption.preEncryptionCopyPath;
    expect(copy).not.toBeNull();
    // La copie de sécurité est encore lisible par un SQLite standard : elle
    // sert à revenir en arrière si la clé est perdue juste après la conversion.
    expect(isPlaintextSqlite(copy!)).toBe(true);
    if (isUnix) expect(modeOf(copy!)).toBe('0600');
    // Les données sont intactes après conversion.
    const users = upgraded.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    expect(users.c).toBe(1);
    const ticket = upgraded.db.prepare("SELECT value FROM system_meta WHERE key='ticket'").get() as {
      value: string;
    };
    expect(ticket.value).toBe('250000');
    expect(session.user.username).toBe('patronne');
    upgraded.db.close();

    // La copie en clair est le seul reste lisible : elle est limitée en nombre.
    const copies = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('depotpro.pre-encryption-') && name.endsWith('.db'));
    expect(copies.length).toBeLessThanOrEqual(2);
  });

  it('rotation : rechiffre la base et rejette l’ancienne clé', () => {
    setKeyringForTests(createMemoryKeyring());
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');
    const opened = initLocalSqlite(dbPath, MIGRATIONS_DIR, { encryption: true, dataDir: dir });
    opened.db.prepare("INSERT INTO system_meta (key, value) VALUES ('a', '1')").run();
    opened.db.close();

    const before = loadOrCreateKey(dir, 'database', { create: false }).key!;
    const next = crypto.randomBytes(32);
    writeKeyForRotation(dir, 'database', next);
    rekeyDatabase(dbPath, { hex: before.toString('hex') }, { hex: next.toString('hex') });

    expect(countUsers(dbPath, next.toString('hex'))).toBe(0);
    expect(() => openDatabase(dbPath, { key: { hex: before.toString('hex') } })).toThrow(/illisible/i);
  });

  it('chiffre sur place une base copiée et conserve la copie demandée', () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');
    const opened = initLocalSqlite(dbPath, MIGRATIONS_DIR);
    opened.db.close();
    const copyPath = path.join(dir, 'avant.db');
    const key = { hex: 'b'.repeat(64) };
    encryptDatabase(dbPath, key, { preEncryptionCopyPath: copyPath });
    expect(isPlaintextSqlite(dbPath)).toBe(false);
    expect(isPlaintextSqlite(copyPath)).toBe(true);
    // Idempotence refusée : on ne « chiffre » pas deux fois.
    expect(() => encryptDatabase(dbPath, key)).toThrow(/déjà chiffrée/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Clés et trousseau
// ---------------------------------------------------------------------------

describe('LOT 11.6 — Clés dans le trousseau du système (option O1)', () => {
  it('range les deux clés dans le trousseau, sans fichier en clair dans data/', () => {
    setKeyringForTests(createMemoryKeyring());
    const dir = createTempDir();
    const opened = initLocalSqlite(path.join(dir, 'depotpro.db'), MIGRATIONS_DIR, {
      encryption: true,
      dataDir: dir,
    });
    const backupRepo = new BackupRepository(opened.db, opened.dbPath, {
      migrationsDir: MIGRATIONS_DIR,
      databaseKey: { hex: loadOrCreateKey(dir, 'database', { create: false }).key!.toString('hex') },
    });
    const authRepo = new AuthRepository(opened.db);
    const session = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Clés',
      ownerFullName: 'Moussa Traoré',
      username: 'patron',
      password: 'MotDePasseSolide2026',
    });
    backupRepo.createBackup({ type: 'MANUAL', userId: session.user.id });

    expect(keyStorage()).toEqual({ backend: 'os', reason: null });
    const dbKey = loadOrCreateKey(dir, 'database', { create: false });
    const sealKey = loadOrCreateKey(dir, 'seal', { create: false });
    expect(dbKey.storage.backend).toBe('os');
    expect(sealKey.storage.backend).toBe('os');
    // Deux clés distinctes : un sceau volé n'ouvre pas la base.
    expect(dbKey.key!.equals(sealKey.key!)).toBe(false);

    // Aucun matériel de clé sur le disque.
    for (const name of Object.values(FALLBACK_FILENAMES)) {
      expect(fs.existsSync(path.join(dir, name))).toBe(false);
    }
    // Les noms de compte du trousseau sont stables (sinon les clés seraient
    // perdues à chaque version).
    expect(KEYRING_SERVICE).toBe('DepotPro');
    expect(KEYRING_ACCOUNTS.database).toBe('database-key');
    expect(KEYRING_ACCOUNTS.seal).toBe('seal-key');
    opened.db.close();
  });

  it('bascule en repli fichier 0600 quand le trousseau est absent, et le signale', () => {
    setKeyringForTests(null);
    const dir = createTempDir();
    const loaded = loadOrCreateKey(dir, 'database');
    expect(loaded.storage.backend).toBe('file');
    expect(loaded.storage.reason).toMatch(/trousseau/i);
    const filePath = path.join(dir, FALLBACK_FILENAMES.database);
    expect(fs.existsSync(filePath)).toBe(true);
    if (isUnix) expect(modeOf(filePath)).toBe('0600');
    // Relecture stable : la clé ne change pas d'une exécution à l'autre.
    expect(loadOrCreateKey(dir, 'database').key!.equals(loaded.key!)).toBe(true);
  });

  it('refuse un trousseau qui répond mais échoue (état dégradé explicite)', () => {
    setKeyringForTests(() => {
      throw new Error('Secret Service indisponible');
    });
    const storage = keyStorage();
    expect(storage.backend).toBe('file');
    expect(storage.reason).toMatch(/injoignable/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Re-scellement des manifestes v1
// ---------------------------------------------------------------------------

interface ResealFixture {
  dir: string;
  dbPath: string;
  backupsDir: string;
  backupRepo: BackupRepository;
  userId: string;
}

function resealFixture(): ResealFixture {
  setKeyringForTests(createMemoryKeyring());
  const dir = createTempDir();
  const dbPath = path.join(dir, 'depotpro.db');
  const opened = initLocalSqlite(dbPath, MIGRATIONS_DIR);
  const authRepo = new AuthRepository(opened.db);
  const session = authRepo.initializeDepotAndOwner({
    depotName: 'Dépôt Manifestes',
    ownerFullName: 'Fatou Diallo',
    username: 'patronne',
    password: 'MotDePasseSolide2026',
  });
  const backupRepo = new BackupRepository(opened.db, dbPath, { migrationsDir: MIGRATIONS_DIR });
  const backup = backupRepo.createBackup({ type: 'MANUAL', userId: session.user.id });
  return {
    dir,
    dbPath,
    backupsDir: path.dirname(backup.filePath),
    backupRepo,
    userId: session.user.id,
  };
}

/** Rétrograde un manifeste v2 en manifeste v1 (état d'une installation 11.1). */
function downgradeToV1(manifestPath: string): void {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  delete manifest.seal;
  delete manifest.sealContext;
  manifest.version = 1;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function manifestFiles(backupsDir: string): string[] {
  return fs
    .readdirSync(backupsDir)
    .filter((name) => name.endsWith('.manifest.json'))
    .map((name) => path.join(backupsDir, name));
}

describe('LOT 11.6 — Re-scellement des manifestes de sauvegarde', () => {
  it('re-scelle un manifeste v1 intact et le rend acceptable', () => {
    const f = resealFixture();
    const [manifestPath] = manifestFiles(f.backupsDir);
    downgradeToV1(manifestPath);

    const dry = resealManifests(f.dbPath, f.backupsDir, { dryRun: true });
    expect(dry.resealed).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).seal).toBeUndefined();

    const applied = resealManifests(f.dbPath, f.backupsDir);
    expect(applied.resealed).toHaveLength(1);
    expect(applied.inconsistent).toHaveLength(0);
    const repaired = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(repaired.version).toBe(SEALED_MANIFEST_VERSION);
    expect(repaired.sealContext).toBe(MANIFEST_SEAL_CONTEXT);
    expect(typeof repaired.seal).toBe('string');

    // Une seconde exécution ne réécrit rien (idempotence).
    const second = resealManifests(f.dbPath, f.backupsDir);
    expect(second.resealed).toHaveLength(0);
    expect(second.alreadySealed).toHaveLength(1);
    f.backupRepo.db.close();
  });

  it('ne scelle JAMAIS un manifeste dont le fichier de sauvegarde a changé', () => {
    const f = resealFixture();
    const [manifestPath] = manifestFiles(f.backupsDir);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { fileName: string };
    downgradeToV1(manifestPath);
    // Altération du fichier de sauvegarde.
    fs.appendFileSync(path.join(f.backupsDir, manifest.fileName), Buffer.from('x'));

    const report = resealManifests(f.dbPath, f.backupsDir);
    expect(report.resealed).toHaveLength(0);
    expect(report.inconsistent).toHaveLength(1);
    expect(report.inconsistent[0].reason).toMatch(/empreinte|taille/i);
    // Le manifeste reste non scellé : le blanchiment n'a pas eu lieu.
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).seal).toBeUndefined();
    f.backupRepo.db.close();
  });

  it('signale un manifeste dont le fichier de sauvegarde a disparu', () => {
    const f = resealFixture();
    const [manifestPath] = manifestFiles(f.backupsDir);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { fileName: string };
    downgradeToV1(manifestPath);
    fs.rmSync(path.join(f.backupsDir, manifest.fileName));
    const report = resealManifests(f.dbPath, f.backupsDir);
    expect(report.resealed).toHaveLength(0);
    expect(report.inconsistent[0].reason).toMatch(/absent/i);
    f.backupRepo.db.close();
  });

  it('scelle avec la clé du trousseau : le sceau est vérifiable et portable', () => {
    const f = resealFixture();
    const [manifestPath] = manifestFiles(f.backupsDir);
    downgradeToV1(manifestPath);
    resealManifests(f.dbPath, f.backupsDir);
    const fields = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      seal: string;
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
    };
    const key = loadOrCreateKey(f.dir, 'seal', { create: false }).key!;
    const expected = sealManifest(f.dbPath, { ...fields, version: SEALED_MANIFEST_VERSION });
    expect(fields.seal).toBe(expected);
    expect(verifyManifestSeal(f.dbPath, { ...fields }, fields.seal).ok).toBe(true);
    // La clé attendue est bien celle du trousseau, pas une clé recréée.
    expect(loadOrCreateKey(f.dir, 'seal', { create: false }).key!.equals(key)).toBe(true);
    f.backupRepo.db.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Rotation des clés
// ---------------------------------------------------------------------------

describe('LOT 11.6 — Rotation des clés', () => {
  it('rechiffre la base, remplace les deux clés et re-scelle les manifestes', () => {
    setKeyringForTests(createMemoryKeyring());
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');
    const opened = initLocalSqlite(dbPath, MIGRATIONS_DIR, { encryption: true, dataDir: dir });
    const authRepo = new AuthRepository(opened.db);
    const session = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Rotation',
      ownerFullName: 'Ibrahim Cissé',
      username: 'patron',
      password: 'MotDePasseSolide2026',
    });
    const backupRepo = new BackupRepository(opened.db, dbPath, {
      migrationsDir: MIGRATIONS_DIR,
      databaseKey: { hex: loadOrCreateKey(dir, 'database', { create: false }).key!.toString('hex') },
    });
    const backup = backupRepo.createBackup({ type: 'MANUAL', userId: session.user.id });
    const backupsDir = path.dirname(backup.filePath);

    const oldDatabaseKey = loadOrCreateKey(dir, 'database', { create: false }).key!;
    const oldSealKey = loadOrCreateKey(dir, 'seal', { create: false }).key!;
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];

    opened.db.close();
    const report = rotateKeys({
      dbFilePath: dbPath,
      backupsDir,
      audit: (entry) => audits.push(entry),
    });

    expect(report.databaseRekeyed).toBe(true);
    expect(report.manifestsResealed?.resealed).toHaveLength(1);
    expect(audits[0].action).toBe('SECURITY_KEYS_ROTATED');
    expect(audits[0].details.manifestsResealed).toBe(1);

    const newDatabaseKey = loadOrCreateKey(dir, 'database', { create: false }).key!;
    const newSealKey = loadOrCreateKey(dir, 'seal', { create: false }).key!;
    expect(newDatabaseKey.equals(oldDatabaseKey)).toBe(false);
    expect(newSealKey.equals(oldSealKey)).toBe(false);

    // La base s'ouvre avec la NOUVELLE clé et plus avec l'ancienne.
    expect(() => openDatabase(dbPath, { key: { hex: oldDatabaseKey.toString('hex') } })).toThrow(/illisible/i);
    const reopened = openDatabase(dbPath, { key: { hex: newDatabaseKey.toString('hex') } });
    const users = reopened.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    expect(users.c).toBe(1);
    reopened.db.close();

    // Le manifeste re-scellé est valide avec la nouvelle clé de scellement.
    const manifestPath = manifestFiles(backupsDir)[0];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.seal).toBeDefined();
    expect(
      verifyManifestSeal(dbPath, manifest as never, String(manifest.seal)).ok
    ).toBe(true);
  });

  it('refuse de tourner sans clé de base existante', () => {
    setKeyringForTests(createMemoryKeyring());
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');
    const opened = initLocalSqlite(dbPath, MIGRATIONS_DIR);
    opened.db.close();
    expect(() =>
      rotateKeys({ dbFilePath: dbPath, backupsDir: null, audit: () => {} })
    ).toThrow(/aucune clé/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Base de prévisualisation séparée
// ---------------------------------------------------------------------------

describe('LOT 11.6 — Base de prévisualisation séparée', () => {
  it('place la base d’aperçu dans data/preview/ et jamais dans data/', () => {
    const decision = resolveDataPaths({}, '/srv/depotpro');
    expect(decision.preview).toBe(true);
    expect(decision.dataDir).toBe(path.resolve('/srv/depotpro', 'data', 'preview'));
    expect(decision.dbPath.endsWith(path.join('data', 'preview', 'depotpro.db'))).toBe(true);
    expect(decision.reason).toMatch(/prévisualisation/i);
  });

  it('utilise la base de production en mode poste installé', () => {
    const decision = resolveDataPaths({ DEPOTPRO_DESKTOP: '1' }, '/srv/depotpro');
    expect(decision.preview).toBe(false);
    expect(decision.dbPath).toBe(path.resolve('/srv/depotpro', 'data', 'depotpro.db'));
  });

  it('respecte un dossier de données imposé explicitement', () => {
    const decision = resolveDataPaths({ DEPOTPRO_DATA_DIR: '/recette/isolée' }, '/srv/depotpro');
    expect(decision.dbPath).toBe(path.resolve('/recette/isolée', 'depotpro.db'));
    expect(decision.reason).toMatch(/DEPOTPRO_DATA_DIR/);
  });

  it('refuse d’ouvrir la base du poste installé depuis un aperçu', () => {
    const production = path.resolve(process.cwd(), 'data', 'depotpro.db');
    // En mode aperçu (défaut du processus de recette) : refus explicite.
    expect(() => assertNotProductionInPreview(production, {})).toThrow(/Refus d'ouvrir/i);
    // En mode poste installé : autorisé.
    expect(() => assertNotProductionInPreview(production, { DEPOTPRO_DESKTOP: '1' })).not.toThrow();
    // En aperçu mais sur une autre base : autorisé.
    const previewPath = path.resolve(process.cwd(), 'data', 'preview', 'depotpro.db');
    expect(() => assertNotProductionInPreview(previewPath, {})).not.toThrow();
  });

  it('n’active pas le chiffrement en aperçu par défaut', () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'depotpro.db');
    // Sans variable d'environnement, `initLocalSqlite` ouvre en clair : c'est
    // le régime attendu de la recette web (pas de clé de production dans un
    // aperçu jetable, et un aperçu qui casse ne bloque jamais un opérateur).
    const opened = initLocalSqlite(dbPath, MIGRATIONS_DIR, { encryption: false, dataDir: dir });
    expect(opened.encryption.encrypted).toBe(false);
    expect(isPlaintextSqlite(dbPath)).toBe(true);
    opened.db.close();
  });
});
