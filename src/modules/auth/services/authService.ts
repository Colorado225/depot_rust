import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getStoredSessionToken,
  invokeBackend,
  setStoredSessionToken,
} from '@/src/lib/ipc';
import type {
  AuthenticatedUser,
  AuthSessionResponse,
  BootstrapStatus,
  LoginLog,
  RoleWithPermissions,
  UserAccount,
} from '@/src/types/auth';
import type {
  ChangePasswordFormValues,
  CreateUserFormValues,
  LoginFormValues,
  SetupDepotFormValues,
} from '../schemas/auth.schema';

export const AUTH_QUERY_KEYS = {
  bootstrap: ['auth', 'bootstrap'] as const,
  me: ['auth', 'me'] as const,
  users: ['auth', 'users'] as const,
  roles: ['auth', 'roles'] as const,
  loginLogs: ['auth', 'login-logs'] as const,
};

export function useBootstrapStatus() {
  return useQuery({
    queryKey: AUTH_QUERY_KEYS.bootstrap,
    queryFn: () => invokeBackend<BootstrapStatus>('auth_bootstrap_status'),
    staleTime: 0,
  });
}

export function useCurrentUser(enabled = true) {
  const token = getStoredSessionToken();
  return useQuery({
    queryKey: AUTH_QUERY_KEYS.me,
    queryFn: async () => {
      try {
        return await invokeBackend<AuthenticatedUser>('auth_me');
      } catch (err) {
        setStoredSessionToken(null);
        throw err;
      }
    },
    enabled: enabled && Boolean(token),
    retry: false,
  });
}

export function useInitializeDepot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: SetupDepotFormValues) => {
      const { confirmPassword: _ignored, ...payload } = values;
      return invokeBackend<AuthSessionResponse>('auth_initialize_depot', payload);
    },
    onSuccess: (session) => {
      setStoredSessionToken(session.token);
      qc.setQueryData(AUTH_QUERY_KEYS.me, session.user);
      void qc.invalidateQueries({ queryKey: AUTH_QUERY_KEYS.bootstrap });
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: LoginFormValues) =>
      invokeBackend<AuthSessionResponse>('auth_login', values),
    onSuccess: (session) => {
      setStoredSessionToken(session.token);
      qc.setQueryData(AUTH_QUERY_KEYS.me, session.user);
      void qc.invalidateQueries({ queryKey: AUTH_QUERY_KEYS.loginLogs });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invokeBackend<{ ok: boolean }>('auth_logout'),
    onSettled: () => {
      setStoredSessionToken(null);
      qc.removeQueries({ queryKey: AUTH_QUERY_KEYS.me });
      qc.clear();
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (values: ChangePasswordFormValues) =>
      invokeBackend<{ ok: boolean }>('auth_change_password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
  });
}

export function useUsersList(enabled = true) {
  return useQuery({
    queryKey: AUTH_QUERY_KEYS.users,
    queryFn: () => invokeBackend<UserAccount[]>('auth_list_users'),
    enabled,
  });
}

export function useRolesList(enabled = true) {
  return useQuery({
    queryKey: AUTH_QUERY_KEYS.roles,
    queryFn: () => invokeBackend<RoleWithPermissions[]>('auth_list_roles'),
    enabled,
  });
}

export function useLoginLogs(enabled = true) {
  return useQuery({
    queryKey: AUTH_QUERY_KEYS.loginLogs,
    queryFn: () => invokeBackend<LoginLog[]>('auth_list_login_logs'),
    enabled,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: CreateUserFormValues) =>
      invokeBackend<UserAccount>('auth_create_user', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AUTH_QUERY_KEYS.users });
    },
  });
}

export function useToggleUserStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, isActive }: { userId: string; isActive: boolean }) =>
      invokeBackend<UserAccount>('auth_toggle_user_status', { userId, isActive }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AUTH_QUERY_KEYS.users });
    },
  });
}

export function useUnlockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      invokeBackend<UserAccount>('auth_unlock_user', { userId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AUTH_QUERY_KEYS.users });
    },
  });
}

export function useUpdateUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      invokeBackend<UserAccount>('auth_update_user_role', { userId, roleId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AUTH_QUERY_KEYS.users });
    },
  });
}
