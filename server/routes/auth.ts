import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import {
  type AuthenticatedRequest,
  extractBearerToken,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const setupSchema = z.object({
  depotName: z.string().trim().min(2, 'Nom du dépôt requis (min. 2 caractères)').max(120),
  ownerFullName: z.string().trim().min(2, 'Nom du propriétaire requis').max(120),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  address: z.string().trim().max(240).optional().or(z.literal('')),
  logoPath: z.string().max(700_000).optional().or(z.literal('')),
  receiptHeader: z.string().trim().max(240).optional().or(z.literal('')),
  receiptFooter: z.string().trim().max(240).optional().or(z.literal('')),
  defaultCashFloatXof: z.number().int().min(0).optional(),
  allowNegativeStock: z.boolean().optional(),
  username: z
    .string()
    .trim()
    .min(3, 'Identifiant min. 3 caractères')
    .max(50)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Caractères autorisés : lettres, chiffres, ., _, -'),
  password: z.string().min(8, 'Mot de passe min. 8 caractères').max(128),
});

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Identifiant requis'),
  password: z.string().min(1, 'Mot de passe requis'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Mot de passe actuel requis'),
  newPassword: z.string().min(8, 'Nouveau mot de passe min. 8 caractères').max(128),
});

const createUserSchema = z.object({
  fullName: z.string().trim().min(2, 'Nom complet requis').max(120),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  jobTitle: z.string().trim().max(80).optional().or(z.literal('')),
  username: z
    .string()
    .trim()
    .min(3, 'Identifiant min. 3 caractères')
    .max(50)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Caractères autorisés : lettres, chiffres, ., _, -'),
  password: z.string().min(8, 'Mot de passe min. 8 caractères').max(128),
  roleId: z.string().trim().min(1, 'Rôle requis'),
});

const toggleStatusSchema = z.object({
  isActive: z.boolean(),
});

const updateRoleSchema = z.object({
  roleId: z.string().trim().min(1, 'Rôle requis'),
});

export function createAuthRouter(authRepo: AuthRepository): Router {
  const router = Router();

  router.get('/bootstrap-status', (_req, res) => {
    res.json(authRepo.getBootstrapStatus());
  });

  router.post('/setup', (req, res, next) => {
    try {
      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Données de configuration invalides',
          400
        );
      }
      const session = authRepo.initializeDepotAndOwner(parsed.data);
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Identifiants requis',
          400
        );
      }
      const session = authRepo.login(parsed.data.username, parsed.data.password);
      res.json(session);
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    const token = extractBearerToken(req);
    if (token) {
      authRepo.logout(token);
    }
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(authRepo), (req: AuthenticatedRequest, res) => {
    res.json(req.authUser);
  });

  router.post('/change-password', requireAuth(authRepo), (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION_ERROR',
          parsed.error.issues[0]?.message ?? 'Mot de passe invalide',
          400
        );
      }
      authRepo.changePassword(
        req.authUser!.id,
        parsed.data.currentPassword,
        parsed.data.newPassword
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/users', requirePermission(authRepo, 'auth.users.manage'), (_req, res) => {
    res.json(authRepo.listUsers());
  });

  router.post(
    '/users',
    requirePermission(authRepo, 'auth.users.manage'),
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = createUserSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION_ERROR',
            parsed.error.issues[0]?.message ?? 'Données utilisateur invalides',
            400
          );
        }
        const created = authRepo.createUserWithEmployee(req.authUser!.id, parsed.data);
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    '/users/:userId/status',
    requirePermission(authRepo, 'auth.users.manage'),
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = toggleStatusSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError('VALIDATION_ERROR', 'Statut actif invalide', 400);
        }
        const updated = authRepo.toggleUserActive(
          req.authUser!.id,
          String(req.params.userId),
          parsed.data.isActive
        );
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/users/:userId/unlock',
    requirePermission(authRepo, 'auth.users.manage'),
    (req: AuthenticatedRequest, res, next) => {
      try {
        const updated = authRepo.unlockUser(req.authUser!.id, String(req.params.userId));
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  router.patch(
    '/users/:userId/role',
    requirePermission(authRepo, 'auth.users.manage'),
    (req: AuthenticatedRequest, res, next) => {
      try {
        const parsed = updateRoleSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError('VALIDATION_ERROR', 'Rôle invalide', 400);
        }
        const updated = authRepo.updateUserRole(
          req.authUser!.id,
          String(req.params.userId),
          parsed.data.roleId
        );
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get('/roles', requirePermission(authRepo, 'auth.users.manage'), (_req, res) => {
    res.json(authRepo.listRolesAndPermissions());
  });

  router.get('/login-logs', requirePermission(authRepo, 'auth.users.manage'), (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json(authRepo.listLoginLogs(Number.isFinite(limit) ? limit : 50));
  });

  return router;
}
