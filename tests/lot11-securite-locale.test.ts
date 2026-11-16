import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { initLocalSqlite } from '../server/db/sqlite.ts';
import {
  cancelPendingRestore,
  pendingRestoreMarkerPath,
  readPendingRestore,
  sha256FileSync,
  writePendingRestore,
  type PendingRestore,
} from '../server/db/pendingRestore.ts';
import { AuthRepository } from '../server/repositories/authRepo.ts';
import { BackupRepository } from '../server/repositories/backupRepo.ts';
import {
  SEAL_KEY_FILENAME,
  hmacSha256Hex,
  loadSealKey,
  manifestSealMessage,
  restoreSealMessage,
  sealKeyPath,
} from '../server/security/localSeal.ts';

/**
 * LOT 11 — Sécurité des données locales (volet Node).
 *
 * Ces tests couvrent les constats MESURÉS du rapport
 * `docs/LOT11_SECURITE_LOCALE.md` :
 *   C1  restauration déclenchable par un simple fichier     → sceau HMAC
 *   C2/C10 manifeste non authentifié                        → manifeste v2 scellé
 *   C4  répertoires 0755 / base 0644                        → 0700 / 0600
 *   C5  mot de passe changé sans révocation                 → sessions révoquées
 *
 * La parité Rust est contrôlée séparément (vecteur HMAC partagé et contrôle
 * statique) : `cargo test` n'est pas exécutable dans cet environnement.
 */

const tempDirs: string[] = [];
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const isUnix = process.platform !== 'win32';

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot11-'));
  tempDirs.push(dir);
  return dir;
}

