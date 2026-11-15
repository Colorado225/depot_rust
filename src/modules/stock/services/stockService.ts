import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type {
  StockBalanceItem,
  StockInventorySummary,
  StockMovement,
} from '@/src/types/stock';
import type { StockMovementFormValues } from '../schemas/stock.schema';

export const STOCK_QUERY_KEYS = {
  balances: (filters?: { search?: string; onlyLowStock?: boolean }) =>
    ['stock', 'balances', filters ?? {}] as const,
  movements: (filters?: { productId?: string; movementType?: string; limit?: number }) =>
    ['stock', 'movements', filters ?? {}] as const,
  inventories: ['stock', 'inventories'] as const,
};

export function useStockBalances(filters?: { search?: string; onlyLowStock?: boolean }) {
  return useQuery({
    queryKey: STOCK_QUERY_KEYS.balances(filters),
    queryFn: () => invokeBackend<StockBalanceItem[]>('stock_list_balances', filters),
  });
}

export function useStockMovements(filters?: {
  productId?: string;
  movementType?: string;
  limit?: number;
}) {
  return useQuery({
    queryKey: STOCK_QUERY_KEYS.movements(filters),
    queryFn: () => invokeBackend<StockMovement[]>('stock_list_movements', filters),
  });
}

export function useStockInventories() {
  return useQuery({
    queryKey: STOCK_QUERY_KEYS.inventories,
    queryFn: () => invokeBackend<StockInventorySummary[]>('stock_list_inventories'),
  });
}

export function useRecordStockMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: StockMovementFormValues) =>
      invokeBackend<StockMovement>('stock_record_movement', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
    },
  });
}

export function useValidateStockInventory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      note?: string;
      lines: Array<{ productId: string; countedBase: number }>;
    }) => invokeBackend<StockInventorySummary>('stock_validate_inventory', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
    },
  });
}
