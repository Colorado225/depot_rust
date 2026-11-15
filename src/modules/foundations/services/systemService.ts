import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type {
  ArchitectureDecision,
  IntegrityCheckResult,
  LicenseState,
  MigrationsOverview,
  SelfTestReport,
  SystemHealth,
} from '@/src/types/system';
import type { ActivateLicenseFormValues } from '../schemas/license.schema';

export const SYSTEM_QUERY_KEYS = {
  health: ['system', 'health'] as const,
  migrations: ['system', 'migrations'] as const,
  decisions: ['system', 'decisions'] as const,
  license: ['system', 'license'] as const,
};

export function useSystemHealth() {
  return useQuery({
    queryKey: SYSTEM_QUERY_KEYS.health,
    queryFn: () => invokeBackend<SystemHealth>('check_system_health'),
  });
}

export function useMigrationsOverview() {
  return useQuery({
    queryKey: SYSTEM_QUERY_KEYS.migrations,
    queryFn: () => invokeBackend<MigrationsOverview>('get_migrations_status'),
  });
}

export function useArchitectureDecisions() {
  return useQuery({
    queryKey: SYSTEM_QUERY_KEYS.decisions,
    queryFn: () => invokeBackend<ArchitectureDecision[]>('get_architectural_decisions'),
  });
}

export function useLicenseState() {
  return useQuery({
    queryKey: SYSTEM_QUERY_KEYS.license,
    queryFn: () => invokeBackend<LicenseState>('get_license_state'),
  });
}

export function useActivateLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: ActivateLicenseFormValues) =>
      invokeBackend<LicenseState>('update_local_license', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SYSTEM_QUERY_KEYS.license });
      void qc.invalidateQueries({ queryKey: SYSTEM_QUERY_KEYS.migrations });
    },
  });
}

export function useResetTrialLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invokeBackend<LicenseState>('reset_local_license'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SYSTEM_QUERY_KEYS.license });
      void qc.invalidateQueries({ queryKey: SYSTEM_QUERY_KEYS.migrations });
    },
  });
}

export function useIntegrityCheck() {
  return useMutation({
    mutationFn: () => invokeBackend<IntegrityCheckResult>('trigger_integrity_check'),
  });
}

export function useFoundationSelfTest() {
  return useMutation({
    mutationFn: () => invokeBackend<SelfTestReport>('run_foundation_self_test'),
  });
}
