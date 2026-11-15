import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import type { PaymentMethod } from '../repositories/customerRepo.ts';
import { FinanceRepository } from '../repositories/financeRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const paymentMethodEnum = z.enum([
  'CASH',
  'ORANGE_MONEY',
  'MTN_MOMO',
  'MOOV_MONEY',
  'WAVE',
  'BANK_TRANSFER',
]);

const openSessionSchema = z.object({
  cashRegisterId: z.string().min(1, 'Caisse requise'),
  openingBalanceXof: z.number().int('Fond de caisse entier requis').min(0),
  notes: z.string().trim().max(240).nullable().optional(),
});

const closeSessionSchema = z.object({
  declaredClosingXof: z.number().int('Montant compté entier requis').min(0),
  notes: z.string().trim().max(300).nullable().optional(),
});

const manualMovementSchema = z.object({
  direction: z.enum(['IN', 'OUT']),
  amountXof: z.number().int('Montant entier requis').min(1),
  description: z.string().trim().min(3, 'Motif requis (min. 3 caractères)').max(200),
});

const overrideSessionSchema = z.object({
  correctedDeclaredXof: z.number().int('Montant entier requis').min(0),
  justification: z.string().trim().min(5, 'Justification administrative requise').max(300),
});

const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(2, 'Nom requis').max(80),
  description: z.string().trim().max(200).nullable().optional(),
});

const recordExpenseSchema = z.object({
  categoryId: z.string().min(1, 'Catégorie requise'),
  amountXof: z.number().int('Montant entier requis').min(1),
  paymentMethod: paymentMethodEnum,
  receiptReference: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().min(3, 'Description requise').max(240),
  expenseDate: z.string().trim().optional(),
});

export function createFinanceRouter(
  financeRepo: FinanceRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requireCashOperate = requirePermission(authRepo, 'cash.session.operate');
  const requireCashOverride = requirePermission(authRepo, 'cash.session.override');
  const requireExpenseWrite = requirePermission(authRepo, 'expense.write');

  router.get('/overview', requireAuth(authRepo), (_req, res) => {
    res.json(financeRepo.getOverview());
  });

  router.get('/registers', requireAuth(authRepo), (_req, res) => {
    res.json(financeRepo.listRegisters());
  });

  router.get('/sessions', requireAuth(authRepo), (req, res) => {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 30;
    res.json(financeRepo.listSessions(Number.isFinite(limit) ? limit : 30));
  });

  router.get('/sessions/:id', requireAuth(authRepo), (req, res, next) => {
    try {
      res.json(financeRepo.getSessionDetail(String(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/sessions/open', requireCashOperate, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = openSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Paramètres d’ouverture invalides',
          400
        );
      }
      const session = financeRepo.openSession(req.authUser!.id, parsed.data);
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/sessions/:id/manual-movement',
    requireCashOperate,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = manualMovementSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Mouvement de caisse invalide',
            400
          );
        }
        const session = financeRepo.recordManualMovement(req.authUser!.id, {
          cashSessionId: String(req.params.id),
          ...parsed.data,
        });
        res.status(201).json(session);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/sessions/:id/close',
    requireCashOperate,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = closeSessionSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Paramètres de clôture invalides',
            400
          );
        }
        const session = financeRepo.closeSession(
          req.authUser!.id,
          String(req.params.id),
          parsed.data
        );
        res.status(200).json(session);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/sessions/:id/override',
    requireCashOverride,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = overrideSessionSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Paramètres de rectification invalides',
            400
          );
        }
        const session = financeRepo.overrideClosedSession(
          req.authUser!.id,
          String(req.params.id),
          parsed.data
        );
        res.status(200).json(session);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get('/expense-categories', requireAuth(authRepo), (_req, res) => {
    res.json(financeRepo.listExpenseCategories());
  });

  router.post(
    '/expense-categories',
    requireExpenseWrite,
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = createExpenseCategorySchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Catégorie invalide',
            400
          );
        }
        const cat = financeRepo.createExpenseCategory(req.authUser!.id, parsed.data);
        res.status(201).json(cat);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get('/expenses', requireAuth(authRepo), (req, res) => {
    const categoryId =
      typeof req.query.categoryId === 'string' && req.query.categoryId
        ? req.query.categoryId
        : undefined;
    const paymentMethod =
      typeof req.query.paymentMethod === 'string' && req.query.paymentMethod
        ? (req.query.paymentMethod as PaymentMethod)
        : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(financeRepo.listExpenses({ categoryId, paymentMethod, limit }));
  });

  router.post('/expenses', requireExpenseWrite, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = recordExpenseSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Dépense invalide',
          400
        );
      }
      const created = financeRepo.recordExpense(req.authUser!.id, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.get('/payments', requireAuth(authRepo), (req, res) => {
    const paymentMethod =
      typeof req.query.paymentMethod === 'string' && req.query.paymentMethod
        ? (req.query.paymentMethod as PaymentMethod)
        : undefined;
    const direction =
      typeof req.query.direction === 'string' &&
      (req.query.direction === 'INBOUND' || req.query.direction === 'OUTBOUND')
        ? req.query.direction
        : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json(financeRepo.listTreasuryPayments({ paymentMethod, direction, limit }));
  });

  return router;
}
