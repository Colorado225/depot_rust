export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'VALIDATED'
  | 'PARTIAL_RECEIVED'
  | 'RECEIVED'
  | 'CANCELLED';

export type PaymentMethod =
  | 'CASH'
  | 'ORANGE_MONEY'
  | 'MTN_MOMO'
  | 'MOOV_MONEY'
  | 'WAVE'
  | 'BANK_TRANSFER';

export interface PurchaseItem {
  id: string;
  purchaseOrderId: string;
  productId: string;
  productSku: string;
  productName: string;
  unitId: string;
  unitName: string;
  baseUnitName: string;
  orderedQty: number;
  receivedQty: number;
  remainingQty: number;
  conversionToBase: number;
  unitCostXof: number;
  lineTotalXof: number;
}

export interface PurchaseOrder {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  totalAmountXof: number;
  receivedAmountXof: number;
  paidAmountXof: number;
  remainingToPayOnReceivedXof: number;
  remainingToPayOnOrderXof: number;
  note: string | null;
  userId: string;
  userName: string;
  orderedAt: string;
  createdAt: string;
  updatedAt: string;
  receiptsCount: number;
  items: PurchaseItem[];
}

export interface GoodsReceiptItem {
  id: string;
  goodsReceiptId: string;
  purchaseItemId: string;
  productId: string;
  productSku: string;
  productName: string;
  receivedQty: number;
  baseQty: number;
  unitCostXof: number;
}

export interface GoodsReceipt {
  id: string;
  receiptNumber: string;
  purchaseOrderId: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceRef: string | null;
  totalReceivedXof: number;
  userId: string;
  userName: string;
  receivedAt: string;
  note: string | null;
  items: GoodsReceiptItem[];
}

export interface SupplierPayment {
  id: string;
  paymentNumber: string;
  supplierId: string;
  supplierName: string;
  paymentMethod: PaymentMethod;
  amountXof: number;
  externalReference: string | null;
  purchaseOrderId: string | null;
  orderNumber: string | null;
  userId: string;
  userName: string;
  createdAt: string;
}
