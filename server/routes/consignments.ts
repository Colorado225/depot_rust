import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import {
  ConsignmentRepository,
  type ConsignmentHolderType,
  type ConsignmentMovementType,
} from '../repositories/consignmentRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const customerReturnSchema = z.object({
  customerId: z.string().min(1, 'Client requis'),
  packagingTypeId: z.string().min(1, 'Type emballage requis'),
  quantity: z.number().int('Quantité entière requise').min(1),
  refundCustomer: z.boolean().default(false),
  paymentMethod: z
    .enum(['CASH', 'ORANGE_MONEY', 'MTN_MOMO', 'MOOV_MONEY', 'WAVE', 'BANK_TRANSFER'])
    .optional(),
  externalReference: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().max(240).nullable().optional(),
});

const customerOpSchema = z.object({
  customerId: z.string().min(1, 'Client requis'),
  packagingTypeId: z.string().min(1, 'Type emballage requis'),
  quantity: z.number().int().min(1),
  operation: z.enum(['SALE_DEPOSIT', 'EXCHANGE', 'BREAKAGE', 'LOSS']),
  note: z.string().trim().max(240).nullable().optional(),
});

const supplierOpSchema = z.object({
  supplierId: z.string().min(1, 'Fournisseur requis'),
  packagingTypeId: z.string().min(1, 'Type emballage requis'),
  quantity: z.number().int().min(1),
  operation: z.enum(['SUPPLIER_DEPOSIT', 'SUPPLIER_RETURN']),
  note: z.string().trim().max(240).nullable().optional(),
});

const depotOpSchema = z.object({
  packagingTypeId: z.string().min(1, 'Type emballage requis'),
  quantity: z.number().int().min(1),
  operation: z.enum(['EXCHANGE', 'BREAKAGE', 'LOSS']),
  note: z.string().trim().max(240).nullable().optional(),
});

export function createConsignmentsRouter(
  consignmentRepo: ConsignmentRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requireConsignmentManage = requirePermission(authRepo, 'consignment.manage');

  router.get('/summary', requireAuth(authRepo), (_req, res) => {
    res.json(consignmentRepo.getSummary());
  });

  router.get('/balances', requireAuth(authRepo), (req, res) => {
    const holderType =
      typeof req.query.holderType === 'string'
        ? (req.query.holderType as ConsignmentHolderType)
        : undefined;
    const holderId = typeof req.query.holderId === 'string' ? req.query.holderId : undefined;
    const kind =
      typeof req.query.kind === 'string'
        ? (req.query.kind as 'BOTTLE' | 'CRATE' | 'OTHER')
        : undefined;
    const onlyNonZero = req.query.onlyNonZero === 'true';
    res.json(consignmentRepo.listBalances({ holderType, holderId, kind, onlyNonZero }));
  });

  router.get('/movements', requireAuth(authRepo), (req, res) => {
    const holderType =
      typeof req.query.holderType === 'string'
        ? (req.query.holderType as ConsignmentHolderType)
        : undefined;
    const holderId = typeof req.query.holderId === 'string' ? req.query.holderId : undefined;
    const packagingTypeId =
      typeof req.query.packagingTypeId === 'string' ? req.query.packagingTypeId : undefined;
    const movementType =
      typeof req.query.movementType === 'string'
        ? (req.query.movementType as ConsignmentMovementType)
        : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(
      consignmentRepo.listMovements({
        holderType,
        holderId,
        packagingTypeId,
        movementType,
        limit,
      })
    );
  });

  router.post(
    '/customer-return',
    requireConsignmentManage,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = customerReturnSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Retour consigne invalide',
            400
          );
        }
        const result = consignmentRepo.recordCustomerReturn(req.authUser!.id, parsed.data);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/customer-operation',
    requireConsignmentManage,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = customerOpSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Opération consigne client invalide',
            400
          );
        }
        const movement = consignmentRepo.recordCustomerOperation(req.authUser!.id, parsed.data);
        res.status(201).json(movement);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/supplier-operation',
    requireConsignmentManage,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = supplierOpSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Opération emballage fournisseur invalide',
            400
          );
        }
        const movement = consignmentRepo.recordSupplierOperation(req.authUser!.id, parsed.data);
        res.status(201).json(movement);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/depot-operation',
    requireConsignmentManage,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = depotOpSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Mouvement emballage dépôt invalide',
            400
          );
        }
        const movement = consignmentRepo.recordDepotOperation(req.authUser!.id, parsed.data);
        res.status(201).json(movement);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
