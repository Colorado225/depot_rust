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
import { CustomerRepository } from '../server/repositories/customerRepo.ts';
import { PosRepository } from '../server/repositories/posRepo.ts';
import { PurchaseRepository } from '../server/repositories/purchaseRepo.ts';
import { StockRepository } from '../server/repositories/stockRepo.ts';
import { SupplierRepository } from '../server/repositories/supplierRepo.ts';
import { createCustomersRouter } from '../server/routes/customers.ts';
import { createPosRouter } from '../server/routes/pos.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot5-'));
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

describe('LOT 5 — Clients, Créances, Point de Vente (POS), Paiements multi-canaux & Annulation', () => {
  it('Scénarios C, D, E, F, J : Vente multi-unités (51 bouteilles), Crédit & plafond, Paiements partiels, Consignes séparées, Idempotence & Annulation compensatoire', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);

    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const supplierRepo = new SupplierRepository(db);
    const stockRepo = new StockRepository(db);
    const purchaseRepo = new PurchaseRepository(db);
    const customerRepo = new CustomerRepository(db);
    const posRepo = new PosRepository(db, authRepo);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Marcory',
      ownerFullName: 'Koné Seydou',
      username: 'patron',
      password: 'Password2026!',
    });

    const solibra = supplierRepo.createSupplier(owner.user.id, {
      name: 'SOLIBRA CI',
      supplierType: 'BRASSERIE',
      paymentTermsDays: 15,
    });

    const bottlePkg = catalogRepo.createPackagingType(owner.user.id, {
      code: 'BTL-66',
      name: 'Bouteille Verre 66cl',
      kind: 'BOTTLE',
      depositAmountXof: 100,
    });
    const cratePkg = catalogRepo.createPackagingType(owner.user.id, {
      code: 'CAS-24',
      name: 'Casier 24 alvéoles',
      kind: 'CRATE',
      depositAmountXof: 1600,
    });

    const bock = catalogRepo.createProduct(owner.user.id, {
      sku: 'BOCK-66',
      barcode: '6181000000012',
      name: 'Bock Solibra 66cl',
      preferredSupplierId: solibra.id,
      baseUnitId: 'unit-bottle',
      bottlePackagingTypeId: bottlePkg.id,
      cratePackagingTypeId: cratePkg.id,
      purchasePriceXof: 400,
      wholesalePriceXof: 450,
      retailPriceXof: 550,
      alertThresholdBase: 24,
      units: [
        {
          unitId: 'unit-bottle',
          conversionToBase: 1,
          wholesalePriceXof: 450,
          retailPriceXof: 550,
          isDefaultSaleUnit: false,
        },
        {
          unitId: 'unit-crate',
          conversionToBase: 24,
          wholesalePriceXof: 10000,
          retailPriceXof: 12000,
          isDefaultSaleUnit: true,
        },
      ],
    });

    // Réception de 10 casiers = 240 bouteilles en stock
    const po = purchaseRepo.createPurchaseOrder(owner.user.id, {
      supplierId: solibra.id,
      validateImmediately: true,
      items: [
        {
          productId: bock.id,
          unitId: 'unit-crate',
          orderedQty: 10,
          unitCostXof: 9600,
        },
      ],
    });
    purchaseRepo.receivePurchaseOrder(owner.user.id, po.id, {
      items: [{ purchaseItemId: po.items[0].id, receivedQty: 10 }],
    });

    expect(stockRepo.listStockBalances().find((b) => b.productId === bock.id)?.quantityBase).toBe(
      240
    );

    // 1) Scénario C : Vendre 2 casiers + 3 bouteilles au comptant mixte (Espèces + Wave) = 51 bouteilles sorties
    const saleC = posRepo.createSale(owner.user.id, {
      idempotencyKey: 'idem-scenario-c-001',
      priceTier: 'WHOLESALE',
      discountXof: 0,
      items: [
        { productId: bock.id, unitId: 'unit-crate', quantity: 2, applyConsignment: false },
        { productId: bock.id, unitId: 'unit-bottle', quantity: 3, applyConsignment: false },
      ],
      payments: [
        { paymentMethod: 'CASH', amountXof: 15000 },
        { paymentMethod: 'WAVE', amountXof: 6350, externalReference: 'WAVE-9910' },
      ],
    });

    expect(saleC.subtotalXof).toBe(2 * 10000 + 3 * 450); // 21 350 FCFA
    expect(saleC.totalPayableXof).toBe(21350);
    expect(saleC.paidAmountXof).toBe(21350);
    expect(saleC.creditAmountXof).toBe(0);
    expect(saleC.payments).toHaveLength(2);

    // Vérifier que 240 - 51 = 189 bouteilles restent en stock
    expect(stockRepo.listStockBalances().find((b) => b.productId === bock.id)?.quantityBase).toBe(
      189
    );

    // RÈGLE 13 : Rejouer la même idempotencyKey ne doit PAS créer une seconde vente ni déduire encore 51 bouteilles
    const duplicateReplay = posRepo.createSale(owner.user.id, {
      idempotencyKey: 'idem-scenario-c-001',
      priceTier: 'WHOLESALE',
      items: [{ productId: bock.id, unitId: 'unit-crate', quantity: 2 }],
      payments: [{ paymentMethod: 'CASH', amountXof: 20000 }],
    });
    expect(duplicateReplay.id).toBe(saleC.id);
    expect(stockRepo.listStockBalances().find((b) => b.productId === bock.id)?.quantityBase).toBe(
      189
    );

    // 2) RÈGLE 9 : Stock négatif interdit par défaut (demander 10 casiers = 240 > 189 dispo)
    expect(() =>
      posRepo.createSale(owner.user.id, {
        idempotencyKey: 'idem-overstock-002',
        priceTier: 'WHOLESALE',
        items: [{ productId: bock.id, unitId: 'unit-crate', quantity: 10 }],
        payments: [{ paymentMethod: 'CASH', amountXof: 100000 }],
      })
    ).toThrow(/Stock insuffisant/);

    // 3) Scénarios D, E & F : Client avec plafond 50 000 FCFA, vente à crédit + consignes séparées, puis paiements partiels
    const maquis = customerRepo.createCustomer(owner.user.id, {
      fullName: 'Maquis Le Palmier',
      customerType: 'DETAILLANT',
      phone: '+225 07 11 22 33 44',
      address: 'Marcory Zone 4',
      creditLimitXof: 50000,
      dueDays: 15,
    });

    // Vente de 3 casiers (30 000 FCFA) + consigne (3 * (24*100 + 1600) = 12 000 FCFA) = 42 000 FCFA
    // Acompte Orange Money = 12 000 FCFA -> Crédit = 30 000 FCFA
    const creditSale = posRepo.createSale(owner.user.id, {
      idempotencyKey: 'idem-credit-003',
      customerId: maquis.id,
      priceTier: 'WHOLESALE',
      items: [{ productId: bock.id, unitId: 'unit-crate', quantity: 3, applyConsignment: true }],
      payments: [
        { paymentMethod: 'ORANGE_MONEY', amountXof: 12000, externalReference: 'OM-4401' },
      ],
    });

    expect(creditSale.subtotalXof).toBe(30000);
    expect(creditSale.consignmentTotalXof).toBe(12000);
    expect(creditSale.totalPayableXof).toBe(42000);
    expect(creditSale.creditAmountXof).toBe(30000);

    // Vérifier séparation stricte entre créance commerciale (30 000) et solde consignes (12 000)
    const maquisAfterSale = customerRepo.getCustomerById(maquis.id);
    expect(maquisAfterSale.commercialDebtXof).toBe(30000);
    expect(maquisAfterSale.consignmentBalanceXof).toBe(12000);

    // Dépassement du plafond de crédit (30 000 existant + 25 000 > 50 000) refusé
    expect(() =>
      posRepo.createSale(owner.user.id, {
        idempotencyKey: 'idem-credit-limit-004',
        customerId: maquis.id,
        priceTier: 'WHOLESALE',
        items: [{ productId: bock.id, unitId: 'unit-crate', quantity: 3, applyConsignment: false }],
        payments: [{ paymentMethod: 'CASH', amountXof: 5000 }],
      })
    ).toThrow(/Plafond de crédit dépassé/);

    // Scénario E : Paiements partiels multiples (10 000 Espèces puis 20 000 MTN MoMo)
    customerRepo.recordCustomerDebtPayment(owner.user.id, {
      customerId: maquis.id,
      paymentMethod: 'CASH',
      amountXof: 10000,
    });
    expect(customerRepo.getCustomerById(maquis.id).commercialDebtXof).toBe(20000);

    customerRepo.recordCustomerDebtPayment(owner.user.id, {
      customerId: maquis.id,
      paymentMethod: 'MTN_MOMO',
      amountXof: 20000,
      externalReference: 'MOMO-8821',
    });
    expect(customerRepo.getCustomerById(maquis.id).commercialDebtXof).toBe(0);
    // Le solde consigne (12 000) reste intact et distinct !
    expect(customerRepo.getCustomerById(maquis.id).consignmentBalanceXof).toBe(12000);

    // 4) Scénario J : Annulation compensatoire d'une vente (jamais de suppression physique)
    const stockBeforeCancel = stockRepo
      .listStockBalances()
      .find((b) => b.productId === bock.id)!.quantityBase;
    expect(stockBeforeCancel).toBe(189 - 72); // 117 bouteilles

    const cancelled = posRepo.cancelSale(owner.user.id, creditSale.id, 'Erreur de commande client');
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelReason).toBe('Erreur de commande client');

    // Le stock de 72 bouteilles (3 casiers) est réintégré -> 189 bouteilles
    expect(stockRepo.listStockBalances().find((b) => b.productId === bock.id)?.quantityBase).toBe(
      189
    );
    // La consigne générée par cette vente annulée est également compensée -> 0
    expect(customerRepo.getCustomerById(maquis.id).consignmentBalanceXof).toBe(0);
  });

  it('RBAC POS & Clients : Caissier peut vendre sans remise (403 sur remise/annulation), Magasinier bloqué (403)', async () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const stockRepo = new StockRepository(db);
    const customerRepo = new CustomerRepository(db);
    const posRepo = new PosRepository(db, authRepo);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt RBAC POS',
      ownerFullName: 'Patron',
      username: 'patron',
      password: 'Password2026!',
    });

    const prod = catalogRepo.createProduct(owner.user.id, {
      sku: 'CASTEL-50',
      name: 'Castel Beer 50cl',
      baseUnitId: 'unit-bottle',
      purchasePriceXof: 380,
      wholesalePriceXof: 450,
      retailPriceXof: 500,
      alertThresholdBase: 10,
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
    stockRepo.recordMovement(owner.user.id, {
      productId: prod.id,
      unitId: 'unit-bottle',
      quantity: 50,
      movementType: 'INITIAL',
      unitCostXof: 380,
    });

    authRepo.createUserWithEmployee(owner.user.id, {
      fullName: 'Caissier Test',
      username: 'caissier',
      password: 'Password2026!',
      roleId: 'role-cashier',
    });
    authRepo.createUserWithEmployee(owner.user.id, {
      fullName: 'Magasinier Test',
      username: 'magasinier',
      password: 'Password2026!',
      roleId: 'role-warehouse',
    });

    const cashierToken = authRepo.login('caissier', 'Password2026!').token;
    const warehouseToken = authRepo.login('magasinier', 'Password2026!').token;
    const ownerToken = authRepo.login('patron', 'Password2026!').token;

    const app = express();
    app.use(express.json());
    app.use('/api/customers', createCustomersRouter(customerRepo, authRepo));
    app.use('/api/pos', createPosRouter(posRepo, authRepo));
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
        res.status(500).json({ message: String(err) });
      }
    );

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      // Magasinier ne peut pas créer une vente (403)
      const magRes = await fetch(`http://127.0.0.1:${port}/api/pos/sales`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${warehouseToken}`,
        },
        body: JSON.stringify({
          idempotencyKey: 'idem-mag-001',
          priceTier: 'RETAIL',
          items: [{ productId: prod.id, unitId: 'unit-bottle', quantity: 2 }],
          payments: [{ paymentMethod: 'CASH', amountXof: 1000 }],
        }),
      });
      expect(magRes.status).toBe(403);

      // Caissier ne peut pas appliquer une remise sans pos.discount.apply (403)
      const discRes = await fetch(`http://127.0.0.1:${port}/api/pos/sales`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`,
        },
        body: JSON.stringify({
          idempotencyKey: 'idem-cashier-disc-001',
          priceTier: 'RETAIL',
          discountXof: 100,
          items: [{ productId: prod.id, unitId: 'unit-bottle', quantity: 2 }],
          payments: [{ paymentMethod: 'CASH', amountXof: 900 }],
        }),
      });
      expect(discRes.status).toBe(403);

      // Caissier peut créer une vente normale sans remise (201)
      const okRes = await fetch(`http://127.0.0.1:${port}/api/pos/sales`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`,
        },
        body: JSON.stringify({
          idempotencyKey: 'idem-cashier-ok-001',
          priceTier: 'RETAIL',
          items: [{ productId: prod.id, unitId: 'unit-bottle', quantity: 2 }],
          payments: [{ paymentMethod: 'CASH', amountXof: 1000 }],
        }),
      });
      expect(okRes.status).toBe(201);
      const createdSale = (await okRes.json()) as { id: string };

      // Caissier ne peut pas annuler une vente (403)
      const cancelCashierRes = await fetch(
        `http://127.0.0.1:${port}/api/pos/sales/${createdSale.id}/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cashierToken}`,
          },
          body: JSON.stringify({ reason: 'Test caissier' }),
        }
      );
      expect(cancelCashierRes.status).toBe(403);

      // Propriétaire peut annuler la vente (200)
      const cancelOwnerRes = await fetch(
        `http://127.0.0.1:${port}/api/pos/sales/${createdSale.id}/cancel`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerToken}`,
          },
          body: JSON.stringify({ reason: 'Annulation validée par le propriétaire' }),
        }
      );
      expect(cancelOwnerRes.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
