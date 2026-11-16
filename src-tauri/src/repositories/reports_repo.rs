//! LOT 10 — Tranche 3, Rapports & bilan : port de
//! `server/repositories/reportsRepo.ts`.
//!
//! Vue d'ensemble, marges réelles CUMP, photographie des soldes et série
//! journalière. Les dates sont validées au format `AAAA-MM-JJ` ; les taux de
//! marge, valorisations et résultats d'exploitation sont calculés côté Rust
//! en XOF entiers. Les requêtes sont des littéraux SQLx (vérifiés par
//! `tests/lot10-rust-sql.test.ts` contre le schéma réel des 15 migrations).

use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{
    add_xof, attach, margin_rate_tenths, mul_xof, normalize_date, number, text,
};
use serde_json::{json, Value};
use sqlx::SqlitePool;

struct DateRange {
    start: Option<String>,
    end: Option<String>,
}

fn range(input: &Json) -> Result<DateRange, AppError> {
    Ok(DateRange {
        start: normalize_date(input, "startDate")?,
        end: normalize_date(input, "endDate")?,
    })
}

pub async fn overview(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let period = range(input)?;
    let sales = sqlx::query(
        "SELECT
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
         WHERE (? IS NULL OR substr(s.created_at, 1, 10) >= ?)
           AND (? IS NULL OR substr(s.created_at, 1, 10) <= ?)",
    )
    .bind(period.start.clone())
    .bind(period.start.clone())
    .bind(period.end.clone())
    .bind(period.end.clone())
    .fetch_one(pool)
    .await?;
    let sales = json::row_to_json(sales, &[]);

    let cogs = sqlx::query(
        "SELECT COALESCE(SUM(si.base_qty * si.unit_cost_xof), 0) AS cogsXof
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.status = 'VALIDATED'
           AND (? IS NULL OR substr(s.created_at, 1, 10) >= ?)
           AND (? IS NULL OR substr(s.created_at, 1, 10) <= ?)",
    )
    .bind(period.start.clone())
    .bind(period.start.clone())
    .bind(period.end.clone())
    .bind(period.end.clone())
    .fetch_one(pool)
    .await?;
    let cogs_xof = number(&json::row_to_json(cogs, &[]), "cogsXof");

    let expenses = sqlx::query(
        "SELECT COALESCE(SUM(e.amount_xof), 0) AS expensesXof
         FROM expenses e
         WHERE (? IS NULL OR substr(e.expense_date, 1, 10) >= ?)
           AND (? IS NULL OR substr(e.expense_date, 1, 10) <= ?)",
    )
    .bind(period.start.clone())
    .bind(period.start.clone())
    .bind(period.end.clone())
    .bind(period.end.clone())
    .fetch_one(pool)
    .await?;
    let expenses_xof = number(&json::row_to_json(expenses, &[]), "expensesXof");

    let loss = sqlx::query(
        "SELECT COALESCE(SUM(ABS(sm.quantity_delta_base) * sm.unit_cost_xof), 0) AS breakageLossCostXof
         FROM stock_movements sm
         WHERE sm.movement_type IN ('BREAKAGE', 'LOSS')
           AND (? IS NULL OR substr(sm.created_at, 1, 10) >= ?)
           AND (? IS NULL OR substr(sm.created_at, 1, 10) <= ?)",
    )
    .bind(period.start.clone())
    .bind(period.start.clone())
    .bind(period.end.clone())
    .bind(period.end.clone())
    .fetch_one(pool)
    .await?;
    let breakage_xof = number(&json::row_to_json(loss, &[]), "breakageLossCostXof");

    let revenue_xof = number(&sales, "salesRevenueXof");
    let gross_margin_xof = revenue_xof - cogs_xof;
    let operating_result_xof = gross_margin_xof - expenses_xof - breakage_xof;
    let mut out = sales;
    for (key, value) in [
        (
            "startDate",
            period.start.clone().map(Value::String).unwrap_or(Value::Null),
        ),
        (
            "endDate",
            period.end.clone().map(Value::String).unwrap_or(Value::Null),
        ),
        ("cogsXof", json!(cogs_xof)),
        ("grossMarginXof", json!(gross_margin_xof)),
        (
            "grossMarginRateTenths",
            json!(margin_rate_tenths(revenue_xof, gross_margin_xof)),
        ),
        ("expensesXof", json!(expenses_xof)),
        ("breakageLossCostXof", json!(breakage_xof)),
        ("operatingResultXof", json!(operating_result_xof)),
    ] {
        out = attach(out, key, value);
    }
    Ok(out)
}

