import type { CustomerPaymentMethod } from './customer';

export type CashSessionStatus = 'OPEN' | 'CLOSED';

export type CashMovementType =
  | 'OPENING'
  | 'SALE_CASH'
  | 'DEBT_COLLECTION'
  | 'EXPENSE'
  | 'SUPPLIER_PAYMENT'
  | 'CONSIGNMENT_REFUND'
  | 'MANUAL_IN'
  | 'MANUAL_OUT'
  | 'CLOSING_ADJUSTMENT';

export interface CashRegister {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface ChannelReconciliation {
  paymentMethod: CustomerPaymentMethod;
  inboundXof: number;
  outboundPaymentsXof: number;
  expensesXof: number;
  netXof: number;
  transactionCount: number;
}

export interface CashSession {
  id: string;
  cashRegisterId: string;
  registerCode: string;
  registerName: string;
  openedByUserId: string;
  openedByName: string;
  closedByUserId: string | null;
  closedByName: string | null;
  openingBalanceXof: number;
  cashInXof: number;
  cashOutXof: number;
  theoreticalClosingXof: number;
  declaredClosingXof: number | null;
  varianceXof: number | null;
  status: CashSessionStatus;
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
  channels: ChannelReconciliation[];
}

export interface CashMovement {
  id: string;
  cashSessionId: string;
  movementType: CashMovementType;
  amountSignedXof: number;
  referenceType: string | null;
  referenceId: string | null;
  description: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface CashSessionDetail {
  session: CashSession;
  movements: CashMovement[];
}

export interface ExpenseCategory {
  id: string;
  name: string;
  description: string | null;
}

export interface Expense {
  id: string;
  categoryId: string;
  categoryName: string;
  amountXof: number;
  paymentMethod: CustomerPaymentMethod;
  cashSessionId: string | null;
  receiptReference: string | null;
  description: string;
  expenseDate: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface TreasuryPayment {
  id: string;
  paymentNumber: string;
  direction: 'INBOUND' | 'OUTBOUND';
  partyType: 'CUSTOMER' | 'SUPPLIER';
  partyName: string;
  paymentMethod: CustomerPaymentMethod;
  amountXof: number;
  externalReference: string | null;
  cashSessionId: string | null;
  userName: string;
  createdAt: string;
}

export interface FinanceOverview {
  activeSession: CashSession | null;
  registers: CashRegister[];
  totalInboundXof: number;
  totalOutboundPaymentsXof: number;
  totalExpensesXof: number;
  netTreasuryXof: number;
  closedSessionsCount: number;
  cumulativeVarianceXof: number;
  channels: ChannelReconciliation[];
}
