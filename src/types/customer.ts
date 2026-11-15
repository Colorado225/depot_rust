export type CustomerType = 'PARTICULIER' | 'DETAILLANT' | 'REVENDEUR' | 'ENTREPRISE';

export type CustomerPaymentMethod =
  | 'CASH'
  | 'ORANGE_MONEY'
  | 'MTN_MOMO'
  | 'MOOV_MONEY'
  | 'WAVE'
  | 'BANK_TRANSFER';

export interface Customer {
  id: string;
  fullName: string;
  customerType: CustomerType;
  phone: string | null;
  email: string | null;
  address: string | null;
  creditLimitXof: number;
  commercialDebtXof: number;
  overdueDebtXof: number;
  consignmentBalanceXof: number;
  dueDays: number;
  notes: string | null;
  isActive: boolean;
  salesCount: number;
  totalPurchasedXof: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerPayment {
  id: string;
  paymentNumber: string;
  customerId: string;
  customerName: string;
  paymentMethod: CustomerPaymentMethod;
  amountXof: number;
  externalReference: string | null;
  saleId: string | null;
  saleNumber: string | null;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface CustomerSaleSummary {
  id: string;
  saleNumber: string;
  priceTier: 'WHOLESALE' | 'RETAIL';
  subtotalXof: number;
  discountXof: number;
  consignmentTotalXof: number;
  totalPayableXof: number;
  paidAmountXof: number;
  creditAmountXof: number;
  status: 'VALIDATED' | 'CANCELLED';
  dueAt: string | null;
  isOverdue: boolean;
  createdAt: string;
}

export interface CustomerStatement {
  customer: Customer;
  sales: CustomerSaleSummary[];
  payments: CustomerPayment[];
}

export interface SaveCustomerInput {
  fullName: string;
  customerType: CustomerType;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  creditLimitXof: number;
  dueDays: number;
  notes?: string | null;
}

export interface RecordCustomerPaymentInput {
  customerId: string;
  saleId?: string | null;
  paymentMethod: CustomerPaymentMethod;
  amountXof: number;
  externalReference?: string | null;
}