pub async fn product_margins(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let period = range(input)?;
    let rows = sqlx::query(
        "SELECT
           p.id AS productId, p.sku, p.name AS productName,
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
         LEFT JOIN sales s ON s.id = si.sale_id AND s.status = 'VALIDATED'
           AND (? IS NULL OR substr(s.created_at, 1, 10) >= ?)
           AND (? IS NULL OR substr(s.created_at, 1, 10) <= ?)
         WHERE p.is_active = 1 OR si.id IS NOT NULL
         GROUP BY p.id, p.sku, p.name, categoryName, sb.quantity_base, p.weighted_avg_cost_xof
         HAVING qtySoldBase > 0 OR currentStockBase > 0
         ORDER BY grossSalesXof DESC, p.name ASC",
    )
    .bind(period.start.clone())
    .bind(period.start.clone())
    .bind(period.end.clone())
    .bind(period.end.clone())
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut dto = json::row_to_json(row, &[]);
        let revenue = number(&dto, "grossSalesXof");
        let margin = revenue - number(&dto, "cogsXof");
        let stock_valuation = mul_xof(
            number(&dto, "weightedAvgCostXof"),
            number(&dto, "currentStockBase"),
            "Valorisation stock CUMP",
        )?;
        dto = attach(dto, "grossMarginXof", json!(margin));
        dto = attach(
            dto,
            "marginRateTenths",
            json!(margin_rate_tenths(revenue, margin)),
        );
        dto = attach(dto, "stockValuationCumpXof", json!(stock_valuation));
        out.push(dto);
    }
    Ok(Value::Array(out))
}

pub async fn snapshot(pool: &SqlitePool) -> Result<Json, AppError> {
    let products = sqlx::query(
        "SELECT p.is_active, COALESCE(sb.quantity_base, 0) AS quantityBase,
                p.weighted_avg_cost_xof AS weightedAvgCostXof,
                p.alert_threshold_base AS alertThresholdBase
         FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id",
    )
    .fetch_all(pool)
    .await?;
    let mut total_stock_valuation_xof = 0_i64;
    let mut active_products_count = 0_i64;
    let mut low_stock_products_count = 0_i64;
    for row in products {
        let dto = json::row_to_json(row, &[]);
        let quantity = number(&dto, "quantityBase");
        total_stock_valuation_xof = add_xof(
            total_stock_valuation_xof,
            mul_xof(
                number(&dto, "weightedAvgCostXof"),
                quantity,
                "Valorisation stock",
            )?,
            "Valorisation stock totale",
        )?;
        if number(&dto, "isActive") == 1 {
            active_products_count += 1;
            if quantity <= number(&dto, "alertThresholdBase") {
                low_stock_products_count += 1;
            }
        }
    }

    let receivables = sqlx::query(
        "SELECT COALESCE(SUM(commercial_debt_xof), 0) AS total FROM customers",
    )
    .fetch_one(pool)
    .await?;
    let payables = sqlx::query(
        "SELECT COALESCE(SUM(balance_due_xof), 0) AS total FROM suppliers",
    )
    .fetch_one(pool)
    .await?;

    let cons_rows = sqlx::query(
        "SELECT cb.holder_type AS holderType, pt.kind AS packagingKind,
                COALESCE(SUM(cb.quantity), 0) AS qty,
                COALESCE(SUM(cb.deposit_value_xof), 0) AS valueXof
         FROM consignment_balances cb
         JOIN packaging_types pt ON pt.id = cb.packaging_type_id
         GROUP BY cb.holder_type, pt.kind",
    )
    .fetch_all(pool)
    .await?;
    let mut depot_bottles_qty = 0_i64;
    let mut depot_crates_qty = 0_i64;
    let mut depot_consignment_value_xof = 0_i64;
    let mut customer_consignment_qty = 0_i64;
    let mut customer_consignment_value_xof = 0_i64;
    let mut supplier_consignment_qty = 0_i64;
    let mut supplier_consignment_value_xof = 0_i64;
    for row in cons_rows {
        let dto = json::row_to_json(row, &[]);
        let qty = number(&dto, "qty");
        let value = number(&dto, "valueXof");
        match text(&dto, "holderType").as_deref() {
            Some("DEPOT") => {
                if text(&dto, "packagingKind").as_deref() == Some("BOTTLE") {
                    depot_bottles_qty += qty;
                }
                if text(&dto, "packagingKind").as_deref() == Some("CRATE") {
                    depot_crates_qty += qty;
                }
                depot_consignment_value_xof += value;
            }
            Some("CUSTOMER") => {
                customer_consignment_qty += qty;
                customer_consignment_value_xof += value;
            }
            Some("SUPPLIER") => {
                supplier_consignment_qty += qty;
                supplier_consignment_value_xof += value;
            }
            _ => {}
        }
    }

    let debtors = sqlx::query(
        "SELECT c.id, c.full_name AS fullName, c.phone,
                c.commercial_debt_xof AS commercialDebtXof,
                COALESCE((
                  SELECT SUM(cb.deposit_value_xof) FROM consignment_balances cb
                  WHERE cb.holder_type = 'CUSTOMER' AND cb.holder_id = c.id
                ), 0) AS consignmentBalanceXof
         FROM customers c
         WHERE c.commercial_debt_xof > 0
            OR EXISTS (SELECT 1 FROM consignment_balances cb
                       WHERE cb.holder_type = 'CUSTOMER' AND cb.holder_id = c.id
                         AND cb.quantity > 0)
         ORDER BY c.commercial_debt_xof DESC, consignmentBalanceXof DESC, c.full_name ASC
         LIMIT 50",
    )
    .fetch_all(pool)
    .await?;
    let creditors = sqlx::query(
        "SELECT id, name, phone, balance_due_xof AS balanceDueXof
         FROM suppliers WHERE balance_due_xof > 0
         ORDER BY balance_due_xof DESC, name ASC LIMIT 50",
    )
    .fetch_all(pool)
    .await?;

    Ok(json!({
        "totalStockValuationXof": total_stock_valuation_xof,
        "activeProductsCount": active_products_count,
        "lowStockProductsCount": low_stock_products_count,
        "totalCustomerReceivablesXof": number(&json::row_to_json(receivables, &[]), "total"),
        "totalSupplierPayablesXof": number(&json::row_to_json(payables, &[]), "total"),
        "depotBottlesQty": depot_bottles_qty,
        "depotCratesQty": depot_crates_qty,
        "depotConsignmentValueXof": depot_consignment_value_xof,
        "customerConsignmentQty": customer_consignment_qty,
        "customerConsignmentValueXof": customer_consignment_value_xof,
        "supplierConsignmentQty": supplier_consignment_qty,
        "supplierConsignmentValueXof": supplier_consignment_value_xof,
        "topDebtors": json::rows_to_json(debtors, &[]),
        "topCreditors": json::rows_to_json(creditors, &[])
    }))
}

