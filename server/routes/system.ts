import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { SystemRepository } from '../repositories/systemRepo.ts';
import { requirePermission } from '../security/authMiddleware.ts';

const activateLicenseSchema = z.object({
  licenseKey: z
    .string()
    .trim()
    .regex(/^DPCI-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/, 'Format attendu : DPCI-XXXX-XXXX'),
  depotNameBound: z.string().trim().min(2, 'Nom du dépôt requis (min. 2 caractères)').max(120),
});

export function createSystemRouter(
  repo: SystemRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requireAdminSettings = requirePermission(authRepo, 'settings.depot.manage');

  router.get('/health', (_req, res) => {
    res.json(repo.getHealth());
  });

  router.get('/migrations', requireAdminSettings, (_req, res) => {
    res.json(repo.getMigrations());
  });

  router.get('/decisions', requireAdminSettings, (_req, res) => {
    res.json(repo.getDecisions());
  });

  router.get('/license', requireAdminSettings, (_req, res) => {
    res.json(repo.getLicenseState());
  });

  router.post('/license/activate', requireAdminSettings, (req, res, next) => {
    try {
      const parsed = activateLicenseSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Paramètres de licence invalides',
          400
        );
      }
      const updated = repo.activateLocalLicense(parsed.data.licenseKey, parsed.data.depotNameBound);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.post('/license/reset-trial', requireAdminSettings, (_req, res, next) => {
    try {
      res.json(repo.resetTrialLicense());
    } catch (err) {
      next(err);
    }
  });

  router.post('/integrity-check', requireAdminSettings, (_req, res, next) => {
    try {
      res.json(repo.runIntegrityCheck());
    } catch (err) {
      next(err);
    }
  });

  router.post('/self-test', requireAdminSettings, (_req, res, next) => {
    try {
      res.json(repo.runFoundationSelfTests());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
