export type ManualStockMovementType =
  | 'INITIAL'
  | 'MANUAL_IN'
  | 'MANUAL_OUT'
  | 'BREAKAGE'
  | 'LOSS';

export interface StockBalanceItem {
  productId: string;
  sku: string;
  name: string;
  categoryName: string | null;
  baseUnitId: string;
  baseUnitName: string;
  quantityBase: number;
  damagedQuantityBase: number;
  alertThresholdBase: number;
  isLowStock: boolean;
  weightedAvgCostXof: number;
  totalValuationXof: number;
  updatedAt: string;
}

export interface StockMovement {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  baseUnitName: string;
  movementType: string;
  quantityDeltaBase: number;
  unitCostXof: number;
  balanceAfterBase: number;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface StockInventorySummary {
  id: string;
  inventoryNumber: string;
  status: 'DRAFT' | 'VALIDATED';
  note: string | null;
  linesCount: number;
  totalVarianceBase: number;
  createdByName: string;
  validatedByName: string | null;
  validatedAt: string | null;
  createdAt: string;
}
