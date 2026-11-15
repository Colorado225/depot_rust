export interface BusinessSettings {
  id: string;
  depotName: string;
  ownerName: string;
  phone: string | null;
  address: string | null;
  logoPath: string | null;
  currency: 'XOF';
  receiptHeader: string | null;
  receiptFooter: string | null;
  defaultConsignmentPolicy: 'SEPARATE_TRACKING' | 'AUTO_INCLUDE_CRATES';
  allowNegativeStock: boolean;
  defaultCashFloatXof: number;
  receiptPrintWidth: '58mm' | '80mm';
  isInitialized: boolean;
  updatedAt: string;
}
