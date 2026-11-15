import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type { BusinessSettings } from '@/src/types/settings';
import { AUTH_QUERY_KEYS } from '@/src/modules/auth/services/authService';
import type { BusinessSettingsFormValues } from '../schemas/settings.schema';

export const SETTINGS_QUERY_KEYS = {
  current: ['settings', 'current'] as const,
};

export function useBusinessSettings(enabled = true) {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEYS.current,
    queryFn: () => invokeBackend<BusinessSettings>('settings_get'),
    enabled,
  });
}

export function useUpdateBusinessSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: BusinessSettingsFormValues) =>
      invokeBackend<BusinessSettings>('settings_update', values),
    onSuccess: (updated) => {
      qc.setQueryData(SETTINGS_QUERY_KEYS.current, updated);
      void qc.invalidateQueries({ queryKey: AUTH_QUERY_KEYS.bootstrap });
    },
  });
}
