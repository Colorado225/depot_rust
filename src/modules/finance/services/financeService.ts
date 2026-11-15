import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type { CustomerPaymentMethod } from '@/src/types/customer';
import type {
  CashMovementType,
  CashRegister,
  CashSession,
  CashSessionDetail,
  Expense,
  ExpenseCategory,
  FinanceOverview,
  TreasuryPayment,
} from '@/src/types/finance';

export const CASH_MOVEMENT_LABELS: Record<CashMovementType, string> = {
  OPENING: 'Fond initial (ouverture)',
  SALE_CASH: 'Vente espèces POS',
  DEBT_COLLECTION: 'Recouvrement créance client',
  EXPENSE: 'Dépense opérationnelle',
  SUPPLIER_PAYMENT: 'Règlement fournisseur',
  CONSIGNMENT_REFUND: 'Remboursement consigne',
  MANUAL_IN: 'Apport manuel en caisse',
  MANUAL_OUT: 'Sortie manuelle de caisse',
  CLOSING_ADJUSTMENT: 'Écart / Rectification clôture',
};

export function useFinanceOverview() {
  return useQuery({
    queryKey: ['finance', 'overview'],
    queryFn: () => invokeBackend<FinanceOverview>('finance_overview'),
  });
}

export function useCashRegisters() {
  return useQuery({
    queryKey: ['finance', 'registers'],
    queryFn: () => invokeBackend<CashRegister[]>('finance_list_registers'),
  });
}

export function useCashSessions(limit = 30) {
  return useQuery({
    queryKey: ['finance', 'sessions', limit],
    queryFn: () => invokeBackend<CashSession[]>('finance_list_sessions', { limit }),
  });
}

export function useCashSessionDetail(sessionId: string | null) {
  return useQuery({
    queryKey: ['finance', 'session-detail', sessionId],
    queryFn: () => invokeBackend<CashSessionDetail>('finance_session_detail', { id: sessionId }),
    enabled: Boolean(sessionId),
  });
}

export function useExpenseCategories() {
  return useQuery({
    queryKey: ['finance', 'expense-categories'],
    queryFn: () => invokeBackend<ExpenseCategory[]>('finance_list_expense_categories'),
  });
}

export function useExpenses(filter: {
  categoryId?: string;
  paymentMethod?: CustomerPaymentMethod | '';
  limit?: number;
} = {}) {
  return useQuery({
    queryKey: ['finance', 'expenses', filter],
    queryFn: () => invokeBackend<Expense[]>('finance_list_expenses', filter),
  });
}

export function useTreasuryPayments(filter: {
  paymentMethod?: CustomerPaymentMethod | '';
  direction?: 'INBOUND' | 'OUTBOUND' | '';
  limit?: number;
} = {}) {
  return useQuery({
    queryKey: ['finance', 'payments', filter],
    queryFn: () => invokeBackend<TreasuryPayment[]>('finance_list_payments', filter),
  });
}

export function useOpenCashSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      cashRegisterId: string;
      openingBalanceXof: number;
      notes?: string | null;
    }) => invokeBackend<CashSession>('finance_open_session', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance'] });
    },
  });
}

export function useManualCashMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      cashSessionId: string;
      direction: 'IN' | 'OUT';
      amountXof: number;
      description: string;
    }) => invokeBackend<CashSession>('finance_manual_movement', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance'] });
    },
  });
}

export function useCloseCashSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; declaredClosingXof: number; notes?: string | null }) =>
      invokeBackend<CashSession>('finance_close_session', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance'] });
    },
  });
}

export function useOverrideCashSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      id: string;
      correctedDeclaredXof: number;
      justification: string;
    }) => invokeBackend<CashSession>('finance_override_session', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance'] });
    },
  });
}

export function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; description?: string | null }) =>
      invokeBackend<ExpenseCategory>('finance_create_expense_category', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance', 'expense-categories'] });
    },
  });
}

export function useRecordExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      categoryId: string;
      amountXof: number;
      paymentMethod: CustomerPaymentMethod;
      receiptReference?: string | null;
      description: string;
      expenseDate?: string;
    }) => invokeBackend<Expense>('finance_record_expense', payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finance'] });
    },
  });
}
