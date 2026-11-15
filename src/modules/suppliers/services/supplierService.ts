import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type { Supplier } from '@/src/types/supplier';
import type { SupplierFormValues } from '../schemas/supplier.schema';

export const SUPPLIER_QUERY_KEYS = {
  list: (filters?: { search?: string; includeInactive?: boolean }) =>
    ['suppliers', 'list', filters ?? {}] as const,
};

export function useSuppliers(filters?: { search?: string; includeInactive?: boolean }) {
  return useQuery({
    queryKey: SUPPLIER_QUERY_KEYS.list(filters),
    queryFn: () => invokeBackend<Supplier[]>('suppliers_list', filters),
  });
}

export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: SupplierFormValues) =>
      invokeBackend<Supplier>('suppliers_create', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: SupplierFormValues }) =>
      invokeBackend<Supplier>('suppliers_update', { id, ...values }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
    },
  });
}

export function useToggleSupplierActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      invokeBackend<Supplier>('suppliers_toggle_active', { id, isActive }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
    },
  });
}
