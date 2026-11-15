import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { PurchaseRepository } from '../repositories/purchaseRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const createOrderSchema = z.object({
  supplierId: z.string().min(1, 'Fournisseur requis'),
  validateImmediately: z.boolean().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1, 'Produit requis'),
        unitId: z.string().min(1, 'Unité requise'),
        orderedQty: z.number().int('Quantité entière requise').min(1),
        unitCostXof: z.number().int('Montant entier FCFA requis').min(0),
      })
    )
    .min(1, 'Ajoutez au moins un article à la commande'),
});

const cancelOrderSchema = z.object({
  reason: z.string().trim().max(240).optional(),
});

const receiveOrderSchema = z.object({
  supplierInvoiceRef: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  items: z
    .array(
      z.object({
        purchaseItemId: z.string().min(1),
        receivedQty: z.number().int('Quantité entière requise').min(0),
      })
    )
    .min(1, 'Au moins une ligne est requise'),
});

const supplierPaymentSchema = z.object({
  supplierId: z.string().min(1, 'Fournisseur requis'),
  purchaseOrderId: z.string().trim().nullable().optional(),
  paymentMethod: z.enum([
    'CASH',
    'ORANGE_MONEY',
    'MTN_MOMO',
    'MOOV_MONEY',
    'WAVE',
    'BANK_TRANSFER',
  ]),
  amountXof: z.number().int('Montant entier FCFA requis').min(1, 'Montant > 0 requis'),
  externalReference: z.string().trim().max(100).nullable().optional(),
});

const supplierReturnSchema = z.object({
  purchaseOrderId: z.string().min(1, 'Commande requise'),
  productId: z.string().min(1, 'Produit requis'),
  unitId: z.string().min(1, 'Unité requise'),
  quantity: z.number().int('Quantité entière requise').min(1),
  note: z.string().trim().max(240).nullable().optional(),
});

export function createPurchasesRouter(
  purchaseRepo: PurchaseRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requirePurchaseManage = requirePermission(authRepo, 'purchase.manage');

  router.get('/orders', requireAuth(authRepo), (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const supplierId =
      typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(purchaseRepo.listPurchaseOrders({ search, supplierId, status }));
  });

  router.post('/orders', requirePurchaseManage, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Commande fournisseur invalide',
          400
        );
      }
      const created = purchaseRepo.createPurchaseOrder(req.authUser!.id, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/orders/:id/validate',
    requirePurchaseManage,
    (req: AuthenticatedRequest, res, next) => {
      try {
        res.json(purchaseRepo.validatePurchaseOrder(req.authUser!.id, String(req.params.id)));
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/orders/:id/cancel',
    requirePurchaseManage,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = cancelOrderSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw new AppError('VALIDATION_ERROR', 'Motif invalide', 400);
        }
        res.json(
          purchaseRepo.cancelPurchaseOrder(
            req.authUser!.id,
            String(req.params.id),
            parsed.data.reason
          )
        );
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/orders/:id/receive',
    requirePurchaseManage,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = receiveOrderSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Réception invalide',
            400
          );
        }
        const receipt = purchaseRepo.receivePurchaseOrder(
          req.authUser!.id,
          String(req.params.id),
          parsed.data
        );
        res.status(201).json(receipt);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get('/receipts', requireAuth(authRepo), (req, res) => {
    const purchaseOrderId =
      typeof req.query.purchaseOrderId === 'string' ? req.query.purchaseOrderId : undefined;
    const supplierId =
      typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
    res.json(purchaseRepo.listGoodsReceipts({ purchaseOrderId, supplierId }));
  });

  router.get('/payments', requireAuth(authRepo), (req, res) => {
    const supplierId =
      typeof req.query.supplierId === 'string' ? req.query.supplierId : undefined;
    const purchaseOrderId =
      typeof req.query.purchaseOrderId === 'string' ? req.query.purchaseOrderId : undefined;
    res.json(purchaseRepo.listSupplierPayments({ supplierId, purchaseOrderId }));
  });

  router.post('/payments', requirePurchaseManage, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = supplierPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Règlement invalide',
          400
        );
      }
      const created = purchaseRepo.recordSupplierPayment(req.authUser!.id, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.post('/returns', requirePurchaseManage, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = supplierReturnSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Retour fournisseur invalide',
          400
        );
      }
      const created = purchaseRepo.recordSupplierReturn(req.authUser!.id, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
