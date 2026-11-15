import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLocalSqlite } from '../server/db/sqlite.ts';
import { addXof, mulXofQty, subXof } from '../server/domain/money.ts';
import { SystemRepository } from '../server/repositories/systemRepo.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot0-'));
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

describe('LOT 0 — Fondations SQLite, Migrations & Domaine XOF', () => {
  it('initialise SQLite en mode WAL avec clés étrangères et migrations idempotentes', () => {
    const dbPath = createTempDbPath();
    const first = initLocalSqlite(dbPath);
    expect(first.migrationsAppliedNow).toBeGreaterThanOrEqual(2);

    const repo = new SystemRepository(first.db, dbPath);
    const health = repo.getHealth();

    expect(health.journalMode).toBe('WAL');
    expect(health.foreignKeysEnabled).toBe(true);
    expect(health.appliedMigrationsCount).toBeGreaterThanOrEqual(2);
    expect(health.tablesCount).toBeGreaterThanOrEqual(31);
    expect(health.currentLot).toMatch(/^LOT_/);
    first.db.close();

    // Réouverture : aucune migration réappliquée, données intactes
    const second = initLocalSqlite(dbPath);
    expect(second.migrationsAppliedNow).toBe(0);
    second.db.close();
  });

  it('applique les contraintes référentielles et bloque les données incohérentes', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const repo = new SystemRepository(db, dbPath);

    const report = repo.runFoundationSelfTests();
    expect(report.allPassed).toBe(true);

    // Vérifie qu'un stock négatif est rejeté par la contrainte SQL CHECK
    expect(() => {
      db.prepare("INSERT INTO units (id, code, name, is_base_unit) VALUES ('u-test', 'TEST', 'Test', 1)").run();
      db.prepare(
        "INSERT INTO products (id, sku, name, base_unit_id, purchase_price_xof, wholesale_price_xof, retail_price_xof) VALUES ('p-test', 'SKU-1', 'Produit Test', 'u-test', 500, 600, 700)"
      ).run();
      db.prepare(
        "INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base) VALUES ('p-test', -5, 0)"
      ).run();
    }).toThrow();

    db.close();
  });

  it('garantit des calculs financiers XOF strictement entiers sans flottants', () => {
    const totalCasiers = mulXofQty(9600, 10);
    const totalBouteilles = mulXofQty(400, 3);
    const net = subXof(addXof(totalCasiers, totalBouteilles), 500);
    expect(net).toBe(96700);

    expect(() => mulXofQty(450.25, 2)).toThrow();
    expect(() => mulXofQty(-100, 1)).toThrow();
  });

  it('persiste les 3 décisions architecture LOT 0 et la licence locale sans bloquer le hors-ligne', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const repo = new SystemRepository(db, dbPath);

    const decisions = repo.getDecisions();
    const keys = decisions.map((d) => d.key);
    expect(keys).toContain('adr.accounting_mode');
    expect(keys).toContain('adr.licensing_strategy');
    expect(keys).toContain('adr.cloud_sync_readiness');

    const initialLicense = repo.getLicenseState();
    expect(initialLicense.status).toBe('TRIAL_OFFLINE');
    expect(initialLicense.offlineAllowed).toBe(true);

    const activated = repo.activateLocalLicense('DPCI-AB26-CI01', 'Dépôt Marcory');
    expect(activated.status).toBe('ACTIVE_OFFLINE');
    expect(activated.licenseKeyMasked).toBe('DPCI-****-CI01');
    expect(activated.depotNameBound).toBe('Dépôt Marcory');
    expect(activated.offlineAllowed).toBe(true);

    const integrity = repo.runIntegrityCheck();
    expect(integrity.status).toBe('OK');

    db.close();
  });
});
