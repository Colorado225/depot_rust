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
import { FinanceRepository } from '../server/repositories/financeRepo.ts';
import { PosRepository } from '../server/repositories/posRepo.ts';
import { PurchaseRepository } from '../server/repositories/purchaseRepo.ts';
import { ReportsRepository } from '../server/repositories/reportsRepo.ts';
import { StockRepository } from '../server/repositories/stockRepo.ts';
import { SupplierRepository } from '../server/repositories/supplierRepo.ts';
import { createReportsRouter } from '../server/routes/reports.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot8-'));
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

describe('LOT 8 — Rapports analytiques, Marges CUMP réelles & Exports CSV/PDF', () => {
  it('Scénario Q : Réconciliation exacte des marges CUMP, ventes annulées exclues, consignes séparées, stock valorisé et exports CSV/PDF', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);

    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const supplierRepo = new SupplierRepository(db);
    const stockRepo = new StockRepository(db);
    const purchaseRepo = new PurchaseRepository(db);
    const customerRepo = new CustomerRepository(db);
    const posRepo = new PosRepository(db, authRepo);
    const financeRepo = new FinanceRepository(db);
    const reportsRepo = new ReportsRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Cocody',
      ownerFullName: 'Konan Yao',
      username: 'patron',
      password: 'Password2026!',
    });

    const solibra = supplierRepo.createSupplier(owner.user.id, {
      name: 'SOLIBRA',
      supplierType: 'BRASSERIE',
      paymentTermsDays: 15,
    });

    const bottlePkg = catalogRepo.createPackagingType(owner.user.id, {
      code: 'BTL-66',
      name: 'Bouteille 66cl',
      kind: 'BOTTLE',
      depositAmountXof: 100,
    });
    const cratePkg = catalogRepo.createPackagingType(owner.user.id, {
      code: 'CAS-24',
      name: 'Casier 24',
      kind: 'CRATE',
      depositAmountXof: 1600,
    });

    const bock = catalogRepo.createProduct(owner.user.id, {
      sku: 'BOCK-66',
      name: 'Bock Solibra 66cl',
      preferredSupplierId: solibra.id,
      baseUnitId: 'unit-bottle',
      bottlePackagingTypeId: bottlePkg.id,
      cratePackagingTypeId: cratePkg.id,
      purchasePriceXof: 400,
      wholesalePriceXof: 550,
      retailPriceXof: 600,
      alertThresholdBase: 24,
      units: [
        {
          unitId: 'unit-bottle',
          conversionToBase: 1,
          wholesalePriceXof: 550,
          retailPriceXof: 600,
          isDefaultSaleUnit: false,
        },
        {
          unitId: 'unit-crate',
          conversionToBase: 24,
          wholesalePriceXof: 12000,
          retailPriceXof: 13200,
          isDefaultSaleUnit: true,
        },
      ],
    });

    // 1) Réception 1 : 10 casiers à 9 600 FCFA (400/btl) = 96 000 FCFA -> 240 btl @ CUMP 400
    // 2) Réception 2 : 10 casiers à 12 000 FCFA (500/btl) = 120 000 FCFA -> 480 btl @ CUMP 450
    const po1 = purchaseRepo.createPurchaseOrder(owner.user.id, {
      supplierId: solibra.id,
      validateImmediately: true,
      items: [{ productId: bock.id, unitId: 'unit-crate', orderedQty: 10, unitCostXof: 9600 }],
    });
    purchaseRepo.receivePurchaseOrder(owner.user.id, po1.id, {
      items: [{ purchaseItemId: po1.items[0].id, receivedQty: 10 }],
    });

    const po2 = purchaseRepo.createPurchaseOrder(owner.user.id, {
      supplierId: solibra.id,
      validateImmediately: true,
      items: [{ productId: bock.id, unitId: 'unit-crate', orderedQty: 10, unitCostXof: 12000 }],
    });
    purchaseRepo.receivePurchaseOrder(owner.user.id, po2.id, {
      items: [{ purchaseItemId: po2.items[0].id, receivedQty: 10 }],
    });

    const client = customerRepo.createCustomer(owner.user.id, {
      fullName: 'Maquis Horizon',
      customerType: 'DETAILLANT',
      creditLimitXof: 100000,
      dueDays: 15,
    });

    // 3) Vente validée : 2 casiers + 2 bouteilles (50 bouteilles)
    // CA brut = 2*12000 + 2*550 = 25 100 ; remise = 1 100 -> CA net = 24 000 FCFA
    // Consigne = 2*1600 + 50*100 = 8 200 FCFA (strictement exclue du CA !)
    // Total dû = 32 200 ; payé = 15 000 ; crédit = 17 200
    posRepo.createSale(owner.user.id, {
      idempotencyKey: 'idem-lot8-sale-1',
      customerId: client.id,
      priceTier: 'WHOLESALE',
      discountXof: 1100,
      items: [
        { productId: bock.id, unitId: 'unit-crate', quantity: 2, applyConsignment: true },
        { productId: bock.id, unitId: 'unit-bottle', quantity: 2, applyConsignment: true },
      ],
      payments: [{ paymentMethod: 'CASH', amountXof: 15000 }],
    });

    // 4) Vente annulée : doit être exclue du CA et des marges
    const cancelledSale = posRepo.createSale(owner.user.id, {
      idempotencyKey: 'idem-lot8-sale-cancel',
      customerId: client.id,
      priceTier: 'WHOLESALE',
      items: [{ productId: bock.id, unitId: 'unit-crate', quantity: 3, applyConsignment: false }],
      payments: [{ paymentMethod: 'CASH', amountXof: 36000 }],
    });
    posRepo.cancelSale(owner.user.id, cancelledSale.id, 'Erreur de saisie');

    // 5) Casse de 4 bouteilles (4 * 450 = 1 800 FCFA) + dépense 3 000 FCFA
    stockRepo.recordMovement(owner.user.id, {
      productId: bock.id,
      unitId: 'unit-bottle',
      quantity: 4,
      movementType: 'BREAKAGE',
      note: 'Casse déchargement',
    });
    financeRepo.recordExpense(owner.user.id, {
      categoryId: 'exp-transport',
      amountXof: 3000,
      paymentMethod: 'WAVE',
      description: 'Course livraison',
    });

    // Vérification Scénario Q : Comparaison exacte avec les écritures sources
    const overview = reportsRepo.getOverviewReport();
    expect(overview.salesCount).toBe(1);
    expect(overview.cancelledSalesCount).toBe(1);
    expect(overview.salesGrossSubtotalXof).toBe(25100);
    expect(overview.salesDiscountXof).toBe(1100);
    expect(overview.salesRevenueXof).toBe(24000);
    expect(overview.consignmentOnSalesXof).toBe(8200);
    expect(overview.cogsXof).toBe(50 * 450); // 22 500
    expect(overview.grossMarginXof).toBe(24000 - 22500); // 1 500
    expect(overview.expensesXof).toBe(3000);
    expect(overview.breakageLossCostXof).toBe(4 * 450); // 1 800
    expect(overview.operatingResultXof).toBe(1500 - 3000 - 1800); // -3 300

    const margins = reportsRepo.getProductMargins();
    expect(margins).toHaveLength(1);
    expect(margins[0].qtySoldBase).toBe(50);
    expect(margins[0].cogsXof).toBe(22500);
    expect(margins[0].currentStockBase).toBe(480 - 50 - 4); // 426
    expect(margins[0].weightedAvgCostXof).toBe(450);
    expect(margins[0].stockValuationCumpXof).toBe(426 * 450); // 191 700

    const snapshot = reportsRepo.getSnapshot();
    expect(snapshot.totalStockValuationXof).toBe(191700);
    expect(snapshot.totalCustomerReceivablesXof).toBe(17200);
    expect(snapshot.customerConsignmentValueXof).toBe(8200);
    expect(snapshot.totalSupplierPayablesXof).toBe(96000 + 120000); // 216 000

    // Exports CSV & PDF
    const csvExport = reportsRepo.exportDataset(owner.user.id, {
      dataset: 'margins',
      format: 'csv',
    });
    const csvText = csvExport.buffer.toString('utf8');
    expect(csvText.startsWith('\uFEFF')).toBe(true);
    expect(csvText).toContain('BOCK-66');
    expect(csvText).toContain('22500');
    expect(csvText).toContain('191700');

    const pdfExport = reportsRepo.exportDataset(owner.user.id, {
      dataset: 'margins',
      format: 'pdf',
    });
    const pdfHead = pdfExport.buffer.subarray(0, 8).toString('latin1');
    const pdfTail = pdfExport.buffer.toString('latin1').slice(-10);
    expect(pdfHead).toContain('%PDF-1.4');
    expect(pdfTail).toContain('%%EOF');
    expect(pdfExport.buffer.toString('latin1')).toContain('BOCK-66');
  });

  it('RBAC HTTP Rapports : 401 sans session, 403 pour Caissier/Magasinier, 200 pour Gérant/Propriétaire (JSON, CSV, PDF)', async () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const reportsRepo = new ReportsRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt RBAC Rapports',
      ownerFullName: 'Patron',
      username: 'patron',
      password: 'Password2026!',
    });

    authRepo.createUserWithEmployee(owner.user.id, {
      fullName: 'Gérant Test',
      username: 'gerant',
      password: 'Password2026!',
      roleId: 'role-manager',
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

    const managerToken = authRepo.login('gerant', 'Password2026!').token;
    const cashierToken = authRepo.login('caissier', 'Password2026!').token;
    const warehouseToken = authRepo.login('magasinier', 'Password2026!').token;

    const app = express();
    app.use(express.json());
    app.use('/api/reports', createReportsRouter(reportsRepo, authRepo));
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
      expect((await fetch(`http://127.0.0.1:${port}/api/reports/overview`)).status).toBe(401);

      expect(
        (
          await fetch(`http://127.0.0.1:${port}/api/reports/overview`, {
            headers: { Authorization: `Bearer ${cashierToken}` },
          })
        ).status
      ).toBe(403);

      expect(
        (
          await fetch(`http://127.0.0.1:${port}/api/reports/export/pdf?dataset=margins`, {
            headers: { Authorization: `Bearer ${warehouseToken}` },
          })
        ).status
      ).toBe(403);

      const mgrOverview = await fetch(`http://127.0.0.1:${port}/api/reports/overview`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      expect(mgrOverview.status).toBe(200);

      const mgrCsv = await fetch(
        `http://127.0.0.1:${port}/api/reports/export/csv?dataset=margins`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      expect(mgrCsv.status).toBe(200);
      expect(mgrCsv.headers.get('content-type')).toContain('text/csv');

      const mgrPdf = await fetch(
        `http://127.0.0.1:${port}/api/reports/export/pdf?dataset=margins`,
        {
          headers: { Authorization: `Bearer ${managerToken}` },
        }
      );
      expect(mgrPdf.status).toBe(200);
      expect(mgrPdf.headers.get('content-type')).toContain('application/pdf');
    } finally {
      server.close();
    }
  });
});
