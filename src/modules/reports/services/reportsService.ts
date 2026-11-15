import { useQuery } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type {
  BalanceSnapshot,
  DailySeriesPoint,
  ProductMarginRow,
  ReportDataset,
  ReportsOverview,
} from '@/src/types/reports';

export const REPORT_DATASET_LABELS: Record<ReportDataset, string> = {
  margins: 'Marges réelles CUMP par produit',
  sales: 'Journal des ventes & marges',
  receivables: 'Créances clients & consignes',
  payables: 'Dettes fournisseurs',
  expenses: 'Dépenses opérationnelles',
  consignments: 'Soldes emballages consignés',
};

export function useReportsOverview(range: { startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: ['reports', 'overview', range],
    queryFn: () => invokeBackend<ReportsOverview>('reports_overview', range),
  });
}

export function useProductMargins(range: { startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: ['reports', 'product-margins', range],
    queryFn: () => invokeBackend<ProductMarginRow[]>('reports_product_margins', range),
  });
}

export function useBalanceSnapshot() {
  return useQuery({
    queryKey: ['reports', 'snapshot'],
    queryFn: () => invokeBackend<BalanceSnapshot>('reports_snapshot'),
  });
}

export function useDailySeries(range: { startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: ['reports', 'daily', range],
    queryFn: () => invokeBackend<DailySeriesPoint[]>('reports_daily', range),
  });
}
