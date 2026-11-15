import type { CustomerPaymentMethod } from './customer';

export type ConsignmentHolderType = 'DEPOT' | 'CUSTOMER' | 'SUPPLIER';
export type ConsignmentMovementType =
  | 'SALE_DEPOSIT'
  | 'CUSTOMER_RETURN'
  | 'REFUND'
  | 'EXCHANGE'
  | 'SUPPLIER_DEPOSIT'
  | 'SUPPLIER_RETURN'
  | 'BREAKAGE'
  | 'LOSS';

export interface ConsignmentBalance {
  id: string;
  holderType: ConsignmentHolderType;
  holderId: string;
  holderName: string;
  packagingTypeId: string;
  packagingCode: string;
  packagingName: string;
  packagingKind: 'BOTTLE' | 'CRATE' | 'OTHER';
  depositAmountXof: number;
  quantity: number;
  depositValueXof: number;
  updatedAt: string;
}

export interface ConsignmentMovement {
  id: string;
  packagingTypeId: string;
  packagingCode: string;
  packagingName: string;
  packagingKind: 'BOTTLE' | 'CRATE' | 'OTHER';
  movementType: ConsignmentMovementType;
  holderType: ConsignmentHolderType;
  holderId: string;
  holderName: string;
  quantityDelta: number;
  amountXof: number;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface ConsignmentSummary {
  depotBottlesQty: number;
  depotCratesQty: number;
  depotTotalValueXof: number;
  customerQty: number;
  customerValueXof: number;
  supplierQty: number;
  supplierValueXof: number;
}

export interface CustomerConsignmentReturnInput {
  customerId: string;
  packagingTypeId: string;
  quantity: number;
  refundCustomer: boolean;
  paymentMethod?: CustomerPaymentMethod;
  externalReference?: string | null;
  note?: string | null;
}

export interface CustomerConsignmentOperationInput {
  customerId: string;
  packagingTypeId: string;
  quantity: number;
  operation: 'SALE_DEPOSIT' | 'EXCHANGE' | 'BREAKAGE' | 'LOSS';
  note?: string | null;
}

export interface SupplierConsignmentOperationInput {
  supplierId: string;
  packagingTypeId: string;
  quantity: number;
  operation: 'SUPPLIER_DEPOSIT' | 'SUPPLIER_RETURN';
  note?: string | null;
}

export interface DepotPackagingOperationInput {
  packagingTypeId: string;
  quantity: number;
  operation: 'EXCHANGE' | 'BREAKAGE' | 'LOSS';
  note?: string | null;
}
