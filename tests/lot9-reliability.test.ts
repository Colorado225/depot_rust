import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DatabaseLike } from '../server/db/driver.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { initLocalSqlite } from '../server/db/sqlite.ts';
import { pendingRestoreMarkerPath, sha256FileSync } from '../server/db/pendingRestore.ts';
import { AppError } from '../server/error.ts';
import { AuthRepository } from '../server/repositories/authRepo.ts';
import { BackupRepository } from '../server/repositories/backupRepo.ts';
import { ReliabilityRepository } from '../server/repositories/reliabilityRepo.ts';
import { createBackupsRouter } from '../server/routes/backups.ts';

const tempDirs: string[] = [];
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
// LOT 10 : les compteurs sont dérivés du répertoire de migrations afin que
// l'ajout d'une migration de distribution ne casse pas la non-régression LOT 9.
const ALL_MIGRATION_FILES = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const MIGRATIONS_TOTAL = ALL_MIGRATION_FILES.length;
const MIGRATIONS_AFTER_0010 = ALL_MIGRATION_FILES.filter(
  (name) => Number.parseInt(name.slice(0, 4), 10) > 10
).length;

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot9-'));
  tempDirs.push(dir);
  return dir;
}

function createTempDbPath(): string {
  return path.join(createTempDir(), 'depotpro.db');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface Fixture {
  dbPath: string;
  db: DatabaseLike;
  authRepo: AuthRepository;
  backupRepo: BackupRepository;
  reliabilityRepo: ReliabilityRepository;
  ownerId: string;
}

function createFixture(
  dbPath = createTempDbPath(),
  depotName = 'Dépôt Fiabilisation'
): Fixture {
  const { db } = initLocalSqlite(dbPath, MIGRATIONS_DIR);
  const authRepo = new AuthRepository(db);
  const backupRepo = new BackupRepository(db, dbPath, { migrationsDir: MIGRATIONS_DIR });
  const reliabilityRepo = new ReliabilityRepository(db, { migrationsDir: MIGRATIONS_DIR });
  const owner = authRepo.initializeDepotAndOwner({
    depotName,
    ownerFullName: 'Kouassi Aimé',
    username: 'patron',
    password: 'Password2026!',
  });
  insertProduct(db, 'PROD-AVANT', 'Produit avant sauvegarde');
  return { dbPath, db, authRepo, backupRepo, reliabilityRepo, ownerId: owner.user.id };
}

function insertProduct(db: DatabaseLike, sku: string, name: string): void {
  db.prepare(
    `INSERT INTO products (id, sku, name, base_unit_id, purchase_price_xof, wholesale_price_xof, retail_price_xof)
     VALUES (?, ?, ?, 'unit-bottle', 400, 450, 500)`
  ).run(`product-${sku}`, sku, name);
  db.prepare(
    `INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base)
     VALUES (?, 25, 0)`
  ).run(`product-${sku}`);
}

function productSkus(db: DatabaseLike): string[] {
  return (
    db.prepare('SELECT sku FROM products ORDER BY sku ASC').all() as Array<{ sku: string }>
  ).map((r) => r.sku);
}

function mountApp(fixture: Fixture) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/backups',
    createBackupsRouter(fixture.backupRepo, fixture.reliabilityRepo, fixture.authRepo)
  );
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err instanceof AppError) {
        res.status(err.statusCode).json(err.toPayload());
        return;
      }
      res.status(500).json({ code: 'INTERNAL_ERROR', message: String(err) });
    }
  );
  return app;
}

