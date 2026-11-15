import { Router } from 'express';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { ReportsRepository, type ReportDataset } from '../repositories/reportsRepo.ts';
import { type AuthenticatedRequest, requirePermission } from '../security/authMiddleware.ts';

const ALLOWED_DATASETS: ReadonlySet<string> = new Set([
  'margins',
  'sales',
  'receivables',
  'payables',
  'expenses',
  'consignments',
]);

export function createReportsRouter(
  reportsRepo: ReportsRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requireReportsView = requirePermission(authRepo, 'reports.view');

  router.get('/overview', requireReportsView, (req, res, next) => {
    try {
      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;
      res.json(reportsRepo.getOverviewReport({ startDate, endDate }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/product-margins', requireReportsView, (req, res, next) => {
    try {
      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;
      res.json(reportsRepo.getProductMargins({ startDate, endDate }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/snapshot', requireReportsView, (_req, res) => {
    res.json(reportsRepo.getSnapshot());
  });

  router.get('/daily', requireReportsView, (req, res, next) => {
    try {
      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;
      res.json(reportsRepo.getDailySeries({ startDate, endDate }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/export/:format', requireReportsView, (req: AuthenticatedRequest, res, next) => {
    try {
      const format = req.params.format === 'pdf' ? 'pdf' : req.params.format === 'csv' ? 'csv' : null;
      if (!format) {
        throw new AppError('VALIDATION_ERROR', 'Format d’export non supporté (csv ou pdf).', 400);
      }

      const datasetRaw = typeof req.query.dataset === 'string' ? req.query.dataset : 'margins';
      if (!ALLOWED_DATASETS.has(datasetRaw)) {
        throw new AppError('VALIDATION_ERROR', `Jeu de données inconnu : ${datasetRaw}`, 400);
      }

      const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined;

      const file = reportsRepo.exportDataset(req.authUser!.id, {
        dataset: datasetRaw as ReportDataset,
        format,
        startDate,
        endDate,
      });

      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.send(file.buffer);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
