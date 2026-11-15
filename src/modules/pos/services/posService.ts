import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type { CreateSaleInput, Sale } from '@/src/types/pos';

export function useSalesHistory(
  filter: {
    search?: string;
    customerId?: string;
    status?: string;
    priceTier?: string;
    limit?: number;
  } = {}
) {
  return useQuery({
    queryKey: ['pos', 'sales', filter],
    queryFn: () => invokeBackend<Sale[]>('pos_list_sales', filter),
  });
}

export function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSaleInput) =>
      invokeBackend<Sale>('pos_create_sale', input as unknown as Record<string, unknown>),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pos', 'sales'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
    },
  });
}

export function useCancelSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; reason: string }) =>
      invokeBackend<Sale>('pos_cancel_sale', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pos', 'sales'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
    },
  });
}
