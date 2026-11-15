export type ReportDataset =
  | 'margins'
  | 'sales'
  | 'receivables'
  | 'payables'
  | 'expenses'
  | 'consignments';

export interface ReportsOverview {
  startDate: string | null;
  endDate: string | null;
  salesCount: number;
  cancelledSalesCount: number;
  cancelledAmountXof: number;
  salesGrossSubtotalXof: number;
  salesDiscountXof: number;
  salesRevenueXof: number;
  cogsXof: number;
  grossMarginXof: number;
  grossMarginRateTenths: number;
  expensesXof: number;
  breakageLossCostXof: number;
  operatingResultXof: number;
  salesPaidXof: number;
  salesCreditXof: number;
  consignmentOnSalesXof: number;
}

export interface ProductMarginRow {
  productId: string;
  sku: string;
  productName: string;
  categoryName: string;
  qtySoldBase: number;
  grossSalesXof: number;
  cogsXof: number;
  grossMarginXof: number;
  marginRateTenths: number;
  currentStockBase: number;
  weightedAvgCostXof: number;
  stockValuationCumpXof: number;
}

export interface BalanceSnapshot {
  totalStockValuationXof: number;
  activeProductsCount: number;
  lowStockProductsCount: number;
  totalCustomerReceivablesXof: number;
  totalSupplierPayablesXof: number;
  depotBottlesQty: number;
  depotCratesQty: number;
  depotConsignmentValueXof: number;
  customerConsignmentQty: number;
  customerConsignmentValueXof: number;
  supplierConsignmentQty: number;
  supplierConsignmentValueXof: number;
  topDebtors: Array<{
    id: string;
    fullName: string;
    phone: string | null;
    commercialDebtXof: number;
    consignmentBalanceXof: number;
  }>;
  topCreditors: Array<{
    id: string;
    name: string;
    phone: string | null;
    balanceDueXof: number;
  }>;
}

export interface DailySeriesPoint {
  date: string;
  salesRevenueXof: number;
  cogsXof: number;
  grossMarginXof: number;
  expensesXof: number;
}
