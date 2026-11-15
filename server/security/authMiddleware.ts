import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../error.ts';
import type { AuthenticatedUserDTO, AuthRepository } from '../repositories/authRepo.ts';

export interface AuthenticatedRequest extends Request {
  authUser?: AuthenticatedUserDTO;
  sessionToken?: string;
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export function requireAuth(authRepo: AuthRepository) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    try {
      const token = extractBearerToken(req);
      if (!token) {
        throw new AppError('PERMISSION_DENIED', 'Authentification requise pour accéder à cette ressource.', 401);
      }
      const user = authRepo.validateSessionToken(token);
      if (!user) {
        throw new AppError('PERMISSION_DENIED', 'Session expirée ou invalide. Veuillez vous reconnecter.', 401);
      }
      req.authUser = user;
      req.sessionToken = token;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requirePermission(authRepo: AuthRepository, permissionCode: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    requireAuth(authRepo)(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      const user = req.authUser;
      if (!user || !user.permissions.includes(permissionCode)) {
        next(
          new AppError(
            'PERMISSION_DENIED',
            `Action refusée : permission « ${permissionCode} » requise pour le rôle ${user?.roleName ?? 'Inconnu'}.`,
            403
          )
        );
        return;
      }
      next();
    });
  };
}
