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
import { ConsignmentRepository } from '../server/repositories/consignmentRepo.ts';
import { CustomerRepository } from '../server/repositories/customerRepo.ts';
import { FinanceRepository } from '../server/repositories/financeRepo.ts';
import { PosRepository } from '../server/repositories/posRepo.ts';
import { StockRepository } from '../server/repositories/stockRepo.ts';
import { createFinanceRouter } from '../server/routes/finance.ts';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-lot7-'));
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

describe('LOT 7 — Finances, Caisse, Dépenses, Écarts & Réconciliation multi-canaux', () => {
  it('Scénarios K & L : Ouverture caisse, flux mixtes (POS + créance + dépense + consigne + mouvement manuel), clôture avec écart, réconciliation & rectification propriétaire', () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);

    const authRepo = new AuthRepository(db);
    const catalogRepo = new CatalogRepository(db);
    const stockRepo = new StockRepository(db);
    const customerRepo = new CustomerRepository(db);
    const posRepo = new PosRepository(db, authRepo);
    const consignmentRepo = new ConsignmentRepository(db);
    const financeRepo = new FinanceRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt Abobo',
      ownerFullName: 'Coulibaly Issa',
      username: 'patron',
      password: 'Password2026!',
    });

    const cratePkg = catalogRepo.createPackagingType(owner.user.id, {
      code: 'CAS-24',
      name: 'Casier 24 alvéoles',
      kind: 'CRATE',
      depositAmountXof: 1600,
    });

    const prod = catalogRepo.createProduct(owner.user.id, {
      sku: 'BEAUFORT-50',
      name: 'Beaufort Lager 50cl',
      baseUnitId: 'unit-bottle',
      cratePackagingTypeId: cratePkg.id,
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
          wholesalePriceXof: 10000,
          retailPriceXof: 12000,
          isDefaultSaleUnit: true,
        },
      ],
    });

    stockRepo.recordMovement(owner.user.id, {
      productId: prod.id,
      unitId: 'unit-crate',
      quantity: 20,
      movementType: 'INITIAL',
      unitCostXof: 9600,
    });

    const client = customerRepo.createCustomer(owner.user.id, {
      fullName: 'Bar Le Carrefour',
      customerType: 'DETAILLANT',
      creditLimitXof: 100000,
      dueDays: 15,
    });

    // 1) Ouverture de session sur reg-main avec 50 000 FCFA
    const session = financeRepo.openSession(owner.user.id, {
      cashRegisterId: 'reg-main',
      openingBalanceXof: 50000,
      notes: 'Ouverture matin',
    });
    expect(session.status).toBe('OPEN');
    expect(session.theoreticalClosingXof).toBe(50000);

    // Impossible d'ouvrir une deuxième session simultanément
    expect(() =>
      financeRepo.openSession(owner.user.id, {
        cashRegisterId: 'reg-main',
        openingBalanceXof: 10000,
      })
    ).toThrow(/déjà ouverte/);

    // 2) Vente POS mixte : 3 casiers + consigne (30 000 + 4 800 = 34 800 FCFA)
    // Payé : 15 000 Espèces + 6 350 Wave = 21 350 FCFA ; Crédit = 13 450 FCFA
    posRepo.createSale(owner.user.id, {
      idempotencyKey: 'idem-lot7-sale-1',
      customerId: client.id,
      priceTier: 'WHOLESALE',
      items: [{ productId: prod.id, unitId: 'unit-crate', quantity: 3, applyConsignment: true }],
      payments: [
        { paymentMethod: 'CASH', amountXof: 15000 },
        { paymentMethod: 'WAVE', amountXof: 6350, externalReference: 'WV-7701' },
      ],
    });

    // 3) Recouvrement créance en espèces : +10 000 FCFA CASH
    customerRepo.recordCustomerDebtPayment(owner.user.id, {
      customerId: client.id,
      paymentMethod: 'CASH',
      amountXof: 10000,
    });

    // 4) Dépenses : 12 000 FCFA CASH (transport) + 8 000 FCFA ORANGE_MONEY (facture)
    financeRepo.recordExpense(owner.user.id, {
      categoryId: 'exp-transport',
      amountXof: 12000,
      paymentMethod: 'CASH',
      description: 'Carburant livraison matin',
      receiptReference: 'CARB-001',
    });
    financeRepo.recordExpense(owner.user.id, {
      categoryId: 'exp-utilities',
      amountXof: 8000,
      paymentMethod: 'ORANGE_MONEY',
      description: 'Recharge internet dépôt',
      receiptReference: 'OM-CIE-02',
    });

    // 5) Retour consigne 2 casiers remboursé en espèces : -3 200 FCFA CASH
    consignmentRepo.recordCustomerReturn(owner.user.id, {
      customerId: client.id,
      packagingTypeId: cratePkg.id,
      quantity: 2,
      refundCustomer: true,
      paymentMethod: 'CASH',
    });

    // 6) Mouvements manuels : +20 000 apport, -5 000 prélèvement
    financeRepo.recordManualMovement(owner.user.id, {
      cashSessionId: session.id,
      direction: 'IN',
      amountXof: 20000,
      description: 'Appoint petite monnaie',
    });
    financeRepo.recordManualMovement(owner.user.id, {
      cashSessionId: session.id,
      direction: 'OUT',
      amountXof: 5000,
      description: 'Mise au coffre intermédiaire',
    });

    // Calcul attendu en caisse : 50000 + 15000 + 10000 - 12000 - 3200 + 20000 - 5000 = 74 800 FCFA
    const live = financeRepo.getSessionById(session.id);
    expect(live.theoreticalClosingXof).toBe(74800);
    expect(live.cashInXof).toBe(15000 + 10000 + 20000);
    expect(live.cashOutXof).toBe(12000 + 3200 + 5000);

    // Retrait manuel supérieur au solde refusé (409)
    expect(() =>
      financeRepo.recordManualMovement(owner.user.id, {
        cashSessionId: session.id,
        direction: 'OUT',
        amountXof: 90000,
        description: 'Retrait excessif',
      })
    ).toThrow(/Solde espèces théorique insuffisant/);

    // Vérifier rapprochement multi-canaux de la session
    const waveChannel = live.channels.find((c) => c.paymentMethod === 'WAVE')!;
    expect(waveChannel.inboundXof).toBe(6350);
    expect(waveChannel.netXof).toBe(6350);

    const omChannel = live.channels.find((c) => c.paymentMethod === 'ORANGE_MONEY')!;
    expect(omChannel.expensesXof).toBe(8000);
    expect(omChannel.netXof).toBe(-8000);

    // 7) Scénarios K & L : Clôture avec comptage 72 800 FCFA -> écart -2 000 FCFA (manquant)
    const closed = financeRepo.closeSession(owner.user.id, session.id, {
      declaredClosingXof: 72800,
      notes: 'Manquant 2000 FCFA constaté',
    });
    expect(closed.status).toBe('CLOSED');
    expect(closed.theoreticalClosingXof).toBe(74800);
    expect(closed.declaredClosingXof).toBe(72800);
    expect(closed.varianceXof).toBe(-2000);

    const detail = financeRepo.getSessionDetail(session.id);
    const closingAdj = detail.movements.find((m) => m.movementType === 'CLOSING_ADJUSTMENT');
    expect(closingAdj?.amountSignedXof).toBe(-2000);

    // Overview global : cumul écarts = -2000, dépenses = 20000
    const overview = financeRepo.getOverview();
    expect(overview.activeSession).toBeNull();
    expect(overview.closedSessionsCount).toBe(1);
    expect(overview.cumulativeVarianceXof).toBe(-2000);
    expect(overview.totalExpensesXof).toBe(20000);

    // 8) Rectification administrative par le propriétaire -> billet retrouvé -> écart ramené à 0
    const overridden = financeRepo.overrideClosedSession(owner.user.id, session.id, {
      correctedDeclaredXof: 74800,
      justification: 'Billet de 2 000 FCFA retrouvé sous le tiroir',
    });
    expect(overridden.declaredClosingXof).toBe(74800);
    expect(overridden.varianceXof).toBe(0);
    expect(financeRepo.getOverview().cumulativeVarianceXof).toBe(0);
  });

  it('RBAC HTTP Finances : 401 sans session, Caissier ouvre/clôture mais 403 sur dépense/override, Gérant crée dépense mais 403 sur override', async () => {
    const dbPath = createTempDbPath();
    const { db } = initLocalSqlite(dbPath);
    const authRepo = new AuthRepository(db);
    const financeRepo = new FinanceRepository(db);

    const owner = authRepo.initializeDepotAndOwner({
      depotName: 'Dépôt RBAC Finance',
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

    const ownerToken = authRepo.login('patron', 'Password2026!').token;
    const managerToken = authRepo.login('gerant', 'Password2026!').token;
    const cashierToken = authRepo.login('caissier', 'Password2026!').token;
    const warehouseToken = authRepo.login('magasinier', 'Password2026!').token;

    const app = express();
    app.use(express.json());
    app.use('/api/finance', createFinanceRouter(financeRepo, authRepo));
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
      // 1) Sans jeton -> 401
      const unauth = await fetch(`http://127.0.0.1:${port}/api/finance/overview`);
      expect(unauth.status).toBe(401);

      // 2) Magasinier ne peut pas ouvrir de caisse -> 403
      const magOpen = await fetch(`http://127.0.0.1:${port}/api/finance/sessions/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${warehouseToken}`,
        },
        body: JSON.stringify({ cashRegisterId: 'reg-main', openingBalanceXof: 20000 }),
      });
      expect(magOpen.status).toBe(403);

      // 3) Caissier ouvre la caisse -> 201
      const cashierOpen = await fetch(`http://127.0.0.1:${port}/api/finance/sessions/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`,
        },
        body: JSON.stringify({ cashRegisterId: 'reg-main', openingBalanceXof: 30000 }),
      });
      expect(cashierOpen.status).toBe(201);
      const opened = (await cashierOpen.json()) as { id: string };

      // 4) Caissier n'a pas expense.write -> 403
      const cashierExp = await fetch(`http://127.0.0.1:${port}/api/finance/expenses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`,
        },
        body: JSON.stringify({
          categoryId: 'exp-other',
          amountXof: 2000,
          paymentMethod: 'CASH',
          description: 'Frais divers',
        }),
      });
      expect(cashierExp.status).toBe(403);

      // 5) Gérant possède expense.write -> 201
      const managerExp = await fetch(`http://127.0.0.1:${port}/api/finance/expenses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerToken}`,
        },
        body: JSON.stringify({
          categoryId: 'exp-transport',
          amountXof: 5000,
          paymentMethod: 'CASH',
          description: 'Carburant coursier',
        }),
      });
      expect(managerExp.status).toBe(201);

      // 6) Caissier clôture sa session (théorique = 25 000, déclaré = 24 500 -> écart -500)
      const cashierClose = await fetch(
        `http://127.0.0.1:${port}/api/finance/sessions/${opened.id}/close`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cashierToken}`,
          },
          body: JSON.stringify({ declaredClosingXof: 24500 }),
        }
      );
      expect(cashierClose.status).toBe(200);

      // 7) Gérant n'a pas cash.session.override -> 403
      const managerOverride = await fetch(
        `http://127.0.0.1:${port}/api/finance/sessions/${opened.id}/override`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${managerToken}`,
          },
          body: JSON.stringify({
            correctedDeclaredXof: 25000,
            justification: 'Tentative gérant',
          }),
        }
      );
      expect(managerOverride.status).toBe(403);

      // 8) Propriétaire possède cash.session.override -> 200
      const ownerOverride = await fetch(
        `http://127.0.0.1:${port}/api/finance/sessions/${opened.id}/override`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerToken}`,
          },
          body: JSON.stringify({
            correctedDeclaredXof: 25000,
            justification: 'Pièce de 500 FCFA retrouvée lors du contrôle',
          }),
        }
      );
      expect(ownerOverride.status).toBe(200);
      const corrected = (await ownerOverride.json()) as { varianceXof: number };
      expect(corrected.varianceXof).toBe(0);
    } finally {
      server.close();
    }
  });
});
