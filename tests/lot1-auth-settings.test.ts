import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLocalSqlite } from '../server/db/sqlite.ts';
import { AppError } from '../server/error.ts';
import { AuthRepository } from '../server/repositories/authRepo.ts';
import { SettingsRepository } from '../server/repositories/settingsRepo.ts';
import { createAuthRouter } from '../server/routes/auth.ts';
import { createSettingsRouter } from '../server/routes/settings.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot1-'));
  tempDirs.push(dir);
  return path.join(dir, 'depotpro.db');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('LOT 1 — Authentification, RBAC, Verrouillage & Configuration Dépôt', () => {
  it('initialise atomiquement le dépôt et le propriétaire, et empêche une double initialisation', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const settingsRepo = new SettingsRepository(db);

    expect(authRepo.getBootstrapStatus().needsSetup).toBe(true);

    const session = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Abidjan Boissons',
      ownerFullName: 'Kouadio Yao',
      username: 'patron',
      password: 'MotDePasseSolide2026',
      defaultCashFloatXof: 50000,
    });

    expect(session.user.roleCode).toBe('OWNER');
    expect(session.user.permissions).toContain('auth.users.manage');
    expect(session.user.permissions).toContain('settings.depot.manage');
    expect(authRepo.getBootstrapStatus().needsSetup).toBe(false);

    const settings = settingsRepo.getSettings();
    expect(settings.depotName).toBe('Dépôt Abidjan Boissons');
    expect(settings.currency).toBe('XOF');
    expect(settings.defaultCashFloatXof).toBe(50000);
    expect(settings.allowNegativeStock).toBe(false);

    expect(() =>
      authRepo.initializeDepotAndOwner({
        depotName: 'Autre Dépôt',
        ownerFullName: 'Intrus',
        username: 'intrus',
        password: 'Password1234',
      })
    ).toThrow(/déjà initialisés/);

    db.close();
  });

  it('verrouille le compte après 5 échecs de connexion et permet le déverrouillage par le propriétaire', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);

    const ownerSession = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Marcory',
      ownerFullName: 'Patron Marcory',
      username: 'patron',
      password: 'OwnerPassword123',
    });

    const cashier = authRepo.createUserWithEmployee(ownerSession.user.id, {
      fullName: 'Awa Koné',
      username: 'awa.caisse',
      password: 'CashierPassword123',
      roleId: 'role-cashier',
    });

    for (let i = 0; i < 5; i += 1) {
      expect(() => authRepo.login('awa.caisse', 'MauvaisMotDePasse')).toThrow();
    }

    // Même avec le bon mot de passe, le compte verrouillé doit être refusé
    expect(() => authRepo.login('awa.caisse', 'CashierPassword123')).toThrow(/verrouillé/);

    // Déverrouillage par le propriétaire
    const unlocked = authRepo.unlockUser(ownerSession.user.id, cashier.id);
    expect(unlocked.failedAttempts).toBe(0);
    expect(unlocked.lockedUntil).toBeNull();

    const cashierSession = authRepo.login('awa.caisse', 'CashierPassword123');
    expect(cashierSession.user.username).toBe('awa.caisse');

    const logs = authRepo.listLoginLogs(20);
    expect(logs.some((l) => l.reason === 'INVALID_PASSWORD_LOCKED')).toBe(true);
    expect(logs.some((l) => l.reason === 'LOGIN_SUCCESS' && l.usernameAttempted === 'awa.caisse')).toBe(true);

    db.close();
  });

  it('vérifie les permissions côté serveur (HTTP 403 si Caissier tente admin) et permet le changement de mot de passe', async () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const settingsRepo = new SettingsRepository(db);

    const ownerSession = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Cocody',
      ownerFullName: 'Proprio Cocody',
      username: 'owner',
      password: 'OwnerPassword123',
    });

    authRepo.createUserWithEmployee(ownerSession.user.id, {
      fullName: 'Caissier Test',
      username: 'caissier1',
      password: 'CashierPassword123',
      roleId: 'role-cashier',
    });

    const cashierSession = authRepo.login('caissier1', 'CashierPassword123');

    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(authRepo));
    app.use('/api/settings', createSettingsRouter(settingsRepo, authRepo));
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        if (err instanceof AppError) {
          res.status(err.statusCode).json(err.toPayload());
          return;
        }
        res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erreur' });
      }
    );

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const address = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // Caissier tente d'accéder à la liste des utilisateurs -> 403 PERMISSION_DENIED
      const usersRes = await fetch(`${baseUrl}/api/auth/users`, {
        headers: { Authorization: `Bearer ${cashierSession.token}` },
      });
      expect(usersRes.status).toBe(403);

      // Caissier tente de modifier la configuration du dépôt -> 403 PERMISSION_DENIED
      const settingsRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierSession.token}`,
        },
        body: JSON.stringify({
          depotName: 'Piraté',
          ownerName: 'Pirate',
          defaultConsignmentPolicy: 'SEPARATE_TRACKING',
          allowNegativeStock: true,
          defaultCashFloatXof: 0,
          receiptPrintWidth: '80mm',
        }),
      });
      expect(settingsRes.status).toBe(403);

      // Propriétaire modifie la configuration du dépôt -> 200 OK
      const ownerSettingsRes = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerSession.token}`,
        },
        body: JSON.stringify({
          depotName: 'Dépôt Cocody Plus',
          ownerName: 'Proprio Cocody',
          phone: '+225 07 01 02 03 04',
          address: 'Angré 8e Tranche',
          defaultConsignmentPolicy: 'SEPARATE_TRACKING',
          allowNegativeStock: false,
          defaultCashFloatXof: 25000,
          receiptPrintWidth: '58mm',
        }),
      });
      expect(ownerSettingsRes.status).toBe(200);
      const updated = (await ownerSettingsRes.json()) as { depotName: string; receiptPrintWidth: string };
      expect(updated.depotName).toBe('Dépôt Cocody Plus');
      expect(updated.receiptPrintWidth).toBe('58mm');

      // Changement de mot de passe du caissier + déconnexion
      authRepo.changePassword(cashierSession.user.id, 'CashierPassword123', 'NouveauPass2026!');
      expect(() => authRepo.login('caissier1', 'CashierPassword123')).toThrow();
      const reLogin = authRepo.login('caissier1', 'NouveauPass2026!');
      expect(reLogin.user.username).toBe('caissier1');

      authRepo.logout(reLogin.token);
      expect(authRepo.validateSessionToken(reLogin.token)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
