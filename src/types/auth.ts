export interface BootstrapStatus {
  needsSetup: boolean;
  depotName: string | null;
  logoPath: string | null;
}

export interface AuthenticatedUser {
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

export interface AuthSessionResponse {
  token: string;
  expiresAt: string;
  user: AuthenticatedUser;
}

export interface UserAccount {
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

export interface RolePermission {
  id: string;
  code: string;
  module: string;
  description: string;
}

export interface RoleWithPermissions {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: RolePermission[];
}

export interface LoginLog {
  id: string;
  userId: string | null;
  usernameAttempted: string;
  success: boolean;
  reason: string | null;
  createdAt: string;
}
