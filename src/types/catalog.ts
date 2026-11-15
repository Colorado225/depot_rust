export interface Category {
  id: string;
  name: string;
  description: string | null;
  productCount: number;
  createdAt: string;
}

export interface Brand {
  id: string;
  name: string;
  productCount: number;
  createdAt: string;
}

export interface Unit {
  id: string;
  code: string;
  name: string;
  isBaseUnit: boolean;
}

export interface PackagingType {
  id: string;
  code: string;
  name: string;
  kind: 'BOTTLE' | 'CRATE' | 'OTHER';
  depositAmountXof: number;
  createdAt: string;
}

export interface ProductUnit {
  id: string;
  productId: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  conversionToBase: number;
  wholesalePriceXof: number;
  retailPriceXof: number;
  barcode: string | null;
  isDefaultSaleUnit: boolean;
}

export interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  brandId: string | null;
  brandName: string | null;
  preferredSupplierId: string | null;
  preferredSupplierName: string | null;
  formatLabel: string | null;
  baseUnitId: string;
  baseUnitName: string;
  bottlePackagingTypeId: string | null;
  bottlePackagingName: string | null;
  bottleDepositXof: number;
  cratePackagingTypeId: string | null;
  cratePackagingName: string | null;
  crateDepositXof: number;
  purchasePriceXof: number;
  weightedAvgCostXof: number;
  wholesalePriceXof: number;
  retailPriceXof: number;
  alertThresholdBase: number;
  stockQuantityBase: number;
  isActive: boolean;
  units: ProductUnit[];
  createdAt: string;
  updatedAt: string;
}
