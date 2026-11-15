import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { PosRepository } from '../repositories/posRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const createSaleSchema = z.object({
  idempotencyKey: z.string().trim().min(8, 'Clé d’idempotence requise'),
  customerId: z.string().trim().nullable().optional(),
  priceTier: z.enum(['WHOLESALE', 'RETAIL']),
  discountXof: z.number().int('Remise entière FCFA requise').min(0).optional(),
  note: z.string().trim().max(300).nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        unitId: z.string().min(1),
        quantity: z.number().int('Quantité entière requise').min(1),
        applyConsignment: z.boolean().optional(),
      })
    )
    .min(1, 'Ajoutez au moins un produit au panier'),
  payments: z
    .array(
      z.object({
        paymentMethod: z.enum([
          'CASH',
          'ORANGE_MONEY',
          'MTN_MOMO',
          'MOOV_MONEY',
          'WAVE',
          'BANK_TRANSFER',
        ]),
        amountXof: z.number().int('Montant entier FCFA requis').min(1),
        externalReference: z.string().trim().max(100).nullable().optional(),
      })
    )
    .default([]),
});

const cancelSaleSchema = z.object({
  reason: z.string().trim().min(3, 'Motif d’annulation requis (min. 3 caractères)').max(240),
});

export function createPosRouter(posRepo: PosRepository, authRepo: AuthRepository): Router {
  const router = Router();
  const requirePosCreate = requirePermission(authRepo, 'pos.sale.create');
  const requirePosCancel = requirePermission(authRepo, 'pos.sale.cancel');

  router.get('/sales', requireAuth(authRepo), (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const customerId =
      typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const priceTier =
      typeof req.query.priceTier === 'string' ? req.query.priceTier : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(posRepo.listSales({ search, customerId, status, priceTier, limit }));
  });

  router.get('/sales/:id', requireAuth(authRepo), (req, res, next) => {
    try {
      res.json(posRepo.getSaleById(String(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/sales', requirePosCreate, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = createSaleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Panier de vente invalide',
          400
        );
      }
      const created = posRepo.createSale(req.authUser!.id, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.post('/sales/:id/cancel', requirePosCancel, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = cancelSaleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Motif d’annulation requis',
          400
        );
      }
      const cancelled = posRepo.cancelSale(
        req.authUser!.id,
        String(req.params.id),
        parsed.data.reason
      );
      res.json(cancelled);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
