import crypto from 'node:crypto';
import type { DatabaseLike } from '../db/driver.ts';
import { AppError } from '../error.ts';
import { assertNonNegativeXof } from '../domain/money.ts';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../security/password.ts';

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;
const SESSION_TTL_HOURS = 12;

export interface BootstrapStatusDTO {
  needsSetup: boolean;
  depotName: string | null;
  logoPath: string | null;
}

export interface AuthenticatedUserDTO {
  id: string;
  employeeId: string | null;
  username: string;
  fullName: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  lastLoginAt: string | null;
}

export interface AuthSessionResponseDTO {
  token: string;
  expiresAt: string;
  user: AuthenticatedUserDTO;
}

export interface UserAccountDTO {
  id: string;
  employeeId: string | null;
  username: string;
  fullName: string;
  phone: string | null;
  jobTitle: string | null;
  roleId: string;
  roleCode: string;
  roleName: string;
  isActive: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleWithPermissionsDTO {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: Array<{
    id: string;
    code: string;
    module: string;
    description: string;
  }>;
}

export interface LoginLogDTO {
  id: string;
  userId: string | null;
  usernameAttempted: string;
  success: boolean;
  reason: string | null;
  createdAt: string;
}

export interface InitializeDepotInput {
  depotName: string;
  ownerFullName: string;
  phone?: string;
  address?: string;
  logoPath?: string;
  receiptHeader?: string;
  receiptFooter?: string;
  defaultCashFloatXof?: number;
  allowNegativeStock?: boolean;
  username: string;
  password: string;
}

export interface CreateUserInput {
  fullName: string;
  phone?: string;
  jobTitle?: string;
  username: string;
  password: string;
  roleId: string;
}

export class AuthRepository {
  constructor(private readonly db: DatabaseLike) {}

  getBootstrapStatus(): BootstrapStatusDTO {
    const ownerRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.code = 'OWNER'`
      )
      .get() as { cnt: number };

    const settingsRow = this.db
      .prepare('SELECT depot_name AS depotName, logo_path AS logoPath, is_initialized AS isInit FROM business_settings LIMIT 1')
      .get() as { depotName: string; logoPath: string | null; isInit: number } | undefined;

    const needsSetup = ownerRow.cnt === 0 || !settingsRow || settingsRow.isInit === 0;
    return {
      needsSetup,
      depotName: settingsRow?.depotName ?? null,
      logoPath: settingsRow?.logoPath ?? null,
    };
  }

  initializeDepotAndOwner(input: InitializeDepotInput): AuthSessionResponseDTO {
    const status = this.getBootstrapStatus();
    if (!status.needsSetup) {
      throw new AppError(
        'CONFLICT',
        'Le dépôt et le compte propriétaire sont déjà initialisés.',
        409
      );
    }

    const cleanUsername = input.username.trim().toLowerCase();
    const cleanDepot = input.depotName.trim();
    const cleanOwner = input.ownerFullName.trim();
    const floatXof = assertNonNegativeXof(input.defaultCashFloatXof ?? 0, 'Fonds de caisse initial');

    const employeeId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const settingsId = 'depot-settings-main';
    const passwordHash = hashPassword(input.password);
    const { rawToken, tokenHash } = generateSessionToken();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO business_settings (
             id, depot_name, owner_name, phone, address, logo_path,
             currency, receipt_header, receipt_footer, default_consignment_policy,
             allow_negative_stock, default_cash_float_xof, receipt_print_width, is_initialized
           ) VALUES (?, ?, ?, ?, ?, ?, 'XOF', ?, ?, 'SEPARATE_TRACKING', ?, ?, '80mm', 1)
           ON CONFLICT(id) DO UPDATE SET
             depot_name = excluded.depot_name,
             owner_name = excluded.owner_name,
             phone = excluded.phone,
             address = excluded.address,
             logo_path = excluded.logo_path,
             receipt_header = excluded.receipt_header,
             receipt_footer = excluded.receipt_footer,
             allow_negative_stock = excluded.allow_negative_stock,
             default_cash_float_xof = excluded.default_cash_float_xof,
             is_initialized = 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        )
        .run(
          settingsId,
          cleanDepot,
          cleanOwner,
          input.phone?.trim() || null,
          input.address?.trim() || null,
          input.logoPath || null,
          input.receiptHeader?.trim() || null,
          input.receiptFooter?.trim() || 'Merci pour votre confiance !',
          input.allowNegativeStock ? 1 : 0,
          floatXof
        );

      this.db
        .prepare(
          `INSERT INTO employees (id, full_name, phone, job_title, is_active)
           VALUES (?, ?, ?, 'Propriétaire', 1)`
        )
        .run(employeeId, cleanOwner, input.phone?.trim() || null);

      this.db
        .prepare(
          `INSERT INTO users (id, employee_id, username, password_hash, role_id, is_active, last_login_at)
           VALUES (?, ?, ?, ?, 'role-owner', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
        )
        .run(userId, employeeId, cleanUsername, passwordHash);

      this.db
        .prepare(
          `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(sessionId, userId, tokenHash, expiresAt);

      this.db
        .prepare(
          `INSERT INTO login_logs (id, user_id, username_attempted, success, reason)
           VALUES (?, ?, ?, 1, 'INITIAL_OWNER_SETUP')`
        )
        .run(crypto.randomUUID(), userId, cleanUsername);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'DEPOT_INITIALIZED', 'business_settings', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          userId,
          settingsId,
          JSON.stringify({ depotName: cleanDepot, ownerUsername: cleanUsername })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw new AppError(
        'DATABASE_ERROR',
        `Échec d'initialisation du dépôt : ${err instanceof Error ? err.message : String(err)}`,
        500
      );
    }