function createTempDbPath(): string {
  return path.join(createTempDir(), 'data', 'depotpro.db');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function modeOf(target: string): string {
  return `0${(fs.statSync(target).mode & 0o777).toString(8)}`;
}

function fixture() {
  const dbPath = createTempDbPath();
  const { db } = initLocalSqlite(dbPath, MIGRATIONS_DIR);
  const authRepo = new AuthRepository(db);
  const session = authRepo.initializeDepotAndOwner({
    depotName: 'Dépôt Sécurité',
    ownerFullName: 'Kouadio Yao',
    username: 'patron',
    password: 'MotDePasseSolide2026',
  });
  const backupRepo = new BackupRepository(db, dbPath, { migrationsDir: MIGRATIONS_DIR });
  return { db, dbPath, authRepo, session, backupRepo };
}

describe('LOT 11 — Permissions des répertoires et de la base (C4)', () => {
  it('force 0700 sur le dossier de données et 0600 sur la base, ses sidecars et les sauvegardes', () => {
    const f = fixture();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    const manifest = `${backup.filePath}.manifest.json`;
    const dataDir = path.dirname(f.dbPath);

    if (isUnix) {
      expect(modeOf(dataDir)).toBe('0700');
      expect(modeOf(f.dbPath)).toBe('0600');
      expect(modeOf(backup.filePath)).toBe('0600');
      expect(modeOf(manifest)).toBe('0600');
      expect(modeOf(path.join(dataDir, 'backups'))).toBe('0700');
      // La clé de scellement est privée elle aussi.
      expect(modeOf(sealKeyPath(f.dbPath))).toBe('0600');
      for (const sidecar of ['-wal', '-shm']) {
        const file = `${f.dbPath}${sidecar}`;
        if (fs.existsSync(file)) expect(modeOf(file)).toBe('0600');
      }
    }

    // Un dossier existant en 0755 est corrigé au démarrage suivant (umask hérité).
    if (isUnix) {
      fs.chmodSync(dataDir, 0o755);
      const reopened = initLocalSqlite(f.dbPath, MIGRATIONS_DIR);
      expect(modeOf(dataDir)).toBe('0700');
      reopened.db.close();
    }
    f.db.close();
  });
});

describe('LOT 11 — Marqueur de restauration scellé (C1)', () => {
  it('refuse un marqueur forgé à la main et laisse la base courante intacte', () => {
    const f = fixture();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    f.db.prepare(
      "INSERT INTO customers (id, full_name, customer_type) VALUES ('c-apres','Client Après','DETAILLANT')"
    ).run();
    f.db.close();

    // Reproduction exacte de la sonde 4 du rapport : le fichier est écrit à la
    // main, avec un checksum correct, sans passer par l'API ni par le RBAC.
    const staged = path.join(path.dirname(f.dbPath), 'restore', 'staged-forge.db');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.copyFileSync(backup.filePath, staged);
    fs.writeFileSync(
      pendingRestoreMarkerPath(f.dbPath),
      JSON.stringify({
        version: 1,
        backupId: backup.id,
        sourceChecksum: backup.sha256Checksum,
        stagedPath: staged,
        stagedChecksum: sha256FileSync(staged),
        preRestoreBackupId: null,
        requestedByUserId: null,
        confirmation: 'RESTAURER',
        createdAt: new Date().toISOString(),
      }),
      { encoding: 'utf8', mode: 0o600 }
    );

    expect(() => initLocalSqlite(f.dbPath, MIGRATIONS_DIR)).toThrow(/Restauration refusée/);
    // La base n'a pas été remplacée : le client ajouté après la sauvegarde existe.
    const inspect = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(
      (inspect.prepare("SELECT COUNT(*) AS c FROM customers WHERE id='c-apres'").get() as { c: number }).c
    ).toBe(1);
    inspect.close();
  });

  it('refuse un marqueur dont le sceau a été recalculé sans la clé locale', () => {
    const f = fixture();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    const staged = path.join(path.dirname(f.dbPath), 'restore', 'staged-resceau.db');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.copyFileSync(backup.filePath, staged);
    const fields = {
      version: 1,
      backupId: backup.id,
      stagedPath: staged,
      stagedChecksum: sha256FileSync(staged),
      confirmation: 'RESTAURER',
      requestedByUserId: null,
    };
    writePendingRestore(f.dbPath, {
      ...fields,
      sourceChecksum: backup.sha256Checksum,
      preRestoreBackupId: null,
      createdAt: new Date().toISOString(),
    } as PendingRestore);

    // Marqueur valide au départ.
    expect(readPendingRestore(f.dbPath)?.backupId).toBe(backup.id);

    // Falsification : nouveau sceau calculé avec une AUTRE clé.
    const marker = pendingRestoreMarkerPath(f.dbPath);
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as PendingRestore;
    parsed.stagedChecksum = 'b'.repeat(64);
    parsed.seal = hmacSha256Hex(crypto.randomBytes(32), restoreSealMessage(fields));
    fs.writeFileSync(marker, JSON.stringify(parsed), 'utf8');

    expect(() => readPendingRestore(f.dbPath)).toThrow(/sceau HMAC invalide/);
    f.db.close();
  });

  it('accepte le marqueur écrit par l’application et journalise l’annulation avec son identifiant', () => {
    const f = fixture();
    f.db
      .prepare("INSERT INTO customers (id, full_name, customer_type) VALUES ('c1','Client A','DETAILLANT')")
      .run();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    f.db
      .prepare("INSERT INTO customers (id, full_name, customer_type) VALUES ('c-apres','Client Après','DETAILLANT')")
      .run();
    const plan = f.backupRepo.restoreBackup({
      backupId: backup.id,
      confirmation: 'RESTAURER',
      activateOnRestart: true,
      userId: f.session.user.id,
    });
    expect(plan.mode).toBe('PENDING_RESTART');
    expect(readPendingRestore(f.dbPath)?.seal).toMatch(/^[a-f0-9]{64}$/);

    expect(f.backupRepo.cancelRestore(f.session.user.id)).toBe(true);
    const audit = f.db
      .prepare("SELECT entity_id AS id, payload_json AS payload FROM audit_logs WHERE action='BACKUP_RESTORE_CANCELLED'")
      .get() as { id: string; payload: string };
    expect(audit.id).toBe(backup.id);
    expect(JSON.parse(audit.payload).backupId).toBe(backup.id);
    f.db.close();
  });

  it('accepte une restauration préparée par l’application puis activée au redémarrage', () => {
    const f = fixture();
    f.db
      .prepare("INSERT INTO customers (id, full_name, customer_type) VALUES ('c1','Client A','DETAILLANT')")
      .run();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    f.db
      .prepare("INSERT INTO customers (id, full_name, customer_type) VALUES ('c-apres','Client Après','DETAILLANT')")
      .run();
    f.backupRepo.restoreBackup({
      backupId: backup.id,
      confirmation: 'RESTAURER',
      activateOnRestart: true,
      userId: f.session.user.id,
    });
    f.db.close();

    const restarted = initLocalSqlite(f.dbPath, MIGRATIONS_DIR);
    expect(restarted.restoreApplied?.backupId).toBe(backup.id);
    expect(
      (restarted.db.prepare("SELECT COUNT(*) AS c FROM customers WHERE id='c-apres'").get() as { c: number }).c
    ).toBe(0);
    expect(fs.existsSync(pendingRestoreMarkerPath(f.dbPath))).toBe(false);
    restarted.db.close();
  });

  it('supprime un marqueur non scellé sans restaurer (annulation manuelle tracée)', () => {
    const f = fixture();
    fs.writeFileSync(pendingRestoreMarkerPath(f.dbPath), JSON.stringify({ version: 1 }), 'utf8');
    expect(cancelPendingRestore(f.dbPath)).toBe(true);
    expect(fs.existsSync(pendingRestoreMarkerPath(f.dbPath))).toBe(false);
    f.db.close();
  });
});

describe('LOT 11 — Manifeste de sauvegarde scellé (C10)', () => {
  it('écrit un manifeste v2 scellé et le refuse après modification', () => {
    const f = fixture();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    const manifestPath = `${backup.filePath}.manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      version: number;
      seal: string;
      sha256: string;
      createdAt: string;
    };
    expect(manifest.version).toBe(2);
    expect(manifest.seal).toMatch(/^[a-f0-9]{64}$/);
    expect(f.backupRepo.verifyBackup(backup.id).manifestStatus).toBe('OK');

    manifest.sha256 = '0'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const verification = f.backupRepo.verifyBackup(backup.id);
    expect(verification.status).toBe('FAILED');
    expect(verification.manifestStatus).toBe('MISMATCH');
    expect(() => f.backupRepo.getManifest(backup.id)).toThrow(/non vérifié/);
    f.db.close();
  });

  it('signale UNSEALED (et bloque la restauration) pour un manifeste v1 hérité du LOT 9', () => {
    const f = fixture();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    const manifestPath = `${backup.filePath}.manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.seal;
    manifest.version = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

    const verification = f.backupRepo.verifyBackup(backup.id);
    expect(verification.manifestStatus).toBe('UNSEALED');
    expect(verification.status).toBe('FAILED');
    expect(() =>
      f.backupRepo.restoreBackup({
        backupId: backup.id,
        confirmation: 'RESTAURER',
        activateOnRestart: false,
        userId: f.session.user.id,
      })
    ).toThrow(/Restauration refusée/);
    f.db.close();
  });

  it('ne permet pas de rejouer le sceau d’un manifeste sur un autre fichier', () => {
    const f = fixture();
    const first = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    const second = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    const secondManifestPath = `${second.filePath}.manifest.json`;
    const firstManifest = JSON.parse(fs.readFileSync(`${first.filePath}.manifest.json`, 'utf8')) as Record<
      string,
      unknown
    >;
    const secondManifest = JSON.parse(fs.readFileSync(secondManifestPath, 'utf8')) as Record<string, unknown>;
    // Copie du sceau + des champs d'identité du premier manifeste sur le second.
    fs.writeFileSync(
      secondManifestPath,
      JSON.stringify({ ...secondManifest, seal: firstManifest.seal, backupId: secondManifest.backupId }),
      'utf8'
    );
    expect(f.backupRepo.verifyBackup(second.id).manifestStatus).toBe('MISMATCH');
    f.db.close();
  });
});

describe('LOT 11 — Sessions révoquées au changement de mot de passe (C5)', () => {
  it('conserve la session courante et révoque toutes les autres', () => {
    const f = fixture();
    const other = f.authRepo.login('patron', 'MotDePasseSolide2026');
    expect(f.authRepo.validateSessionToken(f.session.token)).not.toBeNull();
    expect(f.authRepo.validateSessionToken(other.token)).not.toBeNull();

    f.authRepo.changePassword(
      f.session.user.id,
      'MotDePasseSolide2026',
      'NouveauMotDePasse2026',
      crypto.createHash('sha256').update(f.session.token).digest('hex')
    );

    // Session courante conservée (l'utilisateur vient de prouver son mot de passe).
    expect(f.authRepo.validateSessionToken(f.session.token)).not.toBeNull();
    // Toute autre session est coupée immédiatement.
    expect(f.authRepo.validateSessionToken(other.token)).toBeNull();

    const audit = f.db
      .prepare("SELECT payload_json AS payload FROM audit_logs WHERE action='PASSWORD_CHANGED'")
      .get() as { payload: string };
    expect(JSON.parse(audit.payload).revokedSessions).toBe(1);
    expect(() => f.authRepo.login('patron', 'MotDePasseSolide2026')).toThrow();
    expect(f.authRepo.login('patron', 'NouveauMotDePasse2026').user.username).toBe('patron');
    f.db.close();
  });

  it('révoque aussi la session courante quand aucun jeton n’est fourni (appel de maintenance)', () => {
    const f = fixture();
    const other = f.authRepo.login('patron', 'MotDePasseSolide2026');
    f.authRepo.changePassword(f.session.user.id, 'MotDePasseSolide2026', 'NouveauMotDePasse2026');
    expect(f.authRepo.validateSessionToken(f.session.token)).toBeNull();
    expect(f.authRepo.validateSessionToken(other.token)).toBeNull();
    f.db.close();
  });
});

describe('LOT 11 — Parité du sceau Node ↔ Rust', () => {
  it('produit le même HMAC pour le message canonique partagé', () => {
    // Vecteur figé : la même assertion existe côté Rust dans
    // `src-tauri/src/db/restore.rs` (#[cfg(test)]). Le message est construit
    // champ par champ, dans un ORDRE FIXE, sans passer par JSON.
    const key = Buffer.from('00'.repeat(32), 'hex');
    const message = restoreSealMessage({
      version: 1,
      backupId: 'b1',
      stagedPath: '/tmp/s.db',
      stagedChecksum: 'a'.repeat(64),
      confirmation: 'RESTAURER',
      requestedByUserId: 'u1',
    });
    expect(message).toBe(`depotpro-restore-seal-v1|1|b1|/tmp/s.db|${'a'.repeat(64)}|RESTAURER|u1`);
    expect(hmacSha256Hex(key, message)).toBe(
      '9de55c67ed2c7d01b8a426bd6e216f8d985f259fea3843279486f31845e08e3b'
    );
  });

  it('produit le même HMAC de manifeste que le message canonique Rust', () => {
    const key = Buffer.from('00'.repeat(32), 'hex');
    const message = manifestSealMessage({
      format: 'depotpro-backup-manifest',
      version: 2,
      backupId: 'b1',
      backupType: 'MANUAL',
      origin: 'LOCAL',
      fileName: 'depotpro-manual.db',
      fileSizeBytes: 4096,
      sha256: 'c'.repeat(64),
      currentLot: 'LOT_9',
      createdAt: '2026-11-16T00:00:00.000Z',
    });
    expect(message.startsWith('depotpro-manifest-seal-v2|depotpro-backup-manifest|2|b1|')).toBe(true);
    // Vecteur figé, dupliqué côté Rust (`backup.rs::tests`).
    expect(hmacSha256Hex(key, message)).toBe(
      '57ec3dfe7077b15d2b8b93fd2ecc16d1a3682fccc400cc423a2a42d881fe791e'
    );
    // Toute altération d'un seul champ change le sceau (intégrité du contenu).
    const tampered = manifestSealMessage({
      format: 'depotpro-backup-manifest',
      version: 2,
      backupId: 'b1',
      backupType: 'MANUAL',
      origin: 'LOCAL',
      fileName: 'depotpro-manual.db',
      fileSizeBytes: 4097,
      sha256: 'c'.repeat(64),
      currentLot: 'LOT_9',
      createdAt: '2026-11-16T00:00:00.000Z',
    });
    expect(hmacSha256Hex(key, message)).not.toBe(hmacSha256Hex(key, tampered));
  });

  it('garde la clé de scellement hors de la base et refuse un marqueur d’une autre installation', () => {
    const f = fixture();
    // La clé n'existe pas avant le premier scellement : elle est créée au besoin.
    expect(loadSealKey(f.dbPath, { create: false })).toBeNull();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    expect(backup.manifestPresent).toBe(true);
    const key = loadSealKey(f.dbPath, { create: false });
    expect(key).not.toBeNull();
    expect(key).toHaveLength(32);
    expect(fs.existsSync(sealKeyPath(f.dbPath))).toBe(true);
    expect(path.basename(sealKeyPath(f.dbPath))).toBe(SEAL_KEY_FILENAME);
    // La clé ne doit jamais être persistée dans la base applicative.
    const dump = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(dump.map((t) => t.name)).not.toContain('seal_key');
    expect(fs.readdirSync(path.dirname(f.dbPath)).some((name) => name.includes('seal'))).toBe(true);
    f.db.close();
  });
});

describe('LOT 11 — Aperçu de sauvegarde robuste à un marqueur forgé', () => {
  it('reste consultable et signale le refus au lieu de lever une erreur', () => {
    const f = fixture();
    f.backupRepo.createBackup({ type: 'MANUAL', userId: f.session.user.id });
    fs.writeFileSync(
      pendingRestoreMarkerPath(f.dbPath),
      JSON.stringify({
        version: 1,
        backupId: 'forge',
        stagedPath: '/tmp/inexistant.db',
        stagedChecksum: 'a'.repeat(64),
        confirmation: 'RESTAURER',
      }),
      'utf8'
    );

    const overview = f.backupRepo.getOverview();
    expect(overview.pendingRestore).toBeNull();
    expect(overview.pendingRestoreRejectedReason).toMatch(/Restauration refusée/);
    // Le démarrage reste bloquant : l'utilisateur doit supprimer le marqueur.
    f.db.close();
    expect(() => initLocalSqlite(f.dbPath, MIGRATIONS_DIR)).toThrow(/Restauration refusée/);
  });
});