async function withServer<T>(
  fixture: Fixture,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = http.createServer(mountApp(fixture));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    // fetch() conserve des sockets keep-alive : sans fermeture explicite,
    // server.close() attend indéfiniment et rend la suite intermittente.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('LOT 9 — Fiabilisation : sauvegardes, restauration, sécurité, performance & non-régression', () => {
  it('Scénario M : sauvegarde manuelle cohérente avec WAL, empreinte SHA-256, historique journalisé et configuration automatique', () => {
    const f = createFixture();
    const initialSkus = productSkus(f.db);

    const manual = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.ownerId });
    expect(manual.integrityStatus).toBe('VERIFIED');
    expect(manual.fileExists).toBe(true);
    expect(manual.checksumMatches).toBe(true);
    expect(manual.sha256Checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(manual.fileSizeBytes).toBeGreaterThan(0);
    expect(manual.filePath.startsWith(path.join(path.dirname(f.dbPath), 'backups'))).toBe(true);
    expect(sha256FileSync(manual.filePath)).toBe(manual.sha256Checksum);

    // La copie est une vraie base SQLite autonome, lisible sans le WAL d'origine.
    const copy = openDatabase(manual.filePath, { readOnly: true }).db;
    expect(productSkus(copy)).toEqual(initialSkus);
    expect(
      (copy.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
    ).toBe('ok');
    expect(copy.prepare('PRAGMA foreign_key_check;').all()).toHaveLength(0);
    copy.close();

    // Vérification enregistrée dans backup_history + audit_logs.
    const verification = f.backupRepo.verifyBackup(manual.id, f.ownerId);
    expect(verification.status).toBe('OK');
    expect(verification.checksumMatches).toBe(true);
    expect(verification.requiredTablesPresent).toBe(true);
    expect(verification.foreignKeyViolations).toBe(0);

    const audits = f.db
      .prepare("SELECT action FROM audit_logs WHERE action LIKE 'BACKUP_%' ORDER BY created_at")
      .all() as Array<{ action: string }>;
    expect(audits.map((a) => a.action)).toContain('BACKUP_MANUAL_CREATED');
    expect(audits.map((a) => a.action)).toContain('BACKUP_VERIFIED');

    // Export USB (fichier .db téléchargeable) et sauvegarde automatique.
    const usb = f.backupRepo.createBackup({ type: 'USB_EXPORT', userId: f.ownerId });
    expect(usb.backupType).toBe('USB_EXPORT');
    expect(f.backupRepo.readBackupFile(usb.id).fileName).toBe(usb.fileName);

    const config = f.backupRepo.updateConfig({
      autoEnabled: true,
      autoIntervalHours: 24,
      retentionCount: 7,
    });
    expect(config.autoEnabled).toBe(true);
    expect(config.retentionCount).toBe(7);
    const auto = f.backupRepo.runAutoBackupIfDue();
    expect(auto?.backupType).toBe('AUTO');
    expect(f.backupRepo.runAutoBackupIfDue()).toBeNull();

    const overview = f.backupRepo.getOverview();
    expect(overview.totalBackups).toBe(3);
    expect(overview.lastBackupAt).not.toBeNull();
    expect(overview.lastAutoBackupAt).not.toBeNull();
    expect(overview.pendingRestore).toBeNull();
    expect(overview.backups.map((b) => b.backupType)).toContain('AUTO');

    f.db.close();
  });

  it('Scénario N : restauration réelle sur base séparée, refus d’une copie altérée et activation sûre au redémarrage', () => {
    const f = createFixture();
    const backup = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.ownerId });
    insertProduct(f.db, 'PROD-APRES', 'Produit créé après la sauvegarde');
    expect(productSkus(f.db)).toEqual(['PROD-APRES', 'PROD-AVANT']);

    // Confirmation obligatoire.
    expect(() =>
      f.backupRepo.restoreBackup({
        backupId: backup.id,
        confirmation: 'OUI',
        activateOnRestart: false,
        userId: f.ownerId,
      })
    ).toThrow(/Confirmation requise/);

    // Restauration vérifiée sur une base SÉPARÉE : la base active reste intacte.
    const plan = f.backupRepo.restoreBackup({
      backupId: backup.id,
      confirmation: 'RESTAURER',
      activateOnRestart: false,
      userId: f.ownerId,
    });
    expect(plan.mode).toBe('VERIFIED_ONLY');
    expect(plan.requiresRestart).toBe(false);
    expect(plan.verification.status).toBe('OK');
    expect(plan.migrationsAppliedOnStaged).toBe(0);
    expect(plan.rowsBefore.products).toBe(2);
    expect(plan.rowsAfter.products).toBe(1);
    expect(plan.stagedPath).not.toBeNull();
    expect(plan.stagedChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(pendingRestoreMarkerPath(f.dbPath))).toBe(false);
    expect(productSkus(f.db)).toEqual(['PROD-APRES', 'PROD-AVANT']);

    const staged = openDatabase(plan.stagedPath!, { readOnly: true }).db;
    expect(productSkus(staged)).toEqual(['PROD-AVANT']);
    expect(
      (
        f.db.prepare('SELECT COUNT(*) AS c FROM business_settings').get() as { c: number }
      ).c
    ).toBe(1);
    staged.close();

    // Sauvegarde préalable obligatoire tracée dans l'historique.
    const preRestore = f.backupRepo.getBackup(plan.preRestoreBackupId);
    expect(preRestore.backupType).toBe('PRE_RESTORE');

    // Une copie falsifiée est refusée (SHA-256 + integrity_check).
    const tampered = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.ownerId });
    const fd = fs.openSync(tampered.filePath, 'r+');
    fs.writeSync(fd, Buffer.from('CORROMPU'), 0, 8, 0);
    fs.closeSync(fd);
    const badVerification = f.backupRepo.verifyBackup(tampered.id, f.ownerId);
    expect(badVerification.status).toBe('FAILED');
    expect(f.backupRepo.getBackup(tampered.id).integrityStatus).toBe('FAILED');
    expect(() => f.backupRepo.readBackupFile(tampered.id)).toThrow(/refusé/i);
    expect(() =>
      f.backupRepo.restoreBackup({
        backupId: tampered.id,
        confirmation: 'RESTAURER',
        activateOnRestart: true,
        userId: f.ownerId,
      })
    ).toThrow(/Restauration refusée/);

    // Préparation avec activation différée : aucune base écrasée à chaud.
    const pendingPlan = f.backupRepo.restoreBackup({
      backupId: backup.id,
      confirmation: 'RESTAURER',
      activateOnRestart: true,
      userId: f.ownerId,
    });
    expect(pendingPlan.mode).toBe('PENDING_RESTART');
    expect(pendingPlan.requiresRestart).toBe(true);
    expect(fs.existsSync(pendingRestoreMarkerPath(f.dbPath))).toBe(true);
    expect(productSkus(f.db)).toEqual(['PROD-APRES', 'PROD-AVANT']);
    expect(f.backupRepo.getOverview().pendingRestore?.backupId).toBe(backup.id);

    // Une seconde restauration programmée est refusée tant que la première est en attente.
    expect(() =>
      f.backupRepo.restoreBackup({
        backupId: backup.id,
        confirmation: 'RESTAURER',
        activateOnRestart: true,
        userId: f.ownerId,
      })
    ).toThrow(/déjà programmée/);

    // Annulation possible avant redémarrage.
    expect(f.backupRepo.cancelRestore(f.ownerId)).toBe(true);
    expect(fs.existsSync(pendingRestoreMarkerPath(f.dbPath))).toBe(false);

    // Nouvelle préparation, puis redémarrage hors ligne = activation effective.
    const finalPlan = f.backupRepo.restoreBackup({
      backupId: backup.id,
      confirmation: 'RESTAURER',
      activateOnRestart: true,
      userId: f.ownerId,
    });
    f.db.close();

    const reopened = initLocalSqlite(f.dbPath, MIGRATIONS_DIR);
    expect(reopened.restoreApplied).not.toBeNull();
    expect(reopened.restoreApplied?.backupId).toBe(backup.id);
    expect(reopened.migrationsAppliedNow).toBe(0);
    expect(fs.existsSync(pendingRestoreMarkerPath(f.dbPath))).toBe(false);
    expect(productSkus(reopened.db)).toEqual(['PROD-AVANT']);
    expect(
      (reopened.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
    ).toBeGreaterThan(0);
    expect(
      (
        reopened.db
          .prepare("SELECT value FROM system_meta WHERE key = 'app.lot_current'")
          .get() as { value: string }
      ).value
    ).toBe('LOT_9');
    expect(
      (reopened.db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string })
        .integrity_check
    ).toBe('ok');

    const auditAfter = new BackupRepository(reopened.db, f.dbPath, {
      migrationsDir: MIGRATIONS_DIR,
    });
    auditAfter.recordRestoreApplied(reopened.restoreApplied!);
    expect(auditAfter.getOverview().lastRestoreAt).not.toBeNull();
    expect(finalPlan.stagedPath).not.toBeNull();
    reopened.db.close();
  });

  it('Scénario O : redémarrages hors ligne et mise à jour du schéma sans perte de données', () => {
    // Base « ancienne version » : migrations 0001 → 0010 uniquement.
    const limitedDir = createTempDir();
    const externalBackupPath = path.join(createTempDir(), 'sauvegarde-0010.db');
    const oldMigrations = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && Number.parseInt(f.slice(0, 4), 10) <= 10)
      .sort();
    for (const file of oldMigrations) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(limitedDir, file));
    }

    const dbPath = createTempDbPath();
    const first = initLocalSqlite(dbPath, limitedDir);
    expect(first.migrationsAppliedNow).toBe(10);
    const authRepo = new AuthRepository(first.db);
    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Mise à jour',
      ownerFullName: 'Adjovi Kossi',
      username: 'patron',
      password: 'Password2026!',
    });
    insertProduct(first.db, 'PROD-ANCIEN', 'Produit créé en version précédente');
    first.db
      .prepare(
        "INSERT INTO system_meta (key, value, category) VALUES ('test.migration.marker', 'CONSERVE', 'TEST')"
      )
      .run();
    // Copie cohérente prise sur l'ancienne version (le dépôt LOT 9 n'existait pas encore).
    first.db.prepare('VACUUM INTO ?').run(externalBackupPath);
    const externalBuffer = fs.readFileSync(externalBackupPath);
    first.db.close();

    // Mise à jour en place : migrations postérieures à 0010 appliquées une seule fois.
    const updated = initLocalSqlite(dbPath, MIGRATIONS_DIR);
    expect(updated.migrationsAppliedNow).toBe(MIGRATIONS_AFTER_0010);
    expect(productSkus(updated.db)).toEqual(['PROD-ANCIEN']);
    expect(
      (
        updated.db
          .prepare("SELECT value FROM system_meta WHERE key = 'test.migration.marker'")
          .get() as { value: string }
      ).value
    ).toBe('CONSERVE');
    expect(
      (
        updated.db
          .prepare("SELECT value FROM system_meta WHERE key = 'backup.auto_enabled'")
          .get() as { value: string }
      ).value
    ).toBe('1');

    // Sauvegarde de l'ancienne version importée puis restaurée sur une base
    // SÉPARÉE : les migrations manquantes s'y appliquent sans écraser les données.
    const repo = new BackupRepository(updated.db, dbPath, { migrationsDir: MIGRATIONS_DIR });
    const imported = repo.importExternalBackup({
      fileBuffer: externalBuffer,
      originalName: 'sauvegarde-0010.db',
      userId: owner.user.id,
    });
    expect(imported.origin).toBe('IMPORTED');
    const plan = repo.restoreBackup({
      backupId: imported.id,
      confirmation: 'RESTAURER',
      activateOnRestart: false,
      userId: owner.user.id,
    });
    expect(plan.migrationsAppliedOnStaged).toBe(MIGRATIONS_AFTER_0010);
    expect(plan.rowsAfter.products).toBe(1);

    const staged = openDatabase(plan.stagedPath!, { readOnly: true }).db;
    expect(
      (
        staged
          .prepare("SELECT value FROM system_meta WHERE key = 'test.migration.marker'")
          .get() as { value: string }
      ).value
    ).toBe('CONSERVE');
    expect(
      (
        staged
          .prepare("SELECT value FROM system_meta WHERE key = 'app.lot_current'")
          .get() as { value: string }
      ).value
    ).toBe('LOT_9');
    expect(
      (
        staged
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_backup_history_created'")
          .get() as { name: string } | undefined
      )?.name
    ).toBe('idx_backup_history_created');
    expect(
      (staged.prepare('PRAGMA table_info(backup_history);').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    ).toContain('origin');
    staged.close();

    const diagnostics = new ReliabilityRepository(updated.db, {
      migrationsDir: MIGRATIONS_DIR,
    }).runDiagnostics();
    expect(diagnostics.overall).toBe('OK');
    expect(diagnostics.migrationChecksumMismatches).toBe(0);
    expect(diagnostics.nonIntegerMoneyColumns).toBe(0);
    expect(diagnostics.negativeStockRows).toBe(0);
    expect(diagnostics.currency).toBe('XOF');
    expect(diagnostics.checks.length).toBeGreaterThanOrEqual(9);
    updated.db.close();

    // Redémarrages répétés hors connexion : aucune migration réappliquée, données intactes.
    for (let i = 0; i < 3; i += 1) {
      const restart = initLocalSqlite(dbPath, MIGRATIONS_DIR);
      expect(restart.migrationsAppliedNow).toBe(0);
      expect(restart.restoreApplied).toBeNull();
      expect(productSkus(restart.db)).toEqual(['PROD-ANCIEN']);
      expect(
        (restart.db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string }).journal_mode.toLowerCase()
      ).toBe('wal');
      restart.db.close();
    }
  });

  it('Contrôles de non-régression et sécurité LOT 9 : autotests complets, RBAC HTTP et téléchargement vérifié', async () => {
    const f = createFixture();
    const selfTest = f.reliabilityRepo.runLot9SelfTests();
    expect(selfTest.allPassed).toBe(true);
    expect(selfTest.checks.length).toBeGreaterThanOrEqual(11);
    expect(selfTest.checks.map((c) => c.id)).toContain('backup-rbac');
    expect(selfTest.checks.map((c) => c.id)).toContain('offline-ready');

    const ownerToken = f.authRepo.login('patron', 'Password2026!').token;
    f.authRepo.createUserWithEmployee(f.ownerId, {
      fullName: 'Gérant LOT 9',
      username: 'gerant',
      password: 'Password2026!',
      roleId: 'role-manager',
    });
    const managerToken = f.authRepo.login('gerant', 'Password2026!').token;

    await withServer(f, async (baseUrl) => {
      const get = (url: string, token?: string) =>
        fetch(`${baseUrl}${url}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      const post = (url: string, token?: string, body: unknown = {}) =>
        fetch(`${baseUrl}${url}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });

      // 401 sans session, 403 pour un Gérant (backup.manage réservé au Propriétaire).
      expect((await get('/api/backups/overview')).status).toBe(401);
      expect((await get('/api/backups/overview', managerToken)).status).toBe(403);
      expect((await post('/api/backups/', managerToken)).status).toBe(403);

      const overviewRes = await get('/api/backups/overview', ownerToken);
      expect(overviewRes.status).toBe(200);

      const created = await post('/api/backups/', ownerToken, { type: 'MANUAL' });
      expect(created.status).toBe(201);
      const entry = (await created.json()) as { id: string; fileName: string };

      const verified = await post(`/api/backups/${entry.id}/verify`, ownerToken);
      expect(verified.status).toBe(200);
      expect(((await verified.json()) as { status: string }).status).toBe('OK');

      const download = await get(`/api/backups/${entry.id}/download`, ownerToken);
      expect(download.status).toBe(200);
      expect(download.headers.get('x-depotpro-sha256')).toMatch(/^[a-f0-9]{64}$/);
      expect(download.headers.get('content-disposition')).toContain('attachment');

      const diagnostics = await get('/api/backups/diagnostics', ownerToken);
      expect(diagnostics.status).toBe(200);
      expect(((await diagnostics.json()) as { overall: string }).overall).toBe('OK');

      const selfTestRes = await post('/api/backups/self-test', ownerToken);
      expect(selfTestRes.status).toBe(200);
      expect(((await selfTestRes.json()) as { allPassed: boolean }).allPassed).toBe(true);

      // Confirmation métier validée côté backend, pas seulement dans l'UI.
      const badRestore = await post(`/api/backups/${entry.id}/restore`, ownerToken, {
        confirmation: 'OUI',
      });
      expect(badRestore.status).toBe(400);

      const restore = await post(`/api/backups/${entry.id}/restore`, ownerToken, {
        confirmation: 'RESTAURER',
        activateOnRestart: false,
      });
      expect(restore.status).toBe(200);
      expect(((await restore.json()) as { mode: string }).mode).toBe('VERIFIED_ONLY');

      const configRes = await fetch(`${baseUrl}/api/backups/config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ autoEnabled: false, autoIntervalHours: 12, retentionCount: 5 }),
      });
      expect(configRes.status).toBe(200);
      expect(((await configRes.json()) as { autoEnabled: boolean }).autoEnabled).toBe(false);
    });

    f.db.close();
  });


  it('Sauvegarde portable : import depuis une clé USB, manifeste vérifié et restauration sur un autre dépôt', async () => {
    const source = createFixture(undefined, 'Dépôt Source USB');
    const backup = source.backupRepo.createBackup({ type: 'MANUAL', userId: source.ownerId });
    const buffer = fs.readFileSync(backup.filePath);
    const sourceOwnerId = source.ownerId;
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    source.db.close();

    const target = createFixture(undefined, 'Dépôt Cible USB');
    insertProduct(target.db, 'PROD-CIBLE', 'Produit propre au dépôt cible');
    const ownerToken = target.authRepo.login('patron', 'Password2026!').token;

    const imported = await withServer(target, async (baseUrl) => {
      const auth = { Authorization: `Bearer ${ownerToken}` };
      const post = (url: string, body: unknown) =>
        fetch(`${baseUrl}${url}`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      // Tentative de traversée de chemin : le nom fourni ne doit jamais devenir un chemin.
      const importRes = await fetch(`${baseUrl}/api/backups/import`, {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/octet-stream',
          'X-DepotPro-Filename': '../../etc/sauvegarde.db',
          'X-DepotPro-Source-Checksum': sha,
        },
        body: buffer,
      });
      expect(importRes.status).toBe(201);
      const entry = (await importRes.json()) as {
        id: string;
        origin: string;
        fileName: string;
        filePath: string;
        sha256Checksum: string;
        manifestPresent: boolean;
      };
      expect(entry.origin).toBe('IMPORTED');
      expect(entry.fileName).toMatch(/^depotpro-import-/);
      expect(entry.fileName).not.toContain('etc');
      expect(entry.manifestPresent).toBe(true);
      expect(path.dirname(entry.filePath)).toBe(path.join(path.dirname(target.dbPath), 'backups'));

      const manifestRes = await fetch(`${baseUrl}/api/backups/${entry.id}/manifest`, {
        headers: auth,
      });
      expect(manifestRes.status).toBe(200);
      const manifest = (await manifestRes.json()) as {
        format: string;
        origin: string;
        currency: string;
        sha256: string;
        currentLot: string;
      };
      expect(manifest.format).toBe('depotpro-backup-manifest');
      expect(manifest.origin).toBe('IMPORTED');
      expect(manifest.currency).toBe('XOF');
      expect(manifest.sha256).toBe(entry.sha256Checksum);
      expect(manifest.currentLot).toBe('LOT_9');

      const verifyRes = await post(`/api/backups/${entry.id}/verify`, {});
      expect(verifyRes.status).toBe(200);
      const verification = (await verifyRes.json()) as { status: string; manifestStatus: string };
      expect(verification.status).toBe('OK');
      expect(verification.manifestStatus).toBe('OK');

      // Restauration préparée : la base cible reste intacte jusqu'au redémarrage.
      const restoreRes = await post(`/api/backups/${entry.id}/restore`, {
        confirmation: 'RESTAURER',
        activateOnRestart: true,
      });
      expect(restoreRes.status).toBe(200);
      expect(((await restoreRes.json()) as { mode: string }).mode).toBe('PENDING_RESTART');
      expect(productSkus(target.db)).toEqual(['PROD-AVANT', 'PROD-CIBLE']);

      // RBAC : l'import est également protégé.
      const denied = await fetch(`${baseUrl}/api/backups/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });
      expect(denied.status).toBe(401);

      return entry;
    });

    target.db.close();
    const restarted = initLocalSqlite(target.dbPath, MIGRATIONS_DIR);
    expect(restarted.restoreApplied?.backupId).toBe(imported.id);
    expect(productSkus(restarted.db)).toEqual(['PROD-AVANT']);
    expect(
      (
        restarted.db
          .prepare('SELECT depot_name AS n FROM business_settings')
          .get() as { n: string }
      ).n
    ).toBe('Dépôt Source USB');
    // La base restaurée est bien celle de la source : son identifiant propriétaire
    // remplace celui du dépôt cible (une sauvegarde ne se contient pas elle-même,
    // donc l'historique ne contient pas l'import réalisé sur la cible).
    expect(
      (restarted.db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id
    ).toBe(sourceOwnerId);
    expect(
      (
        restarted.db.prepare('PRAGMA table_info(backup_history);').all() as Array<{ name: string }>
      ).map((c) => c.name)
    ).toContain('origin');
    expect(
      (restarted.db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string })
        .integrity_check
    ).toBe('ok');
    restarted.db.close();
  });

  it('Refus de sécurité LOT 9 : fichier non SQLite, transfert altéré, manifeste falsifié et marqueur invalide', () => {
    const f = createFixture();
    const good = f.backupRepo.createBackup({ type: 'MANUAL', userId: f.ownerId });
    const buffer = fs.readFileSync(good.filePath);

    expect(() =>
      f.backupRepo.importExternalBackup({
        fileBuffer: Buffer.from('ceci nest pas une base sqlite '.repeat(40)),
        originalName: 'faux.db',
        userId: f.ownerId,
      })
    ).toThrow(/n’est pas une base SQLite/);

    expect(() =>
      f.backupRepo.importExternalBackup({
        fileBuffer: buffer,
        originalName: 'copie.db',
        expectedSha256: 'a'.repeat(64),
        userId: f.ownerId,
      })
    ).toThrow(/Empreinte SHA-256 de transfert/);

    // Corruption déterministe de l'en-tête SQLite (octets write/read version) :
    // la magie sur 16 octets passe, mais le fichier n'est plus ouvrable.
    const corrupted = Buffer.from(buffer);
    corrupted[18] = 0xff;
    corrupted[19] = 0xff;
    expect(() =>
      f.backupRepo.importExternalBackup({
        fileBuffer: corrupted,
        originalName: 'corrompu.db',
        userId: f.ownerId,
      })
          ).toThrow(/Contrôle d'intégrité|Import refusé|SQLite lisible/);

    const imported = f.backupRepo.importExternalBackup({
      fileBuffer: buffer,
      originalName: '../../../../etc/passwd.db',
      expectedSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      userId: f.ownerId,
    });
    expect(imported.origin).toBe('IMPORTED');
    expect(imported.fileName).not.toContain('passwd');
    expect(imported.fileName).not.toContain('..');
    expect(imported.manifestPresent).toBe(true);
    expect(f.backupRepo.getManifest(imported.id).sha256).toBe(imported.sha256Checksum);

    // Falsification du manifeste : la vérification et le téléchargement sont bloqués.
    const mPath = `${imported.filePath}.manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8')) as Record<string, unknown>;
    manifest.sha256 = '0'.repeat(64);
    fs.writeFileSync(mPath, JSON.stringify(manifest), 'utf8');
    const verification = f.backupRepo.verifyBackup(imported.id, f.ownerId);
    expect(verification.status).toBe('FAILED');
    expect(verification.manifestStatus).toBe('MISMATCH');
    expect(() => f.backupRepo.getManifest(imported.id)).toThrow(/non vérifié/);
    expect(() => f.backupRepo.readBackupFile(imported.id)).toThrow(/refusé/i);
    expect(f.backupRepo.getBackup(imported.id).integrityStatus).toBe('FAILED');

    // Un marqueur invalide fait échouer le démarrage SANS toucher à la base.
    const marker = pendingRestoreMarkerPath(f.dbPath);
    fs.writeFileSync(marker, '{"version":1,"confirmation":"MAUVAIS"}', 'utf8');
    expect(() => initLocalSqlite(f.dbPath, MIGRATIONS_DIR)).toThrow(/Marqueur de restauration/);
    fs.rmSync(marker, { force: true });

    const reopened = initLocalSqlite(f.dbPath, MIGRATIONS_DIR);
    expect(reopened.restoreApplied).toBeNull();
    expect(reopened.migrationsAppliedNow).toBe(0);
    expect(productSkus(reopened.db)).toEqual(['PROD-AVANT']);
    reopened.db.close();
    f.db.close();
  });

  it('Restauration d’une sauvegarde de version antérieure : migrations appliquées sur la copie avant activation', () => {
    const limitedDir = createTempDir();
    const externalBackupPath = path.join(createTempDir(), 'ancienne.db');
    for (const file of fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith('.sql') && Number.parseInt(n.slice(0, 4), 10) <= 10)
      .sort()) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(limitedDir, file));
    }

    const dbPath = createTempDbPath();
    const first = initLocalSqlite(dbPath, limitedDir);
    expect(first.migrationsAppliedNow).toBe(10);
    const owner = new AuthRepository(first.db).initializeDepotAndOwner({
      depotName: 'Dépôt Version 0010',
      ownerFullName: 'Traoré Mariam',
      username: 'patron',
      password: 'Password2026!',
    });
    insertProduct(first.db, 'PROD-ANCIEN', 'Produit version 0010');
    expect(
      (
        first.db
          .prepare("SELECT value FROM system_meta WHERE key = 'app.lot_current'")
          .get() as { value: string }
      ).value
    ).toBe('LOT_8');
    first.db.prepare('VACUUM INTO ?').run(externalBackupPath);
    const buffer = fs.readFileSync(externalBackupPath);
    insertProduct(first.db, 'PROD-EPHEMERE', 'Écrit après la sauvegarde');
    first.db.close();

    // Mise à jour de l'application : migrations postérieures à 0010, données conservées.
    const updated = initLocalSqlite(dbPath, MIGRATIONS_DIR);
    expect(updated.migrationsAppliedNow).toBe(MIGRATIONS_AFTER_0010);
    const repo = new BackupRepository(updated.db, dbPath, { migrationsDir: MIGRATIONS_DIR });
    const imported = repo.importExternalBackup({
      fileBuffer: buffer,
      originalName: 'ancienne.db',
      userId: owner.user.id,
    });
    const plan = repo.restoreBackup({
      backupId: imported.id,
      confirmation: 'RESTAURER',
      activateOnRestart: true,
      userId: owner.user.id,
    });
    expect(plan.mode).toBe('PENDING_RESTART');
    expect(plan.migrationsAppliedOnStaged).toBe(MIGRATIONS_AFTER_0010);
    expect(plan.rowsAfter.products).toBe(1);
    expect(productSkus(updated.db)).toEqual(['PROD-ANCIEN', 'PROD-EPHEMERE']);
    updated.db.close();

    const restarted = initLocalSqlite(dbPath, MIGRATIONS_DIR);
    expect(restarted.restoreApplied?.backupId).toBe(imported.id);
    expect(restarted.migrationsAppliedNow).toBe(0); // la copie était déjà à jour
    expect(productSkus(restarted.db)).toEqual(['PROD-ANCIEN']);
    expect(
      (
        restarted.db
          .prepare('SELECT COUNT(*) AS c FROM schema_migrations')
          .get() as { c: number }
      ).c
    ).toBe(MIGRATIONS_TOTAL);
    expect(
      (
        restarted.db
          .prepare("SELECT value FROM system_meta WHERE key = 'app.lot_current'")
          .get() as { value: string }
      ).value
    ).toBe('LOT_9');
    expect(
      (
        restarted.db.prepare('PRAGMA table_info(backup_history);').all() as Array<{ name: string }>
      ).map((c) => c.name)
    ).toContain('origin');
    expect(
      (restarted.db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string })
        .integrity_check
    ).toBe('ok');
    restarted.db.close();
  });
});
