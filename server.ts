import express from 'express';
import path from 'node:path';
import { initLocalSqlite } from './server/db/sqlite.ts';
import { AppError } from './server/error.ts';
import { AuthRepository } from './server/repositories/authRepo.ts';
import { CatalogRepository } from './server/repositories/catalogRepo.ts';
import { ConsignmentRepository } from './server/repositories/consignmentRepo.ts';
import { CustomerRepository } from './server/repositories/customerRepo.ts';
import { FinanceRepository } from './server/repositories/financeRepo.ts';
import { PosRepository } from './server/repositories/posRepo.ts';
import { PurchaseRepository } from './server/repositories/purchaseRepo.ts';
import { ReportsRepository } from './server/repositories/reportsRepo.ts';
import { SettingsRepository } from './server/repositories/settingsRepo.ts';
import { StockRepository } from './server/repositories/stockRepo.ts';
import { SupplierRepository } from './server/repositories/supplierRepo.ts';
import { SystemRepository } from './server/repositories/systemRepo.ts';
import { createAuthRouter } from './server/routes/auth.ts';
import { createCatalogRouter } from './server/routes/catalog.ts';
import { createConsignmentsRouter } from './server/routes/consignments.ts';
import { createCustomersRouter } from './server/routes/customers.ts';
import { createFinanceRouter } from './server/routes/finance.ts';
import { createPosRouter } from './server/routes/pos.ts';
import { createPurchasesRouter } from './server/routes/purchases.ts';
import { createReportsRouter } from './server/routes/reports.ts';
import { createSettingsRouter } from './server/routes/settings.ts';
import { createStockRouter } from './server/routes/stock.ts';
import { createSuppliersRouter } from './server/routes/suppliers.ts';
import { createSystemRouter } from './server/routes/system.ts';

async function bootstrapServer() {
  const PORT = 3000;
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const { db, dbPath } = initLocalSqlite();
  const systemRepo = new SystemRepository(db, dbPath);
  const authRepo = new AuthRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const catalogRepo = new CatalogRepository(db);
  const stockRepo = new StockRepository(db);
  const supplierRepo = new SupplierRepository(db);
  const purchaseRepo = new PurchaseRepository(db);
  const customerRepo = new CustomerRepository(db);
  const posRepo = new PosRepository(db, authRepo);
  const consignmentRepo = new ConsignmentRepository(db);
  const financeRepo = new FinanceRepository(db);
  const reportsRepo = new ReportsRepository(db);

  app.use('/api/auth', createAuthRouter(authRepo));
  app.use('/api/settings', createSettingsRouter(settingsRepo, authRepo));
  app.use('/api/catalog', createCatalogRouter(catalogRepo, authRepo));
  app.use('/api/stock', createStockRouter(stockRepo, authRepo));
  app.use('/api/suppliers', createSuppliersRouter(supplierRepo, authRepo));
  app.use('/api/purchases', createPurchasesRouter(purchaseRepo, authRepo));
  app.use('/api/customers', createCustomersRouter(customerRepo, authRepo));
  app.use('/api/pos', createPosRouter(posRepo, authRepo));
  app.use('/api/consignments', createConsignmentsRouter(consignmentRepo, authRepo));
  app.use('/api/finance', createFinanceRouter(financeRepo, authRepo));
  app.use('/api/reports', createReportsRouter(reportsRepo, authRepo));
  app.use('/api/system', createSystemRouter(systemRepo, authRepo));

  // API 404 handler (ne pas renvoyer index.html sur /api/*)
  app.use('/api', (_req, res) => {
    res.status(404).json({
      code: 'NOT_FOUND',
      message: 'Point de terminaison API introuvable.',
    });
  });

  // Gestion centralisée des erreurs backend
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
      const message = err instanceof Error ? err.message : 'Erreur interne du serveur';
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message,
      });
    }
  );

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DepotPro CI actif sur http://localhost:${PORT} (SQLite: ${dbPath})`);
  });
}

bootstrapServer().catch((err) => {
  console.error('Échec critique du démarrage DepotPro CI :', err);
  process.exit(1);
});
