import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type {
  GoodsReceipt,
  PurchaseOrder,
  SupplierPayment,
} from '@/src/types/purchase';
import type {
  CreatePurchaseOrderValues,
  SupplierPaymentFormValues,
  SupplierReturnFormValues,
} from '../schemas/purchase.schema';

export const PURCHASE_QUERY_KEYS = {
  orders: (filters?: { search?: string; supplierId?: string; status?: string }) =>
    ['purchases', 'orders', filters ?? {}] as const,
  receipts: (filters?: { purchaseOrderId?: string; supplierId?: string }) =>
    ['purchases', 'receipts', filters ?? {}] as const,
  payments: (filters?: { supplierId?: string; purchaseOrderId?: string }) =>
    ['purchases', 'payments', filters ?? {}] as const,
};

export function usePurchaseOrders(filters?: {
  search?: string;
  supplierId?: string;
  status?: string;
}) {
  return useQuery({
    queryKey: PURCHASE_QUERY_KEYS.orders(filters),
    queryFn: () => invokeBackend<PurchaseOrder[]>('purchases_list_orders', filters),
  });
}

export function useGoodsReceipts(filters?: { purchaseOrderId?: string; supplierId?: string }) {
  return useQuery({
    queryKey: PURCHASE_QUERY_KEYS.receipts(filters),
    queryFn: () => invokeBackend<GoodsReceipt[]>('purchases_list_receipts', filters),
  });
}

export function useSupplierPayments(filters?: {
  supplierId?: string;
  purchaseOrderId?: string;
}) {
  return useQuery({
    queryKey: PURCHASE_QUERY_KEYS.payments(filters),
    queryFn: () => invokeBackend<SupplierPayment[]>('purchases_list_payments', filters),
  });
}

export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: CreatePurchaseOrderValues) =>
      invokeBackend<PurchaseOrder>('purchases_create_order', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchases'] });
    },
  });
}

export function useValidatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invokeBackend<PurchaseOrder>('purchases_validate_order', { id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchases'] });
    },
  });
}

export function useCancelPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      invokeBackend<PurchaseOrder>('purchases_cancel_order', { id, reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchases'] });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

export function useReceivePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      id: string;
      supplierInvoiceRef?: string;
      note?: string;
      items: Array<{ purchaseItemId: string; receivedQty: number }>;
    }) => invokeBackend<GoodsReceipt>('purchases_receive_order', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchases'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

export function useRecordSupplierPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: SupplierPaymentFormValues) =>
      invokeBackend<SupplierPayment>('purchases_record_payment', {
        ...values,
        purchaseOrderId: values.purchaseOrderId || null,
        externalReference: values.externalReference?.trim() || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchases'] });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

export function useRecordSupplierReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: SupplierReturnFormValues) =>
      invokeBackend<{ returnNumber: string; baseQtyReturned: number; totalReturnXof: number }>(
        'purchases_record_return',
        values
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchases'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}
