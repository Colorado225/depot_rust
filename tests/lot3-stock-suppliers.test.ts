import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeWeightedAvgCostXof } from '../server/domain/cump.ts';
import { initLocalSqlite } from '../server/db/sqlite.ts';
import { AppError } from '../server/error.ts';
import { AuthRepository } from '../server/repositories/authRepo.ts';
import { CatalogRepository } from '../server/repositories/catalogRepo.ts';
import { StockRepository } from '../server/repositories/stockRepo.ts';
import { SupplierRepository } from '../server/repositories/supplierRepo.ts';
import { createStockRouter } from '../server/routes/stock.ts';
import { createSuppliersRouter } from '../server/routes/suppliers.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot3-'));
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

describe('LOT 3 — Stock, CUMP entier, Casse, Inventaires & Fournisseurs', () => {
  it('calcule le CUMP entier sans flottants, convertit les casiers en bouteilles, isole la casse et interdit le stock négatif', () => {
    // Vérification unitaire pure CUMP BigInt
    expect(computeWeightedAvgCostXof(100, 400, 100, 500)).toBe(450);

    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const stockRepo = new StockRepository(db);
    const supplierRepo = new SupplierRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Marcory',
      ownerFullName: 'Koffi Jean',
      username: 'patron',
      password: 'Password2026!',
    });

    const solibra = supplierRepo.createSupplier(owner.user.id, {
      name: 'SOLIBRA CI',
      supplierType: 'BRASSERIE',
      phone: '+225 27 21 00 00 00',
      paymentTermsDays: 15,
    });

    const bock = catalogRepo.createProduct(owner.user.id, {
      sku: 'BOCK-65',
      name: 'Bock Solibra 65cl',
      preferredSupplierId: solibra.id,
      baseUnitId: 'unit-bottle',
      purchasePriceXof: 400,
      wholesalePriceXof: 450,
      retailPriceXof: 500,
      alertThresholdBase: 24,
      units: [
        {
          unitId: 'unit-bottle',
          conversionToBase: 1,
          wholesalePriceXof: 450,
          retailPriceXof: 500,
          isDefaultSaleUnit: false,
        },
        {
          unitId: 'unit-crate',
          conversionToBase: 24,
          wholesalePriceXof: 10500,
          retailPriceXof: 11500,
          isDefaultSaleUnit: true,
        },
      ],
    });

    expect(bock.preferredSupplierId).toBe(solibra.id);
    expect(bock.preferredSupplierName).toBe('SOLIBRA CI');

    // 1) Entrée initiale : 100 bouteilles à 400 FCFA
    const initMv = stockRepo.recordMovement(owner.user.id, {
      productId: bock.id,
      unitId: 'unit-bottle',
      quantity: 100,
      movementType: 'INITIAL',
      unitCostXof: 400,
      note: "Stock d'ouverture",
    });
    expect(initMv.balanceAfterBase).toBe(100);

    // 2) Deuxième entrée : 100 bouteilles à 500 FCFA -> CUMP doit valoir exactement 450 FCFA
    stockRepo.recordMovement(owner.user.id, {
      productId: bock.id,
      unitId: 'unit-bottle',
      quantity: 100,
      movementType: 'MANUAL_IN',
      unitCostXof: 500,
      note: 'Réapprovisionnement complémentaire',
    });

    const balAfterIn = stockRepo.listStockBalances().find((b) => b.productId === bock.id)!;
    expect(balAfterIn.quantityBase).toBe(200);
    expect(balAfterIn.weightedAvgCostXof).toBe(450);
    expect(balAfterIn.totalValuationXof).toBe(200 * 450);

    // 3) Scénario C : sortie de 2 casiers (2 × 24 = 48) + 3 bouteilles = 51 bouteilles
    stockRepo.recordMovement(owner.user.id, {
      productId: bock.id,
      unitId: 'unit-crate',
      quantity: 2,
      movementType: 'MANUAL_OUT',
      note: 'Sortie 2 casiers',
    });
    stockRepo.recordMovement(owner.user.id, {
      productId: bock.id,
      unitId: 'unit-bottle',
      quantity: 3,
      movementType: 'MANUAL_OUT',
      note: 'Sortie 3 bouteilles',
    });

    const balAfterOut = stockRepo.listStockBalances().find((b) => b.productId === bock.id)!;
    expect(balAfterOut.quantityBase).toBe(149);

    // 4) Scénario I : casse de 5 bouteilles -> stock vendable 144, stock cassé non revendable = 5
    stockRepo.recordMovement(owner.user.id, {
      productId: bock.id,
      unitId: 'unit-bottle',
      quantity: 5,
      movementType: 'BREAKAGE',
      note: 'Casse déchargement',
    });

    const balAfterBreak = stockRepo.listStockBalances().find((b) => b.productId === bock.id)!;
    expect(balAfterBreak.quantityBase).toBe(144);
    expect(balAfterBreak.damagedQuantityBase).toBe(5);

    // 5) Rejet strict de sortie excédant le stock disponible (allow_negative_stock = 0)
    expect(() =>
      stockRepo.recordMovement(owner.user.id, {
        productId: bock.id,
        unitId: 'unit-crate',
        quantity: 10, // 240 bouteilles > 144 disponibles
        movementType: 'MANUAL_OUT',
      })
    ).toThrow(/Stock insuffisant/);

    // 6) Validation d'inventaire physique (compté réel = 140 => écart -4 => INVENTORY_ADJUSTMENT)
    const inv = stockRepo.validateInventory(
      owner.user.id,
      [{ productId: bock.id, countedBase: 140 }],
      'Inventaire hebdomadaire'
    );
    expect(inv.status).toBe('VALIDATED');
    expect(inv.totalVarianceBase).toBe(-4);

    const balAfterInv = stockRepo.listStockBalances().find((b) => b.productId === bock.id)!;
    expect(balAfterInv.quantityBase).toBe(140);

    const movements = stockRepo.listMovements({ productId: bock.id });
    expect(movements[0].movementType).toBe('INVENTORY_ADJUSTMENT');
    expect(movements[0].quantityDeltaBase).toBe(-4);
    expect(movements[0].balanceAfterBase).toBe(140);

    // 7) Fournisseurs : compteur de produits rattachés + archivage doux
    const suppliers = supplierRepo.listSuppliers();
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0].linkedProductsCount).toBe(1);

    const archivedSupplier = supplierRepo.toggleSupplierActive(owner.user.id, solibra.id, false);
    expect(archivedSupplier.isActive).toBe(false);
    expect(supplierRepo.listSuppliers()).toHaveLength(0);
    expect(supplierRepo.listSuppliers({ includeInactive: true })).toHaveLength(1);

    db.close();
  });

  it('applique le contrôle RBAC sur le stock et les fournisseurs (Caissier reçoit 403 en mutation)', async () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const stockRepo = new StockRepository(db);
    const supplierRepo = new SupplierRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Yopougon',
      ownerFullName: 'Patron Yop',
      username: 'patron',
      password: 'Password2026!',
    });

    authRepo.createUserWithEmployee(owner.user.id, {
      fullName: 'Caissier Yop',
      username: 'caissier',
      password: 'Password2026!',
      roleId: 'role-cashier',
    });
    const cashier = authRepo.login('caissier', 'Password2026!');

    const prod = catalogRepo.createProduct(owner.user.id, {
      sku: 'EAU-150',
      name: 'Eau Céleste 1.5L',
      baseUnitId: 'unit-bottle',
      purchasePriceXof: 200,
      wholesalePriceXof: 250,
      retailPriceXof: 300,
      alertThresholdBase: 12,
      units: [
        {
          unitId: 'unit-bottle',
          conversionToBase: 1,
          wholesalePriceXof: 250,
          retailPriceXof: 300,
          isDefaultSaleUnit: true,
        },
      ],
    });

    const app = express();
    app.use(express.json());
    app.use('/api/stock', createStockRouter(stockRepo, authRepo));
    app.use('/api/suppliers', createSuppliersRouter(supplierRepo, authRepo));
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
      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Lecture autorisée pour Caissier
      const readStockRes = await fetch(`${baseUrl}/api/stock/balances`, {
        headers: { Authorization: `Bearer ${cashier.token}` },
      });
      expect(readStockRes.status).toBe(200);

      // Mutation stock interdite -> 403
      const mvRes = await fetch(`${baseUrl}/api/stock/movements`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashier.token}`,
        },
        body: JSON.stringify({
          productId: prod.id,
          unitId: 'unit-bottle',
          quantity: 10,
          movementType: 'INITIAL',
          unitCostXof: 200,
        }),
      });
      expect(mvRes.status).toBe(403);

      // Création fournisseur interdite -> 403
      const supRes = await fetch(`${baseUrl}/api/suppliers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashier.token}`,
        },
        body: JSON.stringify({
          name: 'Fournisseur Test',
          supplierType: 'DISTRIBUTEUR',
          paymentTermsDays: 0,
        }),
      });
      expect(supRes.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
