import express from 'express';
import path from 'node:path';
import { initLocalSqlite } from './server/db/sqlite.ts';
import { keyHex, loadOrCreateKey } from './server/security/keys.ts';
import { AppError } from './server/error.ts';
import { AuthRepository } from './server/repositories/authRepo.ts';
import { BackupRepository } from './server/repositories/backupRepo.ts';
import { CatalogRepository } from './server/repositories/catalogRepo.ts';
import { ConsignmentRepository } from './server/repositories/consignmentRepo.ts';
import { CustomerRepository } from './server/repositories/customerRepo.ts';
import { FinanceRepository } from './server/repositories/financeRepo.ts';
import { PosRepository } from './server/repositories/posRepo.ts';
import { PurchaseRepository } from './server/repositories/purchaseRepo.ts';
import { ReliabilityRepository } from './server/repositories/reliabilityRepo.ts';
import { ReportsRepository } from './server/repositories/reportsRepo.ts';
import { SettingsRepository } from './server/repositories/settingsRepo.ts';
import { StockRepository } from './server/repositories/stockRepo.ts';
import { SupplierRepository } from './server/repositories/supplierRepo.ts';
import { SystemRepository } from './server/repositories/systemRepo.ts';
import { createAuthRouter } from './server/routes/auth.ts';
import { createBackupsRouter } from './server/routes/backups.ts';
import { createCatalogRouter } from './server/routes/catalog.ts';
import { createConsignmentsRouter } from './server/routes/consignments.ts';
import { createCustomersRouter } from './server/routes/customers.ts';
import { createFinanceRouter } from './server/routes/finance.ts';
import { createPosRouter } from './server/routes/pos.ts';
import { createPurchasesRouter } from './server/routes/purchases.ts';
import { createReportsRouter } from './server/routes/reports.ts';
import { createSettingsRouter } from './server/routes/settings.ts';
import { createStockRouter } from './server/routes/stock.ts';
import { desktopCors } from './server/security/desktopCors.ts';
import { createSuppliersRouter } from './server/routes/suppliers.ts';
import { createSystemRouter } from './server/routes/system.ts';

async function bootstrapServer() {
  // LOT 10 — Serveur de référence WEB / PREVIEW uniquement.
  // La coquille Tauri n'appelle plus ce processus : 95/95 commandes passent par
  // Tauri IPC et aucun sidecar n'est embarqué. Le preview de développement
  // reste sur 0.0.0.0, ou sur la valeur explicite DEPOTPRO_BIND.
  const PORT = Number.parseInt(process.env.DEPOTPRO_PORT ?? '3000', 10) || 3000;
  const BIND_HOST =
    process.env.DEPOTPRO_BIND ??
    (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');
  const app = express();
  // LOT 10 — CORS du preview web / recette : origines locales et proxifiées
  // uniquement. Monté AVANT les routeurs ; le desktop n'utilise plus ce chemin.
  app.use(desktopCors());
  app.use(express.json({ limit: '2mb' }));

  const { db, dbPath, restoreApplied, encryption } = initLocalSqlite();
  const encryptionHealth = {
    encrypted: encryption.encrypted,
    keyStorage: encryption.storage?.backend ?? ('none' as const),
    note: encryption.storage?.reason ?? null,
  };
  const migrationsDir = process.env.DEPOTPRO_MIGRATIONS_DIR
    ? path.resolve(process.env.DEPOTPRO_MIGRATIONS_DIR)
    : path.resolve(process.cwd(), 'migrations');
  // LOT 11.6 — la clé SQLCipher sert aussi aux sauvegardes (chiffrées elles
  // aussi) : sans elle, la vérification d'une sauvegarde saine échouerait.
  const databaseKeyOption = encryption.encrypted
    ? { hex: keyHex(loadOrCreateKey(path.dirname(dbPath), 'database', { create: false }).key!) }
    : null;
  const systemRepo = new SystemRepository(db, dbPath, encryptionHealth);
  const authRepo = new AuthRepository(db);
  const backupRepo = new BackupRepository(db, dbPath, {
    migrationsDir,
    databaseKey: databaseKeyOption,
  });
  const reliabilityRepo = new ReliabilityRepository(db, { migrationsDir });

  // Trace la restauration effectivement appliquée au démarrage (LOT 9).
  if (restoreApplied) {
    backupRepo.recordRestoreApplied(restoreApplied);
  }
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

  // LOT 9 — Sécurité : les réponses API ne sont jamais mises en cache par un
  // intermédiaire (données commerciales locales) et le type MIME est verrouillé.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Routes spécifiques montées avant le routeur système générique.
  app.use('/api/system/backups', createBackupsRouter(backupRepo, reliabilityRepo, authRepo));

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
      // Erreurs de transport (body trop volumineux, JSON invalide) : réponse
      // structurée plutôt qu'un message brut ou un 500 trompeur.
      if (
        err &&
        typeof err === 'object' &&
        'type' in err &&
        (err as { type?: string }).type === 'entity.too.large'
      ) {
        res.status(413).json({
          code: 'VALIDATION_ERROR',
          message: 'Fichier trop volumineux pour être importé (limite 256 Mo).',
        });
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
    const distPath = process.env.DEPOTPRO_FRONTEND_DIST
      ? path.resolve(process.env.DEPOTPRO_FRONTEND_DIST)
      : path.resolve(process.cwd(), 'dist');
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

  // LOT 9 — Sauvegarde automatique locale, sans réseau ni service externe.
  // Premier contrôle peu après le démarrage, puis toutes les 15 minutes ;
  // le dépôt décide lui-même si l'intervalle configuré est écoulé.
  const autoBackupTick = () => {
    try {
      backupRepo.runAutoBackupIfDue();
    } catch (err) {
      console.error('Sauvegarde automatique LOT 9 ignorée :', err);
    }
  };
  const startupTimer = setTimeout(autoBackupTick, 5_000);
  startupTimer.unref();
  const autoBackupTimer = setInterval(autoBackupTick, 15 * 60 * 1000);
  autoBackupTimer.unref();

  app.listen(PORT, BIND_HOST, () => {
    console.log(
      `DepotPro CI actif sur http://${BIND_HOST}:${PORT} (SQLite: ${dbPath}, mode: ${process.env.NODE_ENV ?? 'development'})`
    );
  });
}

bootstrapServer().catch((err) => {
  console.error('Échec critique du démarrage DepotPro CI :', err);
  process.exit(1);
});
