import crypto from 'node:crypto';
import type { DatabaseLike } from '../db/driver.ts';
import { buildTabularPdfBuffer, type PdfColumn } from '../domain/pdfExport.ts';
import { AppError } from '../error.ts';

export type ReportDataset =
  | 'margins'
  | 'sales'
  | 'receivables'
  | 'payables'
  | 'expenses'
  | 'consignments';

export interface ReportDateRange {
  startDate?: string;
  endDate?: string;
}

export interface ReportsOverviewDTO {
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

export interface ProductMarginRowDTO {
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

export interface BalanceSnapshotDTO {
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

export interface DailySeriesPointDTO {
  date: string;
  salesRevenueXof: number;
  cogsXof: number;
  grossMarginXof: number;
  expensesXof: number;
}

function normalizeDate(val?: string): string | undefined {
  if (!val) return undefined;
  const clean = val.trim();
  if (!clean) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw new AppError('VALIDATION_ERROR', `Format de date invalide (attendu AAAA-MM-JJ) : ${clean}`, 400);
  }
  return clean;
}

function computeMarginRateTenths(revenueXof: number, marginXof: number): number {
  if (revenueXof <= 0) return 0;
  return Math.round((marginXof * 1000) / revenueXof);
}

function formatXofText(xof: number): string {
  const rounded = Math.trunc(xof);
  return `${rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

function csvCell(val: string | number | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export class ReportsRepository {
  constructor(private readonly db: DatabaseLike) {}

  private buildDatePredicate(columnExpr: string, start?: string, end?: string) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (start) {
      clauses.push(`substr(${columnExpr}, 1, 10) >= ?`);
      params.push(start);
    }
    if (end) {
      clauses.push(`substr(${columnExpr}, 1, 10) <= ?`);
      params.push(end);
    }
    return {
      sql: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
      params,
    };
  }

  getOverviewReport(range: ReportDateRange = {}): ReportsOverviewDTO {
    const startDate = normalizeDate(range.startDate);
    const endDate = normalizeDate(range.endDate);

    const salesDate = this.buildDatePredicate('s.created_at', startDate, endDate);

    const salesAgg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN s.status = 'VALIDATED' THEN 1 ELSE 0 END), 0) AS salesCount,
           COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelledSalesCount,
           COALESCE(SUM(CASE WHEN s.status = 'CANCELLED' THEN s.subtotal_xof - s.discount_xof ELSE 0 END), 0) AS cancelledAmountXof,
           COALESCE(SUM(CASE WHEN s.status = 'VALIDATED' THEN s.subtotal_xof ELSE 0 END), 0) AS salesGrossSubtotalXof,
           COALESCE(SUM(CASE WHEN s.status = 'VALIDATED' THEN s.discount_xof ELSE 0 END), 0) AS salesDiscountXof,
           COALESCE(SUM(CASE WHEN s.status = 'VALIDATED' THEN s.subtotal_xof - s.discount_xof ELSE 0 END), 0) AS salesRevenueXof,
           COALESCE(SUM(CASE WHEN s.status = 'VALIDATED' THEN s.paid_amount_xof ELSE 0 END), 0) AS salesPaidXof,
           COALESCE(SUM(CASE WHEN s.status = 'VALIDATED' THEN s.credit_amount_xof ELSE 0 END), 0) AS salesCreditXof,
           COALESCE(SUM(CASE WHEN s.status = 'VALIDATED' THEN s.consignment_total_xof ELSE 0 END), 0) AS consignmentOnSalesXof
         FROM sales s
         WHERE ${salesDate.sql}`
      )
      .get(...salesDate.params) as {
      salesCount: number;
      cancelledSalesCount: number;
      cancelledAmountXof: number;
      salesGrossSubtotalXof: number;
      salesDiscountXof: number;
      salesRevenueXof: number;
      salesPaidXof: number;
      salesCreditXof: number;
      consignmentOnSalesXof: number;
    };