pub async fn daily(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let period = range(input)?;
    let sales = sqlx::query(
        "SELECT substr(s.created_at, 1, 10) AS day,
                COALESCE(SUM(s.subtotal_xof - s.discount_xof), 0) AS salesRevenueXof,
                COALESCE((
                  SELECT SUM(si.base_qty * si.unit_cost_xof) FROM sale_items si
                  JOIN sales s2 ON s2.id = si.sale_id
                  WHERE s2.status = 'VALIDATED'
                    AND substr(s2.created_at, 1, 10) = substr(s.created_at, 1, 10)
                ), 0) AS cogsXof
         FROM sales s
         WHERE s.status = 'VALIDATED'
           AND (? IS NULL OR substr(s.created_at, 1, 10) >= ?)
           AND (? IS NULL OR substr(s.created_at, 1, 10) <= ?)
         GROUP BY day",
    )
    .bind(period.start.clone())
    .bind(period.start.clone())
    .bind(period.end.clone())
    .bind(period.end.clone())
    .fetch_all(pool)
    .await?;

    let expenses = sqlx::query(
        "SELECT substr(e.expense_date, 1, 10) AS day,
                COALESCE(SUM(e.amount_xof), 0) AS expensesXof
         FROM expenses e
         WHERE (? IS NULL OR substr(e.expense_date, 1, 10) >= ?)
           AND (? IS NULL OR substr(e.expense_date, 1, 10) <= ?)
         GROUP BY day",
    )
    .bind(period.start.clone())
    .bind(period.start.clone())
    .bind(period.end.clone())
    .bind(period.end.clone())
    .fetch_all(pool)
    .await?;

    // Fusion par jour, identique à `Map<string, DailySeriesPointDTO>` Node.
    let mut by_day: std::collections::BTreeMap<String, Json> = std::collections::BTreeMap::new();
    for row in sales {
        let dto = json::row_to_json(row, &[]);
        let day = text(&dto, "day").unwrap_or_default();
        let revenue = number(&dto, "salesRevenueXof");
        let cogs = number(&dto, "cogsXof");
        by_day.insert(
            day.clone(),
            json!({
                "date": day, "salesRevenueXof": revenue, "cogsXof": cogs,
                "grossMarginXof": revenue - cogs, "expensesXof": 0
            }),
        );
    }
    for row in expenses {
        let dto = json::row_to_json(row, &[]);
        let day = text(&dto, "day").unwrap_or_default();
        let amount = number(&dto, "expensesXof");
        if let Some(point) = by_day.get_mut(&day) {
            let current = number(point, "expensesXof");
            *point = attach(point.clone(), "expensesXof", json!(current + amount));
        } else {
            by_day.insert(
                day.clone(),
                json!({
                    "date": day, "salesRevenueXof": 0, "cogsXof": 0,
                    "grossMarginXof": 0, "expensesXof": amount
                }),
            );
        }
    }
    Ok(Value::Array(by_day.into_values().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn predicate_de_date_statique() {
        let source = include_str!("reports_repo.rs");
        let predicate = "substr(s.created_at, 1, 10) >= ?";
        assert!(source.contains(predicate));
        assert!(source.contains("? IS NULL OR"));
        assert!(source.contains("substr(e.expense_date, 1, 10) <= ?"));
    }

    #[test]
    fn normalisation_et_taux_de_marge() {
        let input = serde_json::json!({ "startDate": "2026-01-01", "endDate": "2026-01-31" });
        let period = range(&input).unwrap();
        assert_eq!(period.start.as_deref(), Some("2026-01-01"));
        assert_eq!(period.end.as_deref(), Some("2026-01-31"));
        let invalide = serde_json::json!({ "startDate": "01/01/2026" });
        assert!(range(&invalide).is_err());
        assert_eq!(margin_rate_tenths(10_000, 2_500), 250);
        assert_eq!(margin_rate_tenths(0, 2_500), 0);
    }
}
