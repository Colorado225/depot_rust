import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLocalSqlite } from '../server/db/sqlite.ts';
import { AppError } from '../server/error.ts';
import { AuthRepository } from '../server/repositories/authRepo.ts';
import { CatalogRepository } from '../server/repositories/catalogRepo.ts';
import { createCatalogRouter } from '../server/routes/catalog.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot2-'));
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

describe('LOT 2 — Catalogue Produits, Conditionnements, Tarifs & Emballages Consignés', () => {
  it('Scénario A : crée un produit avec un casier de 24 bouteilles, emballages consignés et stock initial à 0', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Treichville',
      ownerFullName: 'Touré Moussa',
      username: 'patron',
      password: 'Password2026!',
    });

    const cat = catalogRepo.createCategory(owner.user.id, 'Bières blondes', 'Bières en verre');
    const brand = catalogRepo.createBrand(owner.user.id, 'Solibra');
    const cratePkg = catalogRepo.createPackagingType(owner.user.id, {
      code: 'CASIER-24',
      name: 'Casier 24 trous plastique',
      kind: 'CRATE',
      depositAmountXof: 3000,
    });
    const bottlePkg = catalogRepo.createPackagingType(owner.user.id, {
      code: 'BOUT-65',
      name: 'Bouteille 65cl verre',
      kind: 'BOTTLE',
      depositAmountXof: 150,
    });

    const bock = catalogRepo.createProduct(owner.user.id, {
      sku: 'BOCK-65CL',
      barcode: '3299990000011',
      name: 'Bock Solibra 65cl',
      categoryId: cat.id,
      brandId: brand.id,
      formatLabel: '65 cl',
      baseUnitId: 'unit-bottle',
      bottlePackagingTypeId: bottlePkg.id,
      cratePackagingTypeId: cratePkg.id,
      purchasePriceXof: 400,
      wholesalePriceXof: 450,
      retailPriceXof: 500,
      alertThresholdBase: 48,
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
          barcode: '3299990000240',
          isDefaultSaleUnit: true,
        },
      ],
    });

    expect(bock.sku).toBe('BOCK-65CL');
    expect(bock.stockQuantityBase).toBe(0);
    expect(bock.crateDepositXof).toBe(3000);
    expect(bock.bottleDepositXof).toBe(150);
    expect(bock.units).toHaveLength(2);
    const crateUnit = bock.units.find((u) => u.unitId === 'unit-crate');
    expect(crateUnit?.conversionToBase).toBe(24);
    expect(crateUnit?.wholesalePriceXof).toBe(10500);

    // Deuxième produit avec une conversion différente (casier de 12 bouteilles) — jamais universelle
    const vin = catalogRepo.createProduct(owner.user.id, {
      sku: 'VIN-75CL',
      name: 'Vin Rouge Table 75cl',
      baseUnitId: 'unit-bottle',
      purchasePriceXof: 1200,
      wholesalePriceXof: 1500,
      retailPriceXof: 1800,
      alertThresholdBase: 12,
      units: [
        {
          unitId: 'unit-bottle',
          conversionToBase: 1,
          wholesalePriceXof: 1500,
          retailPriceXof: 1800,
          isDefaultSaleUnit: false,
        },
        {
          unitId: 'unit-crate',
          conversionToBase: 12,
          wholesalePriceXof: 17500,
          retailPriceXof: 20000,
          isDefaultSaleUnit: true,
        },
      ],
    });

    expect(vin.units.find((u) => u.unitId === 'unit-crate')?.conversionToBase).toBe(12);

    // Recherche par code-barres d'unité
    const foundByCrateBarcode = catalogRepo.listProducts({ search: '3299990000240' });
    expect(foundByCrateBarcode).toHaveLength(1);
    expect(foundByCrateBarcode[0].id).toBe(bock.id);

    // Rejet code-barres dupliqué sur un autre produit
    expect(() =>
      catalogRepo.createProduct(owner.user.id, {
        sku: 'AUTRE-PROD',
        barcode: '3299990000240',
        name: 'Doublon Barcode',
        baseUnitId: 'unit-bottle',
        purchasePriceXof: 100,
        wholesalePriceXof: 150,
        retailPriceXof: 200,
        alertThresholdBase: 0,
        units: [
          {
            unitId: 'unit-bottle',
            conversionToBase: 1,
            wholesalePriceXof: 150,
            retailPriceXof: 200,
            isDefaultSaleUnit: true,
          },
        ],
      })
    ).toThrow(/déjà attribué/);

    // Archivage doux sans suppression physique
    const archived = catalogRepo.toggleProductActive(owner.user.id, bock.id, false);
    expect(archived.isActive).toBe(false);
    expect(catalogRepo.listProducts()).toHaveLength(1);
    expect(catalogRepo.listProducts({ includeInactive: true })).toHaveLength(2);

    db.close();
  });

  it('applique le contrôle RBAC sur le catalogue (Caissier peut lire mais reçoit 403 en écriture)', async () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Koumassi',
      ownerFullName: 'Patron Koumassi',
      username: 'patron',
      password: 'Password2026!',
    });

    authRepo.createUserWithEmployee(owner.user.id, {
      fullName: 'Caissier Koumassi',
      username: 'caissier',
      password: 'Password2026!',
      roleId: 'role-cashier',
    });
    const cashier = authRepo.login('caissier', 'Password2026!');

    const app = express();
    app.use(express.json());
    app.use('/api/catalog', createCatalogRouter(catalogRepo, authRepo));
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

      // Lecture autorisée pour le Caissier
      const readRes = await fetch(`${baseUrl}/api/catalog/products`, {
        headers: { Authorization: `Bearer ${cashier.token}` },
      });
      expect(readRes.status).toBe(200);

      // Création interdite pour le Caissier -> 403 PERMISSION_DENIED
      const writeRes = await fetch(`${baseUrl}/api/catalog/categories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashier.token}`,
        },
        body: JSON.stringify({ name: 'Catégorie Non Autorisée' }),
      });
      expect(writeRes.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