    const user = this.getAuthenticatedUserById(userId);
    return { token: rawToken, expiresAt, user };
  }

  login(usernameInput: string, passwordInput: string): AuthSessionResponseDTO {
    const cleanUsername = usernameInput.trim().toLowerCase();
    const userRow = this.db
      .prepare(
        `SELECT id, username, password_hash AS passwordHash, is_active AS isActive,
                failed_attempts AS failedAttempts, locked_until AS lockedUntil
         FROM users WHERE LOWER(username) = ?`
      )
      .get(cleanUsername) as
      | {
          id: string;
          username: string;
          passwordHash: string;
          isActive: number;
          failedAttempts: number;
          lockedUntil: string | null;
        }
      | undefined;

    if (!userRow) {
      this.db
        .prepare(
          `INSERT INTO login_logs (id, user_id, username_attempted, success, reason)
           VALUES (?, NULL, ?, 0, 'UNKNOWN_USERNAME')`
        )
        .run(crypto.randomUUID(), cleanUsername);
      throw new AppError('PERMISSION_DENIED', 'Identifiant ou mot de passe incorrect.', 401);
    }

    if (userRow.isActive !== 1) {
      this.db
        .prepare(
          `INSERT INTO login_logs (id, user_id, username_attempted, success, reason)
           VALUES (?, ?, ?, 0, 'ACCOUNT_DISABLED')`
        )
        .run(crypto.randomUUID(), userRow.id, cleanUsername);
      throw new AppError(
        'PERMISSION_DENIED',
        'Ce compte utilisateur est désactivé. Contactez le propriétaire.',
        403
      );
    }

    if (userRow.lockedUntil) {
      const lockedUntilMs = Date.parse(userRow.lockedUntil);
      if (!Number.isNaN(lockedUntilMs) && lockedUntilMs > Date.now()) {
        const remainingMin = Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 60000));
        this.db
          .prepare(
            `INSERT INTO login_logs (id, user_id, username_attempted, success, reason)
             VALUES (?, ?, ?, 0, 'ACCOUNT_LOCKED')`
          )
          .run(crypto.randomUUID(), userRow.id, cleanUsername);
        throw new AppError(
          'PERMISSION_DENIED',
          `Compte temporairement verrouillé après plusieurs échecs. Réessayez dans ${remainingMin} min ou demandez un déverrouillage au propriétaire.`,
          423
        );
      }
    }

    const passwordValid = verifyPassword(passwordInput, userRow.passwordHash);
    if (!passwordValid) {
      const nextAttempts = userRow.failedAttempts + 1;
      const shouldLock = nextAttempts >= MAX_FAILED_LOGIN_ATTEMPTS;
      const lockedUntilIso = shouldLock
        ? new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString()
        : null;

      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db
          .prepare(
            `UPDATE users
             SET failed_attempts = ?,
                 locked_until = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?`
          )
          .run(nextAttempts, lockedUntilIso, userRow.id);

        this.db
          .prepare(
            `INSERT INTO login_logs (id, user_id, username_attempted, success, reason)
             VALUES (?, ?, ?, 0, ?)`
          )
          .run(
            crypto.randomUUID(),
            userRow.id,
            cleanUsername,
            shouldLock ? 'INVALID_PASSWORD_LOCKED' : 'INVALID_PASSWORD'
          );

        if (shouldLock) {
          this.db
            .prepare(
              `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
               VALUES (?, ?, 'USER_LOCKED_FAILED_LOGINS', 'users', ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              userRow.id,
              userRow.id,
              JSON.stringify({ failedAttempts: nextAttempts, lockedUntil: lockedUntilIso })
            );
        }

        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }

      if (shouldLock) {
        throw new AppError(
          'PERMISSION_DENIED',
          `Compte verrouillé pour ${LOCK_DURATION_MINUTES} minutes après ${MAX_FAILED_LOGIN_ATTEMPTS} tentatives échouées.`,
          423
        );
      }

      const remaining = MAX_FAILED_LOGIN_ATTEMPTS - nextAttempts;
      throw new AppError(
        'PERMISSION_DENIED',
        `Identifiant ou mot de passe incorrect (${remaining} tentative${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''}).`,
        401
      );
    }

    const { rawToken, tokenHash } = generateSessionToken();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE users
           SET failed_attempts = 0,
               locked_until = NULL,
               last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`
        )
        .run(userRow.id);

      this.db
        .prepare(
          `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(sessionId, userRow.id, tokenHash, expiresAt);

      this.db
        .prepare(
          `INSERT INTO login_logs (id, user_id, username_attempted, success, reason)
           VALUES (?, ?, ?, 1, 'LOGIN_SUCCESS')`
        )
        .run(crypto.randomUUID(), userRow.id, cleanUsername);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    const user = this.getAuthenticatedUserById(userRow.id);
    return { token: rawToken, expiresAt, user };
  }

  validateSessionToken(rawToken: string): AuthenticatedUserDTO | null {
    const tokenHash = hashSessionToken(rawToken);
    const row = this.db
      .prepare(
        `SELECT s.user_id AS userId, s.expires_at AS expiresAt, s.revoked_at AS revokedAt,
                u.is_active AS isActive
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash) as
      | { userId: string; expiresAt: string; revokedAt: string | null; isActive: number }
      | undefined;

    if (!row || row.revokedAt || row.isActive !== 1) {
      return null;
    }
    const expMs = Date.parse(row.expiresAt);
    if (Number.isNaN(expMs) || expMs <= Date.now()) {
      return null;
    }

    return this.getAuthenticatedUserById(row.userId);
  }

  logout(rawToken: string): void {
    const tokenHash = hashSessionToken(rawToken);
    const row = this.db
      .prepare('SELECT user_id AS userId FROM user_sessions WHERE token_hash = ?')
      .get(tokenHash) as { userId: string } | undefined;

    this.db
      .prepare(
        "UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_hash = ? AND revoked_at IS NULL"
      )
      .run(tokenHash);

    if (row) {
      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'USER_LOGOUT', 'users', ?, '{}')`
        )
        .run(crypto.randomUUID(), row.userId, row.userId);
    }
  }

  /**
   * LOT 11 — Change le mot de passe ET révoque les sessions.
   *
   * `keepTokenHash` conserve la session courante (l'utilisateur vient de saisir
   * son mot de passe actuel : le déconnecter le forcerait à se reconnecter
   * immédiatement). Toutes les AUTRES sessions sont révoquées : un mot de passe
   * changé après un soupçon de compromission coupe donc réellement l'accès.
   */
  changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepTokenHash: string | null = null
  ): void {
    const row = this.db
      .prepare('SELECT password_hash AS passwordHash FROM users WHERE id = ?')
      .get(userId) as { passwordHash: string } | undefined;

    if (!row) {
      throw new AppError('NOT_FOUND', 'Utilisateur introuvable.', 404);
    }

    if (!verifyPassword(currentPassword, row.passwordHash)) {
      throw new AppError('PERMISSION_DENIED', 'Le mot de passe actuel est incorrect.', 400);
    }

    if (currentPassword === newPassword) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Le nouveau mot de passe doit être différent de l’ancien.',
        400
      );
    }

    const nextHash = hashPassword(newPassword);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE users
           SET password_hash = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(nextHash, userId);

      // LOT 11 — révocation des autres sessions dans la MÊME transaction.
      const revoked = this.db
        .prepare(
          `UPDATE user_sessions
           SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE user_id = ? AND revoked_at IS NULL
             AND (? IS NULL OR token_hash <> ?)`
        )
        .run(userId, keepTokenHash, keepTokenHash);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'PASSWORD_CHANGED', 'users', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          userId,
          userId,
          JSON.stringify({ revokedSessions: Number(revoked.changes ?? 0) })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  listUsers(): UserAccountDTO[] {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.employee_id AS employeeId, u.username,
                COALESCE(e.full_name, u.username) AS fullName,
                e.phone, e.job_title AS jobTitle,
                r.id AS roleId, r.code AS roleCode, r.name AS roleName,
                u.is_active AS isActive, u.failed_attempts AS failedAttempts,
                u.locked_until AS lockedUntil, u.last_login_at AS lastLoginAt,
                u.created_at AS createdAt
         FROM users u
         LEFT JOIN employees e ON e.id = u.employee_id
         JOIN roles r ON r.id = u.role_id
         ORDER BY r.is_system DESC, u.created_at ASC`
      )
      .all() as Array<Omit<UserAccountDTO, 'isActive'> & { isActive: number }>;

    return rows.map((r) => ({
      ...r,
      isActive: r.isActive === 1,
    }));
  }

  createUserWithEmployee(actorUserId: string, input: CreateUserInput): UserAccountDTO {
    const cleanUsername = input.username.trim().toLowerCase();
    const existing = this.db
      .prepare('SELECT id FROM users WHERE LOWER(username) = ?')
      .get(cleanUsername);
    if (existing) {
      throw new AppError('CONFLICT', `L'identifiant « ${cleanUsername} » est déjà utilisé.`, 409);
    }

    const role = this.db.prepare('SELECT id, name FROM roles WHERE id = ?').get(input.roleId) as
      | { id: string; name: string }
      | undefined;
    if (!role) {
      throw new AppError('NOT_FOUND', 'Rôle sélectionné introuvable.', 404);
    }

    const employeeId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const passwordHash = hashPassword(input.password);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO employees (id, full_name, phone, job_title, is_active)
           VALUES (?, ?, ?, ?, 1)`
        )
        .run(
          employeeId,
          input.fullName.trim(),
          input.phone?.trim() || null,
          input.jobTitle?.trim() || role.name
        );

      this.db
        .prepare(
          `INSERT INTO users (id, employee_id, username, password_hash, role_id, is_active)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .run(userId, employeeId, cleanUsername, passwordHash, input.roleId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'USER_CREATED', 'users', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          userId,
          JSON.stringify({ username: cleanUsername, roleId: input.roleId })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listUsers().find((u) => u.id === userId)!;
  }

  toggleUserActive(actorUserId: string, targetUserId: string, isActive: boolean): UserAccountDTO {
    if (actorUserId === targetUserId && !isActive) {
      throw new AppError(
        'CONFLICT',
        'Vous ne pouvez pas désactiver votre propre compte en cours de session.',
        409
      );
    }

    const target = this.db
      .prepare(
        `SELECT u.id, r.code AS roleCode, u.is_active AS isActive
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
      )
      .get(targetUserId) as { id: string; roleCode: string; isActive: number } | undefined;

    if (!target) {
      throw new AppError('NOT_FOUND', 'Compte utilisateur introuvable.', 404);
    }

    if (target.roleCode === 'OWNER' && !isActive) {
      const activeOwners = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'OWNER' AND u.is_active = 1"
          )
          .get() as { cnt: number }
      ).cnt;
      if (activeOwners <= 1) {
        throw new AppError(
          'CONFLICT',
          'Impossible de désactiver le dernier compte Propriétaire actif.',
          409
        );
      }
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE users SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), sync_version = sync_version + 1 WHERE id = ?`
        )
        .run(isActive ? 1 : 0, targetUserId);

      if (!isActive) {
        this.db
          .prepare(
            "UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND revoked_at IS NULL"
          )
          .run(targetUserId);
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, ?, 'users', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
          targetUserId,
          JSON.stringify({ isActive })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listUsers().find((u) => u.id === targetUserId)!;
  }

  unlockUser(actorUserId: string, targetUserId: string): UserAccountDTO {
    const target = this.db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!target) {
      throw new AppError('NOT_FOUND', 'Compte utilisateur introuvable.', 404);
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE users
           SET failed_attempts = 0,
               locked_until = NULL,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`
        )
        .run(targetUserId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'USER_UNLOCKED', 'users', ?, '{}')`
        )
        .run(crypto.randomUUID(), actorUserId, targetUserId);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listUsers().find((u) => u.id === targetUserId)!;
  }

  updateUserRole(actorUserId: string, targetUserId: string, nextRoleId: string): UserAccountDTO {
    const role = this.db.prepare('SELECT id, code FROM roles WHERE id = ?').get(nextRoleId) as
      | { id: string; code: string }
      | undefined;
    if (!role) {
      throw new AppError('NOT_FOUND', 'Rôle introuvable.', 404);
    }

    const target = this.db
      .prepare(
        'SELECT u.id, r.code AS roleCode FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?'
      )
      .get(targetUserId) as { id: string; roleCode: string } | undefined;
    if (!target) {
      throw new AppError('NOT_FOUND', 'Compte utilisateur introuvable.', 404);
    }

    if (target.roleCode === 'OWNER' && role.code !== 'OWNER') {
      const activeOwners = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'OWNER' AND u.is_active = 1"
          )
          .get() as { cnt: number }
      ).cnt;
      if (activeOwners <= 1) {
        throw new AppError(
          'CONFLICT',
          'Impossible de rétrograder le dernier Propriétaire actif.',
          409
        );
      }
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE users SET role_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), sync_version = sync_version + 1 WHERE id = ?`
        )
        .run(nextRoleId, targetUserId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'USER_ROLE_UPDATED', 'users', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          targetUserId,
          JSON.stringify({ nextRoleId })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listUsers().find((u) => u.id === targetUserId)!;
  }

  listRolesAndPermissions(): RoleWithPermissionsDTO[] {
    const roles = this.db
      .prepare('SELECT id, code, name, description FROM roles ORDER BY is_system DESC, name ASC')
      .all() as Array<{ id: string; code: string; name: string; description: string | null }>;

    const permStmt = this.db.prepare(
      `SELECT p.id, p.code, p.module, p.description
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?
       ORDER BY p.module ASC, p.code ASC`
    );

    return roles.map((role) => ({
      ...role,
      permissions: permStmt.all(role.id) as RoleWithPermissionsDTO['permissions'],
    }));
  }

  listLoginLogs(limit = 50): LoginLogDTO[] {
    const safeLimit = Math.min(200, Math.max(1, limit));
    const rows = this.db
      .prepare(
        `SELECT id, user_id AS userId, username_attempted AS usernameAttempted,
                success, reason, created_at AS createdAt
         FROM login_logs
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(safeLimit) as Array<Omit<LoginLogDTO, 'success'> & { success: number }>;

    return rows.map((r) => ({
      ...r,
      success: r.success === 1,
    }));
  }

  hasPermission(userId: string, permissionCode: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS allowed
         FROM users u
         JOIN role_permissions rp ON rp.role_id = u.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE u.id = ? AND u.is_active = 1 AND p.code = ?
         LIMIT 1`
      )
      .get(userId, permissionCode) as { allowed: number } | undefined;
    return Boolean(row?.allowed);
  }

  private getAuthenticatedUserById(userId: string): AuthenticatedUserDTO {
    const row = this.db
      .prepare(
        `SELECT u.id, u.employee_id AS employeeId, u.username,
                COALESCE(e.full_name, u.username) AS fullName,
                r.id AS roleId, r.code AS roleCode, r.name AS roleName,
                u.last_login_at AS lastLoginAt
         FROM users u
         LEFT JOIN employees e ON e.id = u.employee_id
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = ?`
      )
      .get(userId) as Omit<AuthenticatedUserDTO, 'permissions'> | undefined;

    if (!row) {
      throw new AppError('NOT_FOUND', 'Utilisateur introuvable.', 404);
    }

    const perms = this.db
      .prepare(
        `SELECT p.code
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         ORDER BY p.code ASC`
      )
      .all(row.roleId) as Array<{ code: string }>;

    return {
      ...row,
      permissions: perms.map((p) => p.code),
    };
  }
}
