import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { SettingsRepository } from '../repositories/settingsRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const updateSettingsSchema = z.object({
  depotName: z.string().trim().min(2, 'Nom du dépôt requis').max(120),
  ownerName: z.string().trim().min(2, 'Nom du propriétaire requis').max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(240).nullable().optional(),
  logoPath: z.string().max(700_000).nullable().optional(),
  receiptHeader: z.string().trim().max(240).nullable().optional(),
  receiptFooter: z.string().trim().max(240).nullable().optional(),
  defaultConsignmentPolicy: z.enum(['SEPARATE_TRACKING', 'AUTO_INCLUDE_CRATES']),
  allowNegativeStock: z.boolean(),
  defaultCashFloatXof: z.number().int().min(0, 'Fonds de caisse positif ou nul requis'),
  receiptPrintWidth: z.enum(['58mm', '80mm']),
});

export function createSettingsRouter(
  settingsRepo: SettingsRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();

  router.get('/', requireAuth(authRepo), (_req, res, next) => {
    try {
      res.json(settingsRepo.getSettings());
    } catch (err) {
      next(err);
    }
  });

  router.put(
    '/',
    requirePermission(authRepo, 'settings.depot.manage'),
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = updateSettingsSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Paramètres invalides',
            400
          );
        }
        const updated = settingsRepo.updateSettings(req.authUser!.id, parsed.data);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
