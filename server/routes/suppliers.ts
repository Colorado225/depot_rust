import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { SupplierRepository } from '../repositories/supplierRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const saveSupplierSchema = z.object({
  name: z.string().trim().min(2, 'Nom du fournisseur requis').max(120),
  supplierType: z.enum(['BRASSERIE', 'DISTRIBUTEUR', 'IMPORTATEUR', 'AUTRE']),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  address: z.string().trim().max(240).nullable().optional(),
  taxId: z.string().trim().max(60).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365),
  notes: z.string().trim().max(400).nullable().optional(),
});

const toggleActiveSchema = z.object({
  isActive: z.boolean(),
});

export function createSuppliersRouter(
  supplierRepo: SupplierRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requirePurchaseManage = requirePermission(authRepo, 'purchase.manage');

  router.get('/', requireAuth(authRepo), (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const includeInactive = req.query.includeInactive === 'true';
    res.json(supplierRepo.listSuppliers({ search, includeInactive }));
  });

  router.post('/', requirePurchaseManage, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = saveSupplierSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Données fournisseur invalides',
          400
        );
      }
      res.status(201).json(supplierRepo.createSupplier(req.authUser!.id, parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', requirePurchaseManage, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = saveSupplierSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Données fournisseur invalides',
          400
        );
      }
      res.json(
        supplierRepo.updateSupplier(req.authUser!.id, String(req.params.id), parsed.data)
      );
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/active', requirePurchaseManage, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = toggleActiveSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Statut invalide', 400);
      }
      res.json(
        supplierRepo.toggleSupplierActive(
          req.authUser!.id,
          String(req.params.id),
          parsed.data.isActive
        )
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
