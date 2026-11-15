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
import { PurchaseRepository } from '../server/repositories/purchaseRepo.ts';
import { StockRepository } from '../server/repositories/stockRepo.ts';
import { SupplierRepository } from '../server/repositories/supplierRepo.ts';
import { createPurchasesRouter } from '../server/routes/purchases.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot4-'));
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

describe('LOT 4 — Achats, Réceptions partielles/complètes, CUMP automatique & Dettes fournisseurs', () => {
  it('Scénario B + Réception partielle/complète + CUMP + Règlement + Retour fournisseur', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const supplierRepo = new SupplierRepository(db);
    const stockRepo = new StockRepository(db);
    const purchaseRepo = new PurchaseRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Adjamé',
      ownerFullName: 'Bamba Ali',
      username: 'patron',
      password: 'Password2026!',
    });

    const brassivoire = supplierRepo.createSupplier(owner.user.id, {
      name: 'BRASSIVOIRE SA',
      supplierType: 'BRASSERIE',
      paymentTermsDays: 15,
    });

    const ivoire = catalogRepo.createProduct(owner.user.id, {
      sku: 'IVOIRE-50',
      name: 'Ivoire 50cl',
      preferredSupplierId: brassivoire.id,
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

    // 1) Création + validation d'un bon de commande de 10 casiers à 9 600 FCFA/casier (= 400 FCFA/bouteille)
    const po1 = purchaseRepo.createPurchaseOrder(owner.user.id, {
      supplierId: brassivoire.id,
      validateImmediately: true,
      note: 'Commande hebdomadaire Ivoire',
      items: [
        {
          productId: ivoire.id,
          unitId: 'unit-crate',
          orderedQty: 10,
          unitCostXof: 9600,
        },
      ],
    });

    expect(po1.status).toBe('VALIDATED');
    expect(po1.totalAmountXof).toBe(96000);
    expect(po1.receivedAmountXof).toBe(0);

    // RÈGLE CRITIQUE : la validation d'une commande NE DOIT PAS augmenter le stock ni la dette
    const stockBeforeReceipt = stockRepo.listStockBalances().find((b) => b.productId === ivoire.id)!;
    expect(stockBeforeReceipt.quantityBase).toBe(0);
    expect(supplierRepo.listSuppliers()[0].balanceDueXof).toBe(0);

    // 2) Réception partielle de 4 casiers sur 10 (= 96 bouteilles, 38 400 FCFA)
    const rec1 = purchaseRepo.receivePurchaseOrder(owner.user.id, po1.id, {
      supplierInvoiceRef: 'BL-BRAS-001',
      items: [{ purchaseItemId: po1.items[0].id, receivedQty: 4 }],
    });
    expect(rec1.totalReceivedXof).toBe(38400);

    const poAfterRec1 = purchaseRepo.getPurchaseOrderById(po1.id);
    expect(poAfterRec1.status).toBe('PARTIAL_RECEIVED');
    expect(poAfterRec1.receivedAmountXof).toBe(38400);
    expect(poAfterRec1.items[0].remainingQty).toBe(6);

    const stockAfterRec1 = stockRepo.listStockBalances().find((b) => b.productId === ivoire.id)!;
    expect(stockAfterRec1.quantityBase).toBe(96);
    expect(stockAfterRec1.weightedAvgCostXof).toBe(400);
    expect(supplierRepo.listSuppliers()[0].balanceDueXof).toBe(38400);

    // 3) Rejet de sur-réception (tenter 7 casiers alors qu'il en reste 6)
    expect(() =>
      purchaseRepo.receivePurchaseOrder(owner.user.id, po1.id, {
        items: [{ purchaseItemId: po1.items[0].id, receivedQty: 7 }],
      })
    ).toThrow(/supérieure au reliquat/);

    // 4) Règlement partiel de 20 000 FCFA via Orange Money
    const pay1 = purchaseRepo.recordSupplierPayment(owner.user.id, {
      supplierId: brassivoire.id,
      purchaseOrderId: po1.id,
      paymentMethod: 'ORANGE_MONEY',
      amountXof: 20000,
      externalReference: 'OM-2026-991',
    });
    expect(pay1.amountXof).toBe(20000);
    expect(supplierRepo.listSuppliers()[0].balanceDueXof).toBe(18400);

    // 5) Réception finale des 6 casiers restants -> Scénario B : 10 casiers = 240 bouteilles en stock !
    purchaseRepo.receivePurchaseOrder(owner.user.id, po1.id, {
      supplierInvoiceRef: 'BL-BRAS-002',
      items: [{ purchaseItemId: po1.items[0].id, receivedQty: 6 }],
    });

    const poAfterRec2 = purchaseRepo.getPurchaseOrderById(po1.id);
    expect(poAfterRec2.status).toBe('RECEIVED');
    expect(poAfterRec2.receivedAmountXof).toBe(96000);
    expect(poAfterRec2.remainingToPayOnReceivedXof).toBe(76000);

    const stockAfterRec2 = stockRepo.listStockBalances().find((b) => b.productId === ivoire.id)!;
    expect(stockAfterRec2.quantityBase).toBe(240);
    expect(supplierRepo.listSuppliers()[0].balanceDueXof).toBe(76000);

    // 6) Deuxième commande de 240 bouteilles (10 casiers) à 12 000 FCFA/casier (= 500 FCFA/bouteille)
    // Vérification recalcul CUMP automatique : (240 × 400 + 240 × 500) / 480 = 450 FCFA !
    const po2 = purchaseRepo.createPurchaseOrder(owner.user.id, {
      supplierId: brassivoire.id,
      validateImmediately: true,
      items: [
        {
          productId: ivoire.id,
          unitId: 'unit-crate',
          orderedQty: 10,
          unitCostXof: 12000,
        },
      ],
    });
    purchaseRepo.receivePurchaseOrder(owner.user.id, po2.id, {
      items: [{ purchaseItemId: po2.items[0].id, receivedQty: 10 }],
    });

    const stockAfterPo2 = stockRepo.listStockBalances().find((b) => b.productId === ivoire.id)!;
    expect(stockAfterPo2.quantityBase).toBe(480);
    expect(stockAfterPo2.weightedAvgCostXof).toBe(450);

    // 7) Retour fournisseur d'un casier (24 bouteilles) sur po2
    const ret = purchaseRepo.recordSupplierReturn(owner.user.id, {
      purchaseOrderId: po2.id,
      productId: ivoire.id,
      unitId: 'unit-crate',
      quantity: 1,
      note: 'Casier non conforme',
    });
    expect(ret.baseQtyReturned).toBe(24);
    expect(ret.totalReturnXof).toBe(12000);

    const stockAfterRet = stockRepo.listStockBalances().find((b) => b.productId === ivoire.id)!;
    expect(stockAfterRet.quantityBase).toBe(456);

    const movements = stockRepo.listMovements({ productId: ivoire.id });
    expect(movements[0].movementType).toBe('SUPPLIER_RETURN');
    expect(movements[0].quantityDeltaBase).toBe(-24);

    db.close();
  });

  it('applique le contrôle RBAC HTTP 403 sur les achats (Caissier interdit en mutation)', async () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const supplierRepo = new SupplierRepository(db);
    const purchaseRepo = new PurchaseRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Abobo',
      ownerFullName: 'Patron Abobo',
      username: 'patron',
      password: 'Password2026!',
    });

    authRepo.createUserWithEmployee(owner.user.id, {
      fullName: 'Caissier Abobo',
      username: 'caissier',
      password: 'Password2026!',
      roleId: 'role-cashier',
    });
    const cashier = authRepo.login('caissier', 'Password2026!');

    const sup = supplierRepo.createSupplier(owner.user.id, {
      name: 'SOLIBRA',
      supplierType: 'BRASSERIE',
      paymentTermsDays: 0,
    });
    const prod = catalogRepo.createProduct(owner.user.id, {
      sku: 'FLAG-65',
      name: 'Flag 65cl',
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
          isDefaultSaleUnit: true,
        },
      ],
    });

    const app = express();
    app.use(express.json());
    app.use('/api/purchases', createPurchasesRouter(purchaseRepo, authRepo));
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

      // Lecture autorisée
      const readRes = await fetch(`${baseUrl}/api/purchases/orders`, {
        headers: { Authorization: `Bearer ${cashier.token}` },
      });
      expect(readRes.status).toBe(200);

      // Création commande interdite -> 403
      const createRes = await fetch(`${baseUrl}/api/purchases/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashier.token}`,
        },
        body: JSON.stringify({
          supplierId: sup.id,
          validateImmediately: true,
          items: [{ productId: prod.id, unitId: 'unit-bottle', orderedQty: 10, unitCostXof: 400 }],
        }),
      });
      expect(createRes.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
