import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { importBackupFile, invokeBackend } from '@/src/lib/ipc';
import type {
  BackupConfig,
  BackupHistoryEntry,
  BackupOverview,
  BackupType,
  BackupVerification,
  ReliabilityDiagnostics,
  RestorePlan,
} from '@/src/types/backup';
import type { SelfTestReport } from '@/src/types/system';

export const BACKUP_QUERY_KEYS = {
  overview: ['system', 'backups', 'overview'] as const,
};

export function useBackupOverview() {
  return useQuery({
    queryKey: BACKUP_QUERY_KEYS.overview,
    queryFn: () => invokeBackend<BackupOverview>('backup_overview'),
    refetchInterval: 60_000,
  });
}

function useInvalidateOverview() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: BACKUP_QUERY_KEYS.overview });
}

export function useCreateBackup() {
  const invalidate = useInvalidateOverview();
  return useMutation({
    mutationFn: (type: Exclude<BackupType, 'AUTO' | 'PRE_RESTORE'>) =>
      invokeBackend<BackupHistoryEntry>('backup_create', { type }),
    onSuccess: () => void invalidate(),
  });
}

export function useImportBackup() {
  const invalidate = useInvalidateOverview();
  return useMutation({
    mutationFn: (file: File) => importBackupFile(file),
    onSuccess: () => void invalidate(),
  });
}

export function useRunAutoBackup() {
  const invalidate = useInvalidateOverview();
  return useMutation({
    mutationFn: () => invokeBackend<BackupHistoryEntry>('backup_auto_run'),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateBackupConfig() {
  const invalidate = useInvalidateOverview();
  return useMutation({
    mutationFn: (config: BackupConfig) =>
      invokeBackend<BackupConfig>('backup_config_update', { ...config }),
    onSuccess: () => void invalidate(),
  });
}

export function useVerifyBackup() {
  const invalidate = useInvalidateOverview();
  return useMutation({
    mutationFn: (id: string) => invokeBackend<BackupVerification>('backup_verify', { id }),
    onSuccess: () => void invalidate(),
  });
}

export function useRestoreBackup() {
  const invalidate = useInvalidateOverview();
  return useMutation({
    mutationFn: (input: { id: string; confirmation: string; activateOnRestart: boolean }) =>
      invokeBackend<RestorePlan>('backup_restore', input),
    onSuccess: () => void invalidate(),
  });
}

export function useCancelPendingRestore() {
  const invalidate = useInvalidateOverview();
  return useMutation({
    mutationFn: () => invokeBackend<{ cancelled: boolean }>('backup_cancel_restore'),
    onSuccess: () => void invalidate(),
  });
}

export function useBackupDiagnostics() {
  return useMutation({
    mutationFn: () => invokeBackend<ReliabilityDiagnostics>('backup_diagnostics'),
  });
}

export function useLot9SelfTest() {
  return useMutation({
    mutationFn: () => invokeBackend<SelfTestReport>('backup_self_test'),
  });
}
