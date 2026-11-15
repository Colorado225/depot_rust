export type SupplierType = 'BRASSERIE' | 'DISTRIBUTEUR' | 'IMPORTATEUR' | 'AUTRE';

export interface Supplier {
  id: string;
  name: string;
  supplierType: SupplierType;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxId: string | null;
  paymentTermsDays: number;
  notes: string | null;
  balanceDueXof: number;
  linkedProductsCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
