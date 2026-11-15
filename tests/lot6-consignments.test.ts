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
import {
  ConsignmentRepository,
  DEPOT_HOLDER_ID,
} from '../server/repositories/consignmentRepo.ts';
import { CustomerRepository } from '../server/repositories/customerRepo.ts';
import { PosRepository } from '../server/repositories/posRepo.ts';
import { StockRepository } from '../server/repositories/stockRepo.ts';
import { SupplierRepository } from '../server/repositories/supplierRepo.ts';
import { createConsignmentsRouter } from '../server/routes/consignments.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot6-'));
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

describe('LOT 6 — Consignes & Emballages (bouteilles/casiers vides séparés du stock commercial)', () => {
  it('Scénarios F, G, H : Vente 10 casiers avec consigne, retour partiel 6 casiers, solde restant 4 casiers & remboursement sans altérer stock liquide ni créance commerciale', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);

    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const supplierRepo = new SupplierRepository(db);
    const stockRepo = new StockRepository(db);
    const customerRepo = new CustomerRepository(db);
    const posRepo = new PosRepository(db, authRepo);
    const consignmentRepo = new ConsignmentRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Yopougon',
      ownerFullName: 'Traoré Bakary',
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
      name: 'Casier 24 trous',
      kind: 'CRATE',
      depositAmountXof: 1600,
    });

    const prod = catalogRepo.createProduct(owner.user.id, {
      sku: 'FLAG-66',
      name: 'Flag Spéciale 66cl',
      preferredSupplierId: solibra.id,
      baseUnitId: 'unit-bottle',
      bottlePackagingTypeId: bottlePkg.id,
      cratePackagingTypeId: cratePkg.id,
      purchasePriceXof: 400,
      wholesalePriceXof: 460,
      retailPriceXof: 550,
      alertThresholdBase: 24,
      units: [
        {
          unitId: 'unit-bottle',
          conversionToBase: 1,
          wholesalePriceXof: 460,
          retailPriceXof: 550,
          isDefaultSaleUnit: false,
        },
        {
          unitId: 'unit-crate',
          conversionToBase: 24,
          wholesalePriceXof: 10500,
          retailPriceXof: 12000,
          isDefaultSaleUnit: true,
        },
      ],
    });

    // 15 casiers pleins en stock = 360 bouteilles pleines
    stockRepo.recordMovement(owner.user.id, {
      productId: prod.id,
      unitId: 'unit-crate',
      quantity: 15,
      movementType: 'INITIAL',
      unitCostXof: 9600,
    });

    const maquis = customerRepo.createCustomer(owner.user.id, {
      fullName: 'Maquis Chez Tantie',
      customerType: 'DETAILLANT',
      creditLimitXof: 200000,
      dueDays: 15,
    });

    // Scénario F : Vente de 10 casiers avec consignes + paiement partiel commercial
    const sale = posRepo.createSale(owner.user.id, {
      idempotencyKey: 'idem-lot6-f-001',
      customerId: maquis.id,
      priceTier: 'WHOLESALE',
      items: [{ productId: prod.id, unitId: 'unit-crate', quantity: 10, applyConsignment: true }],
      payments: [{ paymentMethod: 'CASH', amountXof: 100000 }],
    });

    // 10 casiers * (24*100 + 1600) = 40 000 FCFA de consigne
    expect(sale.consignmentTotalXof).toBe(40000);
    // Liquide 105 000 + consigne 40 000 = 145 000 ; payé 100 000 -> créance commerciale = 45 000
    expect(customerRepo.getCustomerById(maquis.id).commercialDebtXof).toBe(45000);
    expect(stockRepo.listStockBalances().find((b) => b.productId === prod.id)?.quantityBase).toBe(
      120
    );

    const customerCratesBefore = consignmentRepo.listBalances({
      holderType: 'CUSTOMER',
      holderId: maquis.id,
      kind: 'CRATE',
    });
    const customerBottlesBefore = consignmentRepo.listBalances({
      holderType: 'CUSTOMER',
      holderId: maquis.id,
      kind: 'BOTTLE',
    });
    expect(customerCratesBefore[0]?.quantity).toBe(10);
    expect(customerBottlesBefore[0]?.quantity).toBe(240);

    // Ouvrir une session de caisse pour vérifier le mouvement de caisse négatif sur remboursement CASH
    const cashRegId = 'reg-lot6-main';
    db.prepare(
      `INSERT OR IGNORE INTO cash_registers (id, code, name, is_active) VALUES (?, 'CAISSE-TEST', 'Caisse Test', 1)`
    ).run(cashRegId);
    const cashSessionId = 'cash-sess-lot6';
    db.prepare(
      `INSERT INTO cash_sessions (id, cash_register_id, opened_by_user_id, opening_balance_xof, status)
       VALUES (?, ?, ?, 100000, 'OPEN')`
    ).run(cashSessionId, cashRegId, owner.user.id);

    // Scénario G : Retour partiel de 6 casiers (et 144 bouteilles) avec remboursement Espèces
    const retCrates = consignmentRepo.recordCustomerReturn(owner.user.id, {
      customerId: maquis.id,
      packagingTypeId: cratePkg.id,
      quantity: 6,
      refundCustomer: true,
      paymentMethod: 'CASH',
      note: 'Retour partiel 6 casiers vides',
    });

    expect(retCrates.remainingCustomerQty).toBe(4);
    expect(retCrates.refundedAmountXof).toBe(6 * 1600);

    // Scénario H : Vérifier solde restant client = 4 casiers, dépôt vides = 6 casiers
    const customerCratesAfter = consignmentRepo.listBalances({
      holderType: 'CUSTOMER',
      holderId: maquis.id,
      kind: 'CRATE',
    });
    expect(customerCratesAfter[0]?.quantity).toBe(4);
    expect(customerCratesAfter[0]?.depositValueXof).toBe(4 * 1600);

    const depotCratesAfter = consignmentRepo.listBalances({
      holderType: 'DEPOT',
      holderId: DEPOT_HOLDER_ID,
      kind: 'CRATE',
    });
    expect(depotCratesAfter[0]?.quantity).toBe(6);

    // Aucun impact sur le stock commercial liquide (reste 120) ni sur la créance commerciale (reste 45 000) !
    expect(stockRepo.listStockBalances().find((b) => b.productId === prod.id)?.quantityBase).toBe(
      120
    );
    expect(customerRepo.getCustomerById(maquis.id).commercialDebtXof).toBe(45000);

    // Vérifier écritures OUTBOUND + payment_allocations(CONSIGNMENT_REFUND) + cash_movements
    const paymentRow = db
      .prepare(
        `SELECT p.direction, p.amount_xof AS amountXof, pa.target_type AS targetType
         FROM payments p
         JOIN payment_allocations pa ON pa.payment_id = p.id
         WHERE p.party_id = ? AND pa.target_type = 'CONSIGNMENT_REFUND'`
      )
      .get(maquis.id) as { direction: string; amountXof: number; targetType: string };
    expect(paymentRow.direction).toBe('OUTBOUND');
    expect(paymentRow.amountXof).toBe(9600);
    expect(paymentRow.targetType).toBe('CONSIGNMENT_REFUND');

    const cashMov = db
      .prepare(
        `SELECT movement_type AS movementType, amount_signed_xof AS amountSignedXof
         FROM cash_movements WHERE cash_session_id = ?`
      )
      .get(cashSessionId) as { movementType: string; amountSignedXof: number };
    expect(cashMov.movementType).toBe('CONSIGNMENT_REFUND');
    expect(cashMov.amountSignedXof).toBe(-9600);

    // Refus de sur-retour (tenter de rendre 5 casiers alors qu'il n'en reste que 4)
    expect(() =>
      consignmentRepo.recordCustomerReturn(owner.user.id, {
        customerId: maquis.id,
        packagingTypeId: cratePkg.id,
        quantity: 5,
        refundCustomer: false,
      })
    ).toThrow(/Retour impossible/);

    // Fournisseur : réception consignes (5 casiers dus à SOLIBRA) + retour partiel (2 casiers rendus)
    consignmentRepo.recordSupplierOperation(owner.user.id, {
      supplierId: solibra.id,
      packagingTypeId: cratePkg.id,
      quantity: 5,
      operation: 'SUPPLIER_DEPOSIT',
    });
    expect(consignmentRepo.getSummary().depotCratesQty).toBe(6 + 5); // 11 casiers vides au dépôt
    expect(consignmentRepo.getSummary().supplierQty).toBe(5);

    consignmentRepo.recordSupplierOperation(owner.user.id, {
      supplierId: solibra.id,
      packagingTypeId: cratePkg.id,
      quantity: 2,
      operation: 'SUPPLIER_RETURN',
    });
    expect(consignmentRepo.getSummary().depotCratesQty).toBe(9);
    expect(consignmentRepo.getSummary().supplierQty).toBe(3);

    // La dette commerciale fournisseur (balance_due_xof) reste strictement à 0 !
    expect(supplierRepo.listSuppliers().find((s) => s.id === solibra.id)?.balanceDueXof).toBe(0);

    // Casse / Perte emballage vide au dépôt : n'affecte que le dépôt vide, jamais le stock liquide
    consignmentRepo.recordDepotOperation(owner.user.id, {
      packagingTypeId: cratePkg.id,
      quantity: 1,
      operation: 'BREAKAGE',
      note: 'Casier fendu lors du rangement',
    });
    expect(consignmentRepo.getSummary().depotCratesQty).toBe(8);
    expect(stockRepo.listStockBalances().find((b) => b.productId === prod.id)?.quantityBase).toBe(
      120
    );
  });

  it('RBAC & API HTTP Consignes : 401 sans session, 201 avec consignment.manage, 403 sans permission', async () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);

    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const customerRepo = new CustomerRepository(db);
    const consignmentRepo = new ConsignmentRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt RBAC Consignes',
      ownerFullName: 'Patron',
      username: 'patron',
      password: 'Password2026!',
    });

    const cratePkg = catalogRepo.createPackagingType(owner.user.id, {
      code: 'CAS-24',
      name: 'Casier 24',
      kind: 'CRATE',
      depositAmountXof: 1600,
    });
    const client = customerRepo.createCustomer(owner.user.id, {
      fullName: 'Client Test',
      customerType: 'PARTICULIER',
      creditLimitXof: 0,
      dueDays: 0,
    });

    // Créer un rôle personnalisé sans la permission consignment.manage
    db.prepare(
      `INSERT INTO roles (id, code, name, is_system) VALUES ('role-readonly', 'OBSERVATEUR', 'Observateur', 0)`
    ).run();
    authRepo.createUserWithEmployee(owner.user.id, {
      fullName: 'Observateur Test',
      username: 'observateur',
      password: 'Password2026!',
      roleId: 'role-readonly',
    });
    authRepo.createUserWithEmployee(owner.user.id, {
      fullName: 'Caissier Test',
      username: 'caissier',
      password: 'Password2026!',
      roleId: 'role-cashier',
    });

    const observerToken = authRepo.login('observateur', 'Password2026!').token;
    const cashierToken = authRepo.login('caissier', 'Password2026!').token;

    const app = express();
    app.use(express.json());
    app.use('/api/consignments', createConsignmentsRouter(consignmentRepo, authRepo));
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
      // 1) Sans token -> 401
      const unauthRes = await fetch(`http://127.0.0.1:${port}/api/consignments/summary`);
      expect(unauthRes.status).toBe(401);

      // 2) Observateur sans consignment.manage -> 403
      const forbiddenRes = await fetch(
        `http://127.0.0.1:${port}/api/consignments/customer-operation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${observerToken}`,
          },
          body: JSON.stringify({
            customerId: client.id,
            packagingTypeId: cratePkg.id,
            quantity: 10,
            operation: 'SALE_DEPOSIT',
          }),
        }
      );
      expect(forbiddenRes.status).toBe(403);

      // 3) Caissier (possède consignment.manage) -> 201 sur SALE_DEPOSIT puis 201 sur CUSTOMER_RETURN
      const depositRes = await fetch(
        `http://127.0.0.1:${port}/api/consignments/customer-operation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cashierToken}`,
          },
          body: JSON.stringify({
            customerId: client.id,
            packagingTypeId: cratePkg.id,
            quantity: 10,
            operation: 'SALE_DEPOSIT',
          }),
        }
      );
      expect(depositRes.status).toBe(201);

      const returnRes = await fetch(`http://127.0.0.1:${port}/api/consignments/customer-return`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`,
        },
        body: JSON.stringify({
          customerId: client.id,
          packagingTypeId: cratePkg.id,
          quantity: 6,
          refundCustomer: false,
        }),
      });
      expect(returnRes.status).toBe(201);
      const returnBody = (await returnRes.json()) as { remainingCustomerQty: number };
      expect(returnBody.remainingCustomerQty).toBe(4);
    } finally {
      server.close();
    }
  });
});