    const cogsRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(si.base_qty * si.unit_cost_xof), 0) AS cogsXof
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.status = 'VALIDATED' AND ${salesDate.sql}`
      )
      .get(...salesDate.params) as { cogsXof: number };

    const expDate = this.buildDatePredicate('e.expense_date', startDate, endDate);
    const expRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(e.amount_xof), 0) AS expensesXof
         FROM expenses e
         WHERE ${expDate.sql}`
      )
      .get(...expDate.params) as { expensesXof: number };

    const lossDate = this.buildDatePredicate('sm.created_at', startDate, endDate);
    const lossRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(ABS(sm.quantity_delta_base) * sm.unit_cost_xof), 0) AS breakageLossCostXof
         FROM stock_movements sm
         WHERE sm.movement_type IN ('BREAKAGE', 'LOSS') AND ${lossDate.sql}`
      )
      .get(...lossDate.params) as { breakageLossCostXof: number };

    const grossMarginXof = salesAgg.salesRevenueXof - cogsRow.cogsXof;
    const operatingResultXof =
      grossMarginXof - expRow.expensesXof - lossRow.breakageLossCostXof;

    return {
      startDate: startDate ?? null,
      endDate: endDate ?? null,
      salesCount: salesAgg.salesCount,
      cancelledSalesCount: salesAgg.cancelledSalesCount,
      cancelledAmountXof: salesAgg.cancelledAmountXof,
      salesGrossSubtotalXof: salesAgg.salesGrossSubtotalXof,
      salesDiscountXof: salesAgg.salesDiscountXof,
      salesRevenueXof: salesAgg.salesRevenueXof,
      cogsXof: cogsRow.cogsXof,
      grossMarginXof,
      grossMarginRateTenths: computeMarginRateTenths(salesAgg.salesRevenueXof, grossMarginXof),
      expensesXof: expRow.expensesXof,
      breakageLossCostXof: lossRow.breakageLossCostXof,
      operatingResultXof,
      salesPaidXof: salesAgg.salesPaidXof,
      salesCreditXof: salesAgg.salesCreditXof,
      consignmentOnSalesXof: salesAgg.consignmentOnSalesXof,
    };
  }

  getProductMargins(range: ReportDateRange = {}): ProductMarginRowDTO[] {
    const startDate = normalizeDate(range.startDate);
    const endDate = normalizeDate(range.endDate);
    const salesDate = this.buildDatePredicate('s.created_at', startDate, endDate);

    const rows = this.db
      .prepare(
        `SELECT
           p.id AS productId,
           p.sku,
           p.name AS productName,
           COALESCE(c.name, 'Sans catégorie') AS categoryName,
           COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN si.base_qty ELSE 0 END), 0) AS qtySoldBase,
           COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN si.line_total_xof ELSE 0 END), 0) AS grossSalesXof,
           COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN si.base_qty * si.unit_cost_xof ELSE 0 END), 0) AS cogsXof,
           COALESCE(sb.quantity_base, 0) AS currentStockBase,
           p.weighted_avg_cost_xof AS weightedAvgCostXof
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN stock_balances sb ON sb.product_id = p.id
         LEFT JOIN sale_items si ON si.product_id = p.id
         LEFT JOIN sales s ON s.id = si.sale_id AND s.status = 'VALIDATED' AND ${salesDate.sql}
         WHERE p.is_active = 1 OR si.id IS NOT NULL
         GROUP BY p.id, p.sku, p.name, categoryName, sb.quantity_base, p.weighted_avg_cost_xof
         HAVING qtySoldBase > 0 OR currentStockBase > 0
         ORDER BY grossSalesXof DESC, p.name ASC`
      )
      .all(...salesDate.params) as Array<{
      productId: string;
      sku: string;
      productName: string;
      categoryName: string;
      qtySoldBase: number;
      grossSalesXof: number;
      cogsXof: number;
      currentStockBase: number;
      weightedAvgCostXof: number;
    }>;

    return rows.map((r) => {
      const grossMarginXof = r.grossSalesXof - r.cogsXof;
      return {
        ...r,
        grossMarginXof,
        marginRateTenths: computeMarginRateTenths(r.grossSalesXof, grossMarginXof),
        stockValuationCumpXof: r.currentStockBase * r.weightedAvgCostXof,
      };
    });
  }

  getSnapshot(): BalanceSnapshotDTO {
    const stockAgg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(COALESCE(sb.quantity_base, 0) * p.weighted_avg_cost_xof), 0) AS totalStockValuationXof,
           COUNT(CASE WHEN p.is_active = 1 THEN 1 END) AS activeProductsCount,
           COUNT(CASE WHEN p.is_active = 1 AND COALESCE(sb.quantity_base, 0) <= p.alert_threshold_base THEN 1 END) AS lowStockProductsCount
         FROM products p
         LEFT JOIN stock_balances sb ON sb.product_id = p.id`
      )
      .get() as {
      totalStockValuationXof: number;
      activeProductsCount: number;
      lowStockProductsCount: number;
    };

    const recRow = this.db
      .prepare('SELECT COALESCE(SUM(commercial_debt_xof), 0) AS total FROM customers')
      .get() as { total: number };

    const payRow = this.db
      .prepare('SELECT COALESCE(SUM(balance_due_xof), 0) AS total FROM suppliers')
      .get() as { total: number };

    const consRows = this.db
      .prepare(
        `SELECT cb.holder_type AS holderType, pt.kind AS packagingKind,
                COALESCE(SUM(cb.quantity), 0) AS qty,
                COALESCE(SUM(cb.deposit_value_xof), 0) AS valueXof
         FROM consignment_balances cb
         JOIN packaging_types pt ON pt.id = cb.packaging_type_id
         GROUP BY cb.holder_type, pt.kind`
      )
      .all() as Array<{
      holderType: 'DEPOT' | 'CUSTOMER' | 'SUPPLIER';
      packagingKind: 'BOTTLE' | 'CRATE' | 'OTHER';
      qty: number;
      valueXof: number;
    }>;

    let depotBottlesQty = 0;
    let depotCratesQty = 0;
    let depotConsignmentValueXof = 0;
    let customerConsignmentQty = 0;
    let customerConsignmentValueXof = 0;
    let supplierConsignmentQty = 0;
    let supplierConsignmentValueXof = 0;

    for (const r of consRows) {
      if (r.holderType === 'DEPOT') {
        if (r.packagingKind === 'BOTTLE') depotBottlesQty += r.qty;
        if (r.packagingKind === 'CRATE') depotCratesQty += r.qty;
        depotConsignmentValueXof += r.valueXof;
      } else if (r.holderType === 'CUSTOMER') {
        customerConsignmentQty += r.qty;
        customerConsignmentValueXof += r.valueXof;
      } else if (r.holderType === 'SUPPLIER') {
        supplierConsignmentQty += r.qty;
        supplierConsignmentValueXof += r.valueXof;
      }
    }

    const topDebtors = this.db
      .prepare(
        `SELECT c.id,
                c.full_name AS fullName,
                c.phone,
                c.commercial_debt_xof AS commercialDebtXof,
                COALESCE((
                  SELECT SUM(cb.deposit_value_xof)
                  FROM consignment_balances cb
                  WHERE cb.holder_type = 'CUSTOMER' AND cb.holder_id = c.id
                ), 0) AS consignmentBalanceXof
         FROM customers c
         WHERE c.commercial_debt_xof > 0
            OR EXISTS (SELECT 1 FROM consignment_balances cb WHERE cb.holder_type = 'CUSTOMER' AND cb.holder_id = c.id AND cb.quantity > 0)
         ORDER BY c.commercial_debt_xof DESC, consignmentBalanceXof DESC, c.full_name ASC
         LIMIT 50`
      )
      .all() as BalanceSnapshotDTO['topDebtors'];

    const topCreditors = this.db
      .prepare(
        `SELECT id, name, phone, balance_due_xof AS balanceDueXof
         FROM suppliers
         WHERE balance_due_xof > 0
         ORDER BY balance_due_xof DESC, name ASC
         LIMIT 50`
      )
      .all() as BalanceSnapshotDTO['topCreditors'];

    return {
      ...stockAgg,
      totalCustomerReceivablesXof: recRow.total,
      totalSupplierPayablesXof: payRow.total,
      depotBottlesQty,
      depotCratesQty,
      depotConsignmentValueXof,
      customerConsignmentQty,
      customerConsignmentValueXof,
      supplierConsignmentQty,
      supplierConsignmentValueXof,
      topDebtors,
      topCreditors,
    };
  }

  getDailySeries(range: ReportDateRange = {}): DailySeriesPointDTO[] {
    const startDate = normalizeDate(range.startDate);
    const endDate = normalizeDate(range.endDate);
    const salesDate = this.buildDatePredicate('s.created_at', startDate, endDate);
    const expDate = this.buildDatePredicate('e.expense_date', startDate, endDate);

    const salesRows = this.db
      .prepare(
        `SELECT substr(s.created_at, 1, 10) AS day,
                COALESCE(SUM(s.subtotal_xof - s.discount_xof), 0) AS salesRevenueXof,
                COALESCE((
                  SELECT SUM(si.base_qty * si.unit_cost_xof)
                  FROM sale_items si
                  JOIN sales s2 ON s2.id = si.sale_id
                  WHERE s2.status = 'VALIDATED' AND substr(s2.created_at, 1, 10) = substr(s.created_at, 1, 10)
                ), 0) AS cogsXof
         FROM sales s
         WHERE s.status = 'VALIDATED' AND ${salesDate.sql}
         GROUP BY day`
      )
      .all(...salesDate.params) as Array<{
      day: string;
      salesRevenueXof: number;
      cogsXof: number;
    }>;

    const expRows = this.db
      .prepare(
        `SELECT substr(e.expense_date, 1, 10) AS day,
                COALESCE(SUM(e.amount_xof), 0) AS expensesXof
         FROM expenses e
         WHERE ${expDate.sql}
         GROUP BY day`
      )
      .all(...expDate.params) as Array<{ day: string; expensesXof: number }>;

    const byDay = new Map<string, DailySeriesPointDTO>();

    for (const s of salesRows) {
      byDay.set(s.day, {
        date: s.day,
        salesRevenueXof: s.salesRevenueXof,
        cogsXof: s.cogsXof,
        grossMarginXof: s.salesRevenueXof - s.cogsXof,
        expensesXof: 0,
      });
    }

    for (const e of expRows) {
      const existing = byDay.get(e.day);
      if (existing) {
        existing.expensesXof += e.expensesXof;
      } else {
        byDay.set(e.day, {
          date: e.day,
          salesRevenueXof: 0,
          cogsXof: 0,
          grossMarginXof: 0,
          expensesXof: e.expensesXof,
        });
      }
    }

    return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  exportDataset(
    actorUserId: string,
    opts: {
      dataset: ReportDataset;
      format: 'csv' | 'pdf';
      startDate?: string;
      endDate?: string;
    }
  ): { filename: string; mimeType: string; buffer: Buffer } {
    const startDate = normalizeDate(opts.startDate);
    const endDate = normalizeDate(opts.endDate);
    const periodLabel =
      startDate || endDate
        ? `Période : ${startDate ?? 'Début'} au ${endDate ?? 'Aujourd’hui'}`
        : 'Période : Toutes les écritures';
    const stamp = new Date().toISOString().slice(0, 10);

    let title = '';
    let headers: string[] = [];
    let pdfColumns: PdfColumn[] = [];
    let rawRows: Array<Array<string | number>> = [];
    let pdfRows: string[][] = [];
    let footerLines: string[] = [];

    if (opts.dataset === 'margins') {
      title = 'Rapport Marges Réelles (CUMP) par Produit';
      const data = this.getProductMargins({ startDate, endDate });
      headers = [
        'SKU',
        'Produit',
        'Catégorie',
        'Qté vendue (base)',
        'CA Brut (FCFA)',
        'Coût CUMP (FCFA)',
        'Marge Brute (FCFA)',
        'Taux Marge (%)',
        'Stock Actuel (base)',
        'Valorisation Stock CUMP (FCFA)',
      ];
      pdfColumns = [
        { header: 'SKU', widthChars: 12 },
        { header: 'Produit', widthChars: 24 },
        { header: 'Qte', widthChars: 7, align: 'right' },
        { header: 'CA Brut', widthChars: 15, align: 'right' },
        { header: 'Cout CUMP', widthChars: 15, align: 'right' },
        { header: 'Marge', widthChars: 15, align: 'right' },
        { header: 'Taux', widthChars: 7, align: 'right' },
        { header: 'Val. Stock', widthChars: 16, align: 'right' },
      ];
      rawRows = data.map((r) => [
        r.sku,
        r.productName,
        r.categoryName,
        r.qtySoldBase,
        r.grossSalesXof,
        r.cogsXof,
        r.grossMarginXof,
        (r.marginRateTenths / 10).toFixed(1),
        r.currentStockBase,
        r.stockValuationCumpXof,
      ]);
      pdfRows = data.map((r) => [
        r.sku,
        r.productName,
        String(r.qtySoldBase),
        formatXofText(r.grossSalesXof),
        formatXofText(r.cogsXof),
        formatXofText(r.grossMarginXof),
        `${(r.marginRateTenths / 10).toFixed(1)}%`,
        formatXofText(r.stockValuationCumpXof),
      ]);
      const sumCa = data.reduce((a, b) => a + b.grossSalesXof, 0);
      const sumCogs = data.reduce((a, b) => a + b.cogsXof, 0);
      const sumMargin = data.reduce((a, b) => a + b.grossMarginXof, 0);
      const sumStock = data.reduce((a, b) => a + b.stockValuationCumpXof, 0);
      footerLines = [
        `TOTAL CA Brut: ${formatXofText(sumCa)} | COGS CUMP: ${formatXofText(
          sumCogs
        )} | Marge Brute: ${formatXofText(sumMargin)} | Valorisation Stock: ${formatXofText(sumStock)}`,
      ];
    } else if (opts.dataset === 'sales') {
      title = 'Journal des Ventes & Marges Réalisées';
      const salesDate = this.buildDatePredicate('s.created_at', startDate, endDate);
      const rows = this.db
        .prepare(
          `SELECT s.sale_number AS saleNumber,
                  s.created_at AS createdAt,
                  COALESCE(c.full_name, 'Client comptoir') AS customerName,
                  s.status,
                  s.subtotal_xof AS subtotalXof,
                  s.discount_xof AS discountXof,
                  (s.subtotal_xof - s.discount_xof) AS netRevenueXof,
                  COALESCE((SELECT SUM(si.base_qty * si.unit_cost_xof) FROM sale_items si WHERE si.sale_id = s.id), 0) AS cogsXof,
                  s.consignment_total_xof AS consignmentXof,
                  s.paid_amount_xof AS paidXof,
                  s.credit_amount_xof AS creditXof
           FROM sales s
           LEFT JOIN customers c ON c.id = s.customer_id
           WHERE ${salesDate.sql}
           ORDER BY s.created_at DESC`
        )
        .all(...salesDate.params) as Array<{
        saleNumber: string;
        createdAt: string;
        customerName: string;
        status: string;
        subtotalXof: number;
        discountXof: number;
        netRevenueXof: number;
        cogsXof: number;
        consignmentXof: number;
        paidXof: number;
        creditXof: number;
      }>;

      headers = [
        'N° Vente',
        'Date',
        'Client',
        'Statut',
        'CA Net Liquide (FCFA)',
        'Coût CUMP (FCFA)',
        'Marge (FCFA)',
        'Consignes (FCFA)',
        'Encaissé (FCFA)',
        'Crédit (FCFA)',
      ];
      pdfColumns = [
        { header: 'N° Vente', widthChars: 18 },
        { header: 'Date', widthChars: 10 },
        { header: 'Client', widthChars: 20 },
        { header: 'Statut', widthChars: 10 },
        { header: 'CA Net', widthChars: 14, align: 'right' },
        { header: 'CUMP', widthChars: 14, align: 'right' },
        { header: 'Marge', widthChars: 14, align: 'right' },
        { header: 'Credit', widthChars: 14, align: 'right' },
      ];
      rawRows = rows.map((r) => [
        r.saleNumber,
        r.createdAt.slice(0, 10),
        r.customerName,
        r.status,
        r.netRevenueXof,
        r.cogsXof,
        r.netRevenueXof - r.cogsXof,
        r.consignmentXof,
        r.paidXof,
        r.creditXof,
      ]);
      pdfRows = rows.map((r) => [
        r.saleNumber,
        r.createdAt.slice(0, 10),
        r.customerName,
        r.status,
        formatXofText(r.netRevenueXof),
        formatXofText(r.cogsXof),
        formatXofText(r.netRevenueXof - r.cogsXof),
        formatXofText(r.creditXof),
      ]);
    } else if (opts.dataset === 'receivables') {
      title = 'État des Créances Clients & Consignes Détenues';
      const snap = this.getSnapshot();
      headers = ['Client', 'Téléphone', 'Créance Commerciale (FCFA)', 'Consignes Emballages (FCFA)'];
      pdfColumns = [
        { header: 'Client', widthChars: 34 },
        { header: 'Telephone', widthChars: 18 },
        { header: 'Creance Commerciale', widthChars: 22, align: 'right' },
        { header: 'Solde Consignes', widthChars: 22, align: 'right' },
      ];
      rawRows = snap.topDebtors.map((d) => [
        d.fullName,
        d.phone ?? '',
        d.commercialDebtXof,
        d.consignmentBalanceXof,
      ]);
      pdfRows = snap.topDebtors.map((d) => [
        d.fullName,
        d.phone ?? '-',
        formatXofText(d.commercialDebtXof),
        formatXofText(d.consignmentBalanceXof),
      ]);
      footerLines = [
        `TOTAL Créances Commerciales: ${formatXofText(
          snap.totalCustomerReceivablesXof
        )} | TOTAL Consignes Clients: ${formatXofText(snap.customerConsignmentValueXof)}`,
      ];
    } else if (opts.dataset === 'payables') {
      title = 'État des Dettes Fournisseurs';
      const snap = this.getSnapshot();
      headers = ['Fournisseur', 'Téléphone', 'Dette Commerciale Due (FCFA)'];
      pdfColumns = [
        { header: 'Fournisseur', widthChars: 42 },
        { header: 'Telephone', widthChars: 22 },
        { header: 'Dette Due (FCFA)', widthChars: 24, align: 'right' },
      ];
      rawRows = snap.topCreditors.map((s) => [s.name, s.phone ?? '', s.balanceDueXof]);
      pdfRows = snap.topCreditors.map((s) => [s.name, s.phone ?? '-', formatXofText(s.balanceDueXof)]);
      footerLines = [`TOTAL Dettes Fournisseurs: ${formatXofText(snap.totalSupplierPayablesXof)}`];
    } else if (opts.dataset === 'expenses') {
      title = 'Journal des Dépenses Opérationnelles';
      const expDate = this.buildDatePredicate('ex.expense_date', startDate, endDate);
      const rows = this.db
        .prepare(
          `SELECT ex.expense_date AS expenseDate,
                  ec.name AS categoryName,
                  ex.description,
                  ex.payment_method AS paymentMethod,
                  ex.receipt_reference AS receiptReference,
                  ex.amount_xof AS amountXof
           FROM expenses ex
           JOIN expense_categories ec ON ec.id = ex.category_id
           WHERE ${expDate.sql}
           ORDER BY ex.expense_date DESC, ex.created_at DESC`
        )
        .all(...expDate.params) as Array<{
        expenseDate: string;
        categoryName: string;
        description: string;
        paymentMethod: string;
        receiptReference: string | null;
        amountXof: number;
      }>;
      headers = ['Date', 'Catégorie', 'Description', 'Mode', 'Justificatif', 'Montant (FCFA)'];
      pdfColumns = [
        { header: 'Date', widthChars: 11 },
        { header: 'Categorie', widthChars: 22 },
        { header: 'Description', widthChars: 34 },
        { header: 'Canal', widthChars: 15 },
        { header: 'Ref', widthChars: 12 },
        { header: 'Montant', widthChars: 16, align: 'right' },
      ];
      rawRows = rows.map((r) => [
        r.expenseDate,
        r.categoryName,
        r.description,
        r.paymentMethod,
        r.receiptReference ?? '',
        r.amountXof,
      ]);
      pdfRows = rows.map((r) => [
        r.expenseDate,
        r.categoryName,
        r.description,
        r.paymentMethod,
        r.receiptReference ?? '-',
        formatXofText(r.amountXof),
      ]);
      const sumExp = rows.reduce((a, b) => a + b.amountXof, 0);
      footerLines = [`TOTAL Dépenses: ${formatXofText(sumExp)}`];
    } else {
      title = 'État des Consignes & Emballages Vides';
      const rows = this.db
        .prepare(
          `SELECT cb.holder_type AS holderType,
                  CASE
                    WHEN cb.holder_type = 'DEPOT' THEN 'Dépôt (Vides)'
                    WHEN cb.holder_type = 'CUSTOMER' THEN COALESCE(c.full_name, 'Client')
                    WHEN cb.holder_type = 'SUPPLIER' THEN COALESCE(s.name, 'Fournisseur')
                    ELSE cb.holder_id
                  END AS holderName,
                  pt.name AS packagingName,
                  pt.kind AS packagingKind,
                  cb.quantity,
                  cb.deposit_value_xof AS depositValueXof
           FROM consignment_balances cb
           JOIN packaging_types pt ON pt.id = cb.packaging_type_id
           LEFT JOIN customers c ON cb.holder_type = 'CUSTOMER' AND c.id = cb.holder_id
           LEFT JOIN suppliers s ON cb.holder_type = 'SUPPLIER' AND s.id = cb.holder_id
           WHERE cb.quantity != 0
           ORDER BY cb.holder_type ASC, holderName ASC, pt.kind ASC`
        )
        .all() as Array<{
        holderType: string;
        holderName: string;
        packagingName: string;
        packagingKind: string;
        quantity: number;
        depositValueXof: number;
      }>;
      headers = ['Type Titulaire', 'Titulaire', 'Emballage', 'Catégorie', 'Quantité', 'Valeur (FCFA)'];
      pdfColumns = [
        { header: 'Type', widthChars: 10 },
        { header: 'Titulaire', widthChars: 30 },
        { header: 'Emballage', widthChars: 24 },
        { header: 'Categorie', widthChars: 10 },
        { header: 'Qte', widthChars: 8, align: 'right' },
        { header: 'Valeur', widthChars: 18, align: 'right' },
      ];
      rawRows = rows.map((r) => [
        r.holderType,
        r.holderName,
        r.packagingName,
        r.packagingKind,
        r.quantity,
        r.depositValueXof,
      ]);
      pdfRows = rows.map((r) => [
        r.holderType,
        r.holderName,
        r.packagingName,
        r.packagingKind,
        String(r.quantity),
        formatXofText(r.depositValueXof),
      ]);
    }

    this.db
      .prepare(
        `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, 'REPORT_EXPORTED', 'reports', ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        actorUserId,
        opts.dataset,
        JSON.stringify({
          dataset: opts.dataset,
          format: opts.format,
          startDate: startDate ?? null,
          endDate: endDate ?? null,
        })
      );

    if (opts.format === 'csv') {
      const csvLines = [
        headers.map(csvCell).join(';'),
        ...rawRows.map((row) => row.map(csvCell).join(';')),
      ];
      const csvString = '\uFEFF' + csvLines.join('\r\n');
      return {
        filename: `depotpro-${opts.dataset}-${stamp}.csv`,
        mimeType: 'text/csv; charset=utf-8',
        buffer: Buffer.from(csvString, 'utf8'),
      };
    }

    const pdfBuffer = buildTabularPdfBuffer({
      title: `DepotPro CI — ${title}`,
      subtitle: periodLabel,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      columns: pdfColumns,
      rows: pdfRows,
      footerLines,
    });

    return {
      filename: `depotpro-${opts.dataset}-${stamp}.pdf`,
      mimeType: 'application/pdf',
      buffer: pdfBuffer,
    };
  }
}
