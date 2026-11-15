import type { CustomerPaymentMethod } from './customer';

export type PriceTier = 'WHOLESALE' | 'RETAIL';

export interface SaleItem {
  id: string;
  saleId: string;
  productId: string;
  productSku: string;
  productName: string;
  unitId: string;
  unitName: string;
  baseUnitName: string;
  quantity: number;
  conversionToBase: number;
  baseQty: number;
  unitPriceXof: number;
  unitCostXof: number;
  lineTotalXof: number;
}

export interface SalePayment {
  id: string;
  paymentNumber: string;
  paymentMethod: CustomerPaymentMethod;
  amountXof: number;
  externalReference: string | null;
  createdAt: string;
}

export interface Sale {
  id: string;
  saleNumber: string;
  idempotencyKey: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  priceTier: PriceTier;
  subtotalXof: number;
  discountXof: number;
  consignmentTotalXof: number;
  totalPayableXof: number;
  paidAmountXof: number;
  creditAmountXof: number;
  status: 'VALIDATED' | 'CANCELLED';
  dueAt: string | null;
  note: string | null;
  cancelledAt: string | null;
  cancelledByUserName: string | null;
  cancelReason: string | null;
  userId: string;
  userName: string;
  createdAt: string;
  items: SaleItem[];
  payments: SalePayment[];
}

export interface CreateSaleLineInput {
  productId: string;
  unitId: string;
  quantity: number;
  applyConsignment?: boolean;
}

export interface CreateSalePaymentLineInput {
  paymentMethod: CustomerPaymentMethod;
  amountXof: number;
  externalReference?: string | null;
}

export interface CreateSaleInput {
  idempotencyKey: string;
  customerId?: string | null;
  priceTier: PriceTier;
  discountXof?: number;
  note?: string | null;
  items: CreateSaleLineInput[];
  payments: CreateSalePaymentLineInput[];
}
