import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { CustomerRepository } from '../repositories/customerRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const saveCustomerSchema = z.object({
  fullName: z.string().trim().min(2, 'Nom du client requis (min. 2 caractères)').max(140),
  customerType: z.enum(['PARTICULIER', 'DETAILLANT', 'REVENDEUR', 'ENTREPRISE']),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  address: z.string().trim().max(240).nullable().optional(),
  creditLimitXof: z.number().int('Plafond entier FCFA requis').min(0),
  dueDays: z.number().int().min(0).max(365),
  notes: z.string().trim().max(300).nullable().optional(),
});

const toggleActiveSchema = z.object({
  isActive: z.boolean(),
});

const customerPaymentSchema = z.object({
  customerId: z.string().min(1, 'Client requis'),
  saleId: z.string().trim().nullable().optional(),
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

export function createCustomersRouter(
  customerRepo: CustomerRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requirePosSell = requirePermission(authRepo, 'pos.sale.create');

  router.get('/', requireAuth(authRepo), (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const customerType =
      typeof req.query.customerType === 'string' ? req.query.customerType : undefined;
    const onlyWithDebt = req.query.onlyWithDebt === 'true';
    const includeInactive = req.query.includeInactive === 'true';
    res.json(
      customerRepo.listCustomers({ search, customerType, onlyWithDebt, includeInactive })
    );
  });

  router.get('/:id/statement', requireAuth(authRepo), (req, res, next) => {
    try {
      res.json(customerRepo.getCustomerStatement(String(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/payments', requireAuth(authRepo), (req, res) => {
    const customerId =
      typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    const saleId = typeof req.query.saleId === 'string' ? req.query.saleId : undefined;
    res.json(customerRepo.listCustomerPayments({ customerId, saleId }));
  });

  router.post('/', requirePosSell, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = saveCustomerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Données client invalides',
          400
        );
      }
      const created = customerRepo.createCustomer(req.authUser!.id, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', requirePosSell, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = saveCustomerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Données client invalides',
          400
        );
      }
      const updated = customerRepo.updateCustomer(
        req.authUser!.id,
        String(req.params.id),
        parsed.data
      );
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/active', requirePosSell, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = toggleActiveSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Paramètre isActive invalide', 400);
      }
      res.json(
        customerRepo.toggleCustomerActive(
          req.authUser!.id,
          String(req.params.id),
          parsed.data.isActive
        )
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/payments', requirePosSell, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = customerPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Règlement client invalide',
          400
        );
      }
      const payment = customerRepo.recordCustomerDebtPayment(req.authUser!.id, parsed.data);
      res.status(201).json(payment);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
