import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type {
  Customer,
  CustomerPayment,
  CustomerStatement,
  RecordCustomerPaymentInput,
  SaveCustomerInput,
} from '@/src/types/customer';

export const CUSTOMER_TYPE_LABELS: Record<Customer['customerType'], string> = {
  PARTICULIER: 'Particulier',
  DETAILLANT: 'Détaillant / Maquis',
  REVENDEUR: 'Revendeur',
  ENTREPRISE: 'Entreprise',
};

export const PAYMENT_METHOD_LABELS: Record<CustomerPayment['paymentMethod'], string> = {
  CASH: 'Espèces',
  ORANGE_MONEY: 'Orange Money',
  MTN_MOMO: 'MTN MoMo',
  MOOV_MONEY: 'Moov Money',
  WAVE: 'Wave',
  BANK_TRANSFER: 'Virement bancaire',
};

export function useCustomers(
  filter: {
    search?: string;
    customerType?: string;
    onlyWithDebt?: boolean;
    includeInactive?: boolean;
  } = {}
) {
  return useQuery({
    queryKey: ['customers', filter],
    queryFn: () => invokeBackend<Customer[]>('customers_list', filter),
  });
}

export function useCustomerStatement(customerId: string | null) {
  return useQuery({
    queryKey: ['customers', 'statement', customerId],
    queryFn: () => invokeBackend<CustomerStatement>('customers_statement', { id: customerId }),
    enabled: Boolean(customerId),
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCustomerInput) =>
      invokeBackend<Customer>('customers_create', input as unknown as Record<string, unknown>),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SaveCustomerInput & { id: string }) =>
      invokeBackend<Customer>('customers_update', payload as unknown as Record<string, unknown>),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useToggleCustomerActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; isActive: boolean }) =>
      invokeBackend<Customer>('customers_toggle_active', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useRecordCustomerPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordCustomerPaymentInput) =>
      invokeBackend<CustomerPayment>(
        'customers_record_payment',
        input as unknown as Record<string, unknown>
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['pos', 'sales'] });
    },
  });
}
