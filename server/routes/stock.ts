import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { StockRepository } from '../repositories/stockRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const movementSchema = z.object({
  productId: z.string().min(1, 'Produit requis'),
  unitId: z.string().min(1, 'Unité requise'),
  quantity: z.number().int('Quantité entière requise').min(1, 'Quantité minimale = 1'),
  movementType: z.enum(['INITIAL', 'MANUAL_IN', 'MANUAL_OUT', 'BREAKAGE', 'LOSS']),
  unitCostXof: z.number().int('Coût entier FCFA requis').min(0).optional(),
  note: z.string().trim().max(240).optional(),
});

const validateInventorySchema = z.object({
  note: z.string().trim().max(240).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        countedBase: z.number().int().min(0),
      })
    )
    .min(1, 'Au moins un article compté est requis'),
});

export function createStockRouter(
  stockRepo: StockRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requireStockAdjust = requirePermission(authRepo, 'stock.adjust');

  router.get('/balances', requireAuth(authRepo), (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const onlyLowStock = req.query.onlyLowStock === 'true';
    res.json(stockRepo.listStockBalances({ search, onlyLowStock }));
  });

  router.get('/movements', requireAuth(authRepo), (req, res) => {
    const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;
    const movementType =
      typeof req.query.movementType === 'string' ? req.query.movementType : undefined;
    const limit = Number(req.query.limit ?? 100);
    res.json(
      stockRepo.listMovements({
        productId,
        movementType,
        limit: Number.isFinite(limit) ? limit : 100,
      })
    );
  });

  router.post('/movements', requireStockAdjust, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = movementSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Mouvement de stock invalide',
          400
        );
      }
      const created = stockRepo.recordMovement(req.authUser!.id, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.get('/inventories', requireAuth(authRepo), (_req, res) => {
    res.json(stockRepo.listInventories());
  });

  router.post('/inventories', requireStockAdjust, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = validateInventorySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Inventaire invalide',
          400
        );
      }
      const created = stockRepo.validateInventory(
        req.authUser!.id,
        parsed.data.lines,
        parsed.data.note
      );
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
