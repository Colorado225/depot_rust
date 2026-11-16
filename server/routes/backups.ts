import express, { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { BackupRepository } from '../repositories/backupRepo.ts';
import { ReliabilityRepository } from '../repositories/reliabilityRepo.ts';
import { type AuthenticatedRequest, requirePermission } from '../security/authMiddleware.ts';

const configSchema = z.object({
  autoEnabled: z.boolean(),
  autoIntervalHours: z.number().int().min(1).max(720),
  retentionCount: z.number().int().min(1).max(365),
});

const createSchema = z.object({
  type: z.enum(['MANUAL', 'USB_EXPORT']).default('MANUAL'),
});

const restoreSchema = z.object({
  confirmation: z.literal('RESTAURER'),
  activateOnRestart: z.boolean().default(true),
});

function validationError(error: z.ZodError): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    error.issues[0]?.message ?? 'Paramètres invalides',
    400
  );
}

/** LOT 9 — Toutes les opérations exigent `backup.manage` (Propriétaire par défaut). */
export function createBackupsRouter(
  backupRepo: BackupRepository,
  reliabilityRepo: ReliabilityRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  router.use(requirePermission(authRepo, 'backup.manage'));

  router.get('/overview', (_req, res, next) => {
    try {
      res.json(backupRepo.getOverview());
    } catch (err) {
      next(err);
    }
  });

  router.put('/config', (req, res, next) => {
    try {
      const parsed = configSchema.safeParse(req.body);
      if (!parsed.success) throw validationError(parsed.error);
      res.json(backupRepo.updateConfig(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.post('/', (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw validationError(parsed.error);
      const entry = backupRepo.createBackup({
        type: parsed.data.type,
        userId: req.authUser!.id,
        reason: parsed.data.type === 'USB_EXPORT' ? 'Export pour support amovible' : 'Sauvegarde manuelle',
      });
      res.status(201).json(entry);
    } catch (err) {
      next(err);
    }
  });

  router.post('/auto/run', (_req, res, next) => {
    try {
      const entry = backupRepo.createBackup({
        type: 'AUTO',
        userId: null,
        reason: 'Déclenchement manuel de la sauvegarde automatique',
      });
      res.status(201).json(entry);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Import binaire d'un fichier .db provenant d'une clé USB ou d'un autre poste.
   * Le transport reste local (aucun service tiers). express.raw est monté ici
   * uniquement : le parseur JSON global ne consomme pas ce type de contenu.
   */
  router.post(
    '/import',
    express.raw({ type: () => true, limit: '256mb' }),
    (req: AuthenticatedRequest, res, next) => {
      try {
        const fileBuffer = Buffer.isBuffer(req.body) ? req.body : null;
        if (!fileBuffer || fileBuffer.length === 0) {
          throw new AppError('VALIDATION_ERROR', 'Aucun fichier .db reçu.', 400);
        }
        const rawName = req.headers['x-depotpro-filename'];
        const rawChecksum = req.headers['x-depotpro-source-checksum'];
        const entry = backupRepo.importExternalBackup({
          fileBuffer,
          originalName: typeof rawName === 'string' ? rawName : 'sauvegarde.db',
          expectedSha256: typeof rawChecksum === 'string' ? rawChecksum : null,
          userId: req.authUser!.id,
        });
        res.status(201).json(entry);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get('/diagnostics', (_req, res, next) => {
    try {
      res.json(reliabilityRepo.runDiagnostics());
    } catch (err) {
      next(err);
    }
  });

  router.post('/self-test', (_req, res, next) => {
    try {
      res.json(reliabilityRepo.runLot9SelfTests());
    } catch (err) {
      next(err);
    }
  });

  router.delete('/restore/pending', (req: AuthenticatedRequest, res, next) => {
    try {
      res.json({ cancelled: backupRepo.cancelRestore(req.authUser!.id) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/manifest', (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(backupRepo.getManifest(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/verify', (req: AuthenticatedRequest, res, next) => {
    try {
      res.json(backupRepo.verifyBackup(req.params.id, req.authUser!.id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/download', (req, res, next) => {
    try {
      const file = backupRepo.readBackupFile(req.params.id);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-DepotPro-SHA256', file.sha256Checksum);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.download(file.filePath, file.fileName, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/restore', (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = restoreSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw validationError(parsed.error);
      res.json(
        backupRepo.restoreBackup({
          backupId: req.params.id,
          confirmation: parsed.data.confirmation,
          activateOnRestart: parsed.data.activateOnRestart,
          userId: req.authUser!.id,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
