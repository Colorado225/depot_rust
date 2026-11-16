//! LOT 10 — Tranche 3, Point de vente : port de `server/repositories/posRepo.ts`.
//!
//! Idempotence POS (double clic), permission de remise, contrôle du stock
//! disponible cumulé par produit, plafond de crédit, consignes, encaissements
//! multi-canaux, et annulation par écritures compensatoires (jamais de
//! suppression physique). Tout est atomique et audité côté Rust.

use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{
    self, add_xof, attach, audit, doc_number, find, like, mul_qty, mul_xof, not_found,
    number, text, conflict, validation, PAYMENT_METHODS,
};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;

const PRICE_TIERS: &[&str] = &["WHOLESALE", "RETAIL"];
const PERM_DISCOUNT: &str = "pos.discount.apply";
const COMPTOIR_HOLDER_ID: &str = "COMPTOIR";

struct SaleLine {
    id: String,
    product_id: String,
    product_name: String,
    unit_id: String,
    unit_code: String,
    quantity: i64,
    conversion_to_base: i64,
    base_qty: i64,
    unit_price_xof: i64,
    unit_cost_xof: i64,
    line_total_xof: i64,
    bottle_packaging_type_id: Option<String>,
    bottle_deposit_xof: i64,
    crate_packaging_type_id: Option<String>,
    crate_deposit_xof: i64,
    apply_consignment: bool,
}

struct SalePaymentLine {
    payment_method: String,
    amount_xof: i64,
    external_reference: Option<String>,
}

async fn list_sales_query(
    pool: &SqlitePool,
    search: Option<String>,
    customer_id: Option<String>,
    status: Option<String>,
    price_tier: Option<String>,
    limit: i64,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT s.id, s.sale_number, s.idempotency_key, s.customer_id,
                COALESCE(c.full_name, 'Client comptoir') AS customer_name,
                c.phone AS customer_phone, s.price_tier, s.subtotal_xof,
                s.discount_xof, s.consignment_total_xof, s.total_payable_xof,
                s.paid_amount_xof, s.credit_amount_xof, s.status, s.due_at, s.note,
                s.cancelled_at,
                COALESCE(ce.full_name, cu.username) AS cancelled_by_user_name,
                s.cancel_reason, s.user_id,
                COALESCE(e.full_name, u.username) AS user_name, s.created_at
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         JOIN users u ON u.id = s.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN users cu ON cu.id = s.cancelled_by_user_id
         LEFT JOIN employees ce ON ce.id = cu.employee_id
         WHERE (? IS NULL OR s.customer_id = ?)
           AND (? IS NULL OR s.status = ?)
           AND (? IS NULL OR s.price_tier = ?)
           AND (? IS NULL OR (LOWER(s.sale_number) LIKE ?
                              OR LOWER(COALESCE(c.full_name, 'client comptoir')) LIKE ?
                              OR LOWER(COALESCE(s.note, '')) LIKE ?))
         ORDER BY s.created_at DESC, s.rowid DESC
         LIMIT ?",
    )
    .bind(customer_id.clone())
    .bind(customer_id)
    .bind(status.clone())
    .bind(status)
    .bind(price_tier.clone())
    .bind(price_tier)
    .bind(search.clone())
    .bind(search.clone())
    .bind(search.clone())
    .bind(search)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let sale_id: String = row.try_get("id")?;
        let items = sqlx::query(
            "SELECT si.id, si.sale_id, si.product_id, p.sku AS product_sku,
                    p.name AS product_name, si.unit_id, un.name AS unit_name,
                    bu.name AS base_unit_name, si.quantity, si.conversion_to_base,
                    si.base_qty, si.unit_price_xof, si.unit_cost_xof, si.line_total_xof
             FROM sale_items si
             JOIN products p ON p.id = si.product_id
             JOIN units un ON un.id = si.unit_id
             JOIN units bu ON bu.id = p.base_unit_id
             WHERE si.sale_id = ? ORDER BY p.name ASC",
        )
        .bind(&sale_id)
        .fetch_all(pool)
        .await?;
        let payments = sqlx::query(
            "SELECT p.id, p.payment_number, p.payment_method,
                    pa.allocated_xof AS amount_xof, p.external_reference, p.created_at
             FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
             WHERE pa.target_type = 'SALE' AND pa.target_id = ?
             ORDER BY p.created_at ASC",
        )
        .bind(&sale_id)
        .fetch_all(pool)
        .await?;
        let dto = attach(
            json::row_to_json(row, &[]),
            "items",
            json::rows_to_json(items, &[]),
        );
        out.push(attach(dto, "payments", json::rows_to_json(payments, &[])));
    }
    Ok(Value::Array(out))
}

pub async fn list_sales(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_sales_query(
        pool,
        like(input, "search"),
        json::opt_str(input, "customerId"),
        json::opt_str(input, "status"),
        json::opt_str(input, "priceTier"),
        common::bounded_limit(input, 150, 500),
    )
    .await
}

async fn get_sale(pool: &SqlitePool, sale_id: &str) -> Result<Json, AppError> {
    let rows = list_sales_query(pool, None, None, None, None, 500).await?;
    find(&rows, "id", sale_id)
        .cloned()
        .ok_or_else(|| not_found("Vente introuvable."))
}

async fn record_sale_consignment_delta(
    tx: &mut sqlx::sqlite::SqliteConnection,
    packaging_type_id: &str,
    holder_type: &str,
    holder_id: &str,
    quantity_delta: i64,
    amount_xof: i64,
    sale_id: &str,
    note: &str,
    actor_user_id: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO consignment_movements (
           id, packaging_type_id, movement_type, holder_type, holder_id,
           quantity_delta, amount_xof, reference_type, reference_id, note, user_id
         ) VALUES (?, ?, 'SALE_DEPOSIT', ?, ?, ?, ?, 'SALE', ?, ?, ?)",
    )
    .bind(json::new_id())
    .bind(packaging_type_id)
    .bind(holder_type)
    .bind(holder_id)
    .bind(quantity_delta)
    .bind(amount_xof)
    .bind(sale_id)
    .bind(note)
    .bind(actor_user_id)
    .execute(&mut *tx)
    .await?;

    if holder_type == "CUSTOMER" {
        let existing: Option<(String, i64, i64)> = sqlx::query_as(
            "SELECT id, quantity, deposit_value_xof FROM consignment_balances
             WHERE holder_type = 'CUSTOMER' AND holder_id = ? AND packaging_type_id = ?",
        )
        .bind(holder_id)
        .bind(packaging_type_id)
        .fetch_optional(&mut *tx)
        .await?;
        match existing {
            Some((id, quantity, value)) => {
                sqlx::query(
                    "UPDATE consignment_balances
                     SET quantity = ?, deposit_value_xof = ?,
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     WHERE id = ?",
                )
                .bind(quantity + quantity_delta)
                .bind(value + amount_xof)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query(
                    "INSERT INTO consignment_balances (
                       id, holder_type, holder_id, packaging_type_id, quantity, deposit_value_xof
                     ) VALUES (?, 'CUSTOMER', ?, ?, ?, ?)",
                )
                .bind(json::new_id())
                .bind(holder_id)
                .bind(packaging_type_id)
                .bind(quantity_delta)
                .bind(amount_xof)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    Ok(())
}

pub async fn create_sale(
    pool: &SqlitePool,
    actor_user_id: &str,
    discount_allowed: bool,
    input: &Json,
) -> Result<Json, AppError> {
    let idempotency_key = json::text_field(input, "idempotencyKey", 8, 200, "Clé d'idempotence")?;
    let price_tier = json::enum_field(input, "priceTier", PRICE_TIERS)?;
    let discount_xof = match input.get("discountXof") {
        None => 0,
        Some(_) => json::non_negative_i64(input, "discountXof", "Remise")?,
    };
    let note = json::optional_text(input, "note", 300, "Note")?;
    let customer_id = json::opt_str(input, "customerId");
    let raw_items = json::array_field(input, "items", 1, "Panier de vente")?;
    let raw_payments = input
        .get("payments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // RÈGLE 13 : un double clic ne doit jamais créer deux ventes.
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM sales WHERE idempotency_key = ?")
            .bind(&idempotency_key)
            .fetch_optional(pool)
            .await?;
    if let Some(row) = existing {
        return get_sale(pool, &row.0).await;
    }

    if discount_xof > 0 && !discount_allowed {
        return Err(AppError::PermissionDenied(format!(
            "Vous n'avez pas la permission d'appliquer une remise commerciale ({PERM_DISCOUNT})."
        )));
    }

    let mut payments: Vec<SalePaymentLine> = Vec::with_capacity(raw_payments.len());
    for payment in &raw_payments {
        payments.push(SalePaymentLine {
            payment_method: json::enum_field(payment, "paymentMethod", PAYMENT_METHODS)?,
            amount_xof: json::positive_i64(payment, "amountXof", "Montant encaissé")?,
            external_reference: json::optional_text(payment, "externalReference", 100, "Référence")?,
        });
    }

    let sale_id = json::new_id();
    let sale_number = doc_number("VNT");
    let mut tx = pool.begin().await?;
    let result = async {
        let settings = sqlx::query(
            "SELECT allow_negative_stock, default_consignment_policy
             FROM business_settings LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let settings = settings.map(|row| json::row_to_json(row, &[])).unwrap_or(Value::Null);
        let allow_negative_stock = number(&settings, "allowNegativeStock") == 1;
        let default_charge_consignment =
            text(&settings, "defaultConsignmentPolicy").as_deref() == Some("AUTO_INCLUDE_CRATES");

        let customer = if let Some(ref id) = customer_id {
            let row = sqlx::query(
                "SELECT id, full_name, credit_limit_xof, commercial_debt_xof,
                        due_days, is_active FROM customers WHERE id = ?",
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            let dto = row.map(|r| json::row_to_json(r, &[]));
            match dto {
                Some(dto) if number(&dto, "isActive") == 1 => Some(dto),
                _ => return Err(not_found("Client actif introuvable.")),
            }
        } else {
            None
        };

        let mut seen_pairs: Vec<String> = Vec::new();
        let mut subtotal_xof = 0_i64;
        let mut consignment_total_xof = 0_i64;
        let mut requested_base_by_product: HashMap<String, (String, i64)> = HashMap::new();
        let mut prepared: Vec<SaleLine> = Vec::with_capacity(raw_items.len());

        for line in &raw_items {
            let product_id = json::text_field(line, "productId", 1, 80, "Produit")?;
            let unit_id = json::text_field(line, "unitId", 1, 80, "Unité")?;
            let pair = format!("{product_id}::{unit_id}");
            if seen_pairs.contains(&pair) {
                return Err(validation(
                    "Produit et conditionnement en double dans le panier ; ajustez directement la quantité.",
                ));
            }
            seen_pairs.push(pair);
            let quantity = json::positive_i64(line, "quantity", "Quantité vendue")?;

            let product_unit = sqlx::query(
                "SELECT p.id, p.name AS product_name, p.is_active,
                        p.weighted_avg_cost_xof,
                        p.bottle_packaging_type_id,
                        COALESCE(bp.deposit_amount_xof, 0) AS bottle_deposit_xof,
                        p.crate_packaging_type_id,
                        COALESCE(cp.deposit_amount_xof, 0) AS crate_deposit_xof,
                        pu.conversion_to_base, pu.wholesale_price_xof,
                        pu.retail_price_xof, u.code AS unit_code
                 FROM products p
                 JOIN product_units pu ON pu.product_id = p.id AND pu.unit_id = ?
                 JOIN units u ON u.id = pu.unit_id
                 LEFT JOIN packaging_types bp ON bp.id = p.bottle_packaging_type_id
                 LEFT JOIN packaging_types cp ON cp.id = p.crate_packaging_type_id
                 WHERE p.id = ?",
            )
            .bind(&unit_id)
            .bind(&product_id)
            .fetch_optional(&mut *tx)
            .await?;
            let unit = product_unit
                .map(|row| json::row_to_json(row, &[]))
                .ok_or_else(|| validation("Produit ou conditionnement non configuré pour la vente."))?;
            if number(&unit, "isActive") != 1 {
                return Err(validation(format!(
                    "Le produit « {} » est archivé.",
                    text(&unit, "productName").unwrap_or_default()
                )));
            }

            let conversion = number(&unit, "conversionToBase");
            let base_qty = mul_qty(quantity, conversion, "Quantité de base")?;
            let unit_price_xof = if price_tier == "WHOLESALE" {
                number(&unit, "wholesalePriceXof")
            } else {
                number(&unit, "retailPriceXof")
            };
            let line_total_xof = mul_xof(unit_price_xof, quantity, "Ligne de vente")?;
            subtotal_xof = add_xof(subtotal_xof, line_total_xof, "Sous-total")?;

            let bottle_id = text(&unit, "bottlePackagingTypeId");
            let bottle_deposit = number(&unit, "bottleDepositXof");
            let crate_id = text(&unit, "cratePackagingTypeId");
            let crate_deposit = number(&unit, "crateDepositXof");
            let unit_code = text(&unit, "unitCode").unwrap_or_default();
            let apply_consignment = json::opt_bool(line, "applyConsignment")
                .unwrap_or(default_charge_consignment);
            if apply_consignment {
                if bottle_id.is_some() && bottle_deposit > 0 {
                    consignment_total_xof = add_xof(
                        consignment_total_xof,
                        mul_xof(bottle_deposit, base_qty, "Consigne bouteilles")?,
                        "Consignes",
                    )?;
                }
                if crate_id.is_some() && crate_deposit > 0 && unit_code == "CASIER" {
                    consignment_total_xof = add_xof(
                        consignment_total_xof,
                        mul_xof(crate_deposit, quantity, "Consigne casiers")?,
                        "Consignes",
                    )?;
                }
            }
            let product_name = text(&unit, "productName").unwrap_or_default();
            let entry = requested_base_by_product
                .entry(product_id.clone())
                .or_insert((product_name.clone(), 0));
            entry.1 = entry
                .1
                .checked_add(base_qty)
                .ok_or_else(|| validation("Dépassement arithmétique (stock demandé)"))?;

            prepared.push(SaleLine {
                id: json::new_id(),
                product_id,
                product_name,
                unit_id,
                unit_code,
                quantity,
                conversion_to_base: conversion,
                base_qty,
                unit_price_xof,
                unit_cost_xof: number(&unit, "weightedAvgCostXof"),
                line_total_xof,
                bottle_packaging_type_id: bottle_id,
                bottle_deposit_xof: bottle_deposit,
                crate_packaging_type_id: crate_id,
                crate_deposit_xof: crate_deposit,
                apply_consignment,
            });
        }

        if discount_xof > subtotal_xof {
            return Err(validation(format!(
                "La remise ({discount_xof} FCFA) ne peut pas dépasser le sous-total marchandises ({subtotal_xof} FCFA)."
            )));
        }

        // RÈGLE 9 : stock disponible cumulé par produit avant toute écriture.
        for (product_id, (name, total_base)) in &requested_base_by_product {
            let balance: Option<(i64,)> =
                sqlx::query_as("SELECT quantity_base FROM stock_balances WHERE product_id = ?")
                    .bind(product_id)
                    .fetch_optional(&mut *tx)
                    .await?;
            let available = balance.map(|row| row.0).unwrap_or(0);
            if !allow_negative_stock && available < *total_base {
                return Err(common::insufficient_stock(format!(
                    "Stock insuffisant pour « {name} » : disponible {available}, demandé {total_base}."
                )));
            }
        }

        let total_payable_xof = subtotal_xof - discount_xof + consignment_total_xof;
        let mut paid_amount_xof = 0_i64;
        for payment in &payments {
            paid_amount_xof = add_xof(paid_amount_xof, payment.amount_xof, "Encaissements")?;
        }
        if paid_amount_xof > total_payable_xof {
            return Err(validation(format!(
                "Le total encaissé ({paid_amount_xof} FCFA) dépasse le net à payer ({total_payable_xof} FCFA)."
            )));
        }
        let credit_amount_xof = total_payable_xof - paid_amount_xof;
        if credit_amount_xof > 0 {
            let customer = customer
                .as_ref()
                .ok_or_else(|| validation("Sélectionnez un client enregistré pour enregistrer une vente à crédit."))?;
            let projected = number(customer, "commercialDebtXof") + credit_amount_xof;
            let limit = number(customer, "creditLimitXof");
            if projected > limit {
                return Err(conflict(format!(
                    "Plafond de crédit dépassé pour {} : dette projetée {projected} FCFA > plafond {limit} FCFA.",
                    text(customer, "fullName").unwrap_or_default()
                )));
            }
        }

        let open_session: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM cash_sessions WHERE status = 'OPEN'
             ORDER BY opened_at DESC LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let due_at = match (credit_amount_xof > 0, customer.as_ref()) {
            (true, Some(customer)) => Some(
                (chrono::Utc::now() + chrono::Duration::days(number(customer, "dueDays")))
                    .to_rfc3339(),
            ),
            _ => None,
        };

        sqlx::query(
            "INSERT INTO sales (
               id, sale_number, idempotency_key, customer_id, cash_session_id, price_tier,
               subtotal_xof, discount_xof, consignment_total_xof, total_payable_xof,
               paid_amount_xof, credit_amount_xof, status, due_at, note, user_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALIDATED', ?, ?, ?)",
        )
        .bind(&sale_id)
        .bind(&sale_number)
        .bind(&idempotency_key)
        .bind(customer.as_ref().and_then(|c| text(c, "id")))
        .bind(open_session.as_ref().map(|row| row.0.clone()))
        .bind(&price_tier)
        .bind(subtotal_xof)
        .bind(discount_xof)
        .bind(consignment_total_xof)
        .bind(total_payable_xof)
        .bind(paid_amount_xof)
        .bind(credit_amount_xof)
        .bind(&due_at)
        .bind(&note)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;

        let holder_type = if customer.is_some() { "CUSTOMER" } else { "DEPOT" };
        let holder_id = customer
            .as_ref()
            .and_then(|c| text(c, "id"))
            .unwrap_or_else(|| COMPTOIR_HOLDER_ID.to_string());

        for item in &prepared {
            sqlx::query(
                "INSERT INTO sale_items (
                   id, sale_id, product_id, unit_id, quantity, conversion_to_base,
                   base_qty, unit_price_xof, unit_cost_xof, line_total_xof
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&item.id)
            .bind(&sale_id)
            .bind(&item.product_id)
            .bind(&item.unit_id)
            .bind(item.quantity)
            .bind(item.conversion_to_base)
            .bind(item.base_qty)
            .bind(item.unit_price_xof)
            .bind(item.unit_cost_xof)
            .bind(item.line_total_xof)
            .execute(&mut *tx)
            .await?;

            let current: Option<(i64, i64)> = sqlx::query_as(
                "SELECT quantity_base, damaged_quantity_base FROM stock_balances WHERE product_id = ?",
            )
            .bind(&item.product_id)
            .fetch_optional(&mut *tx)
            .await?;
            let (available, damaged) = current.unwrap_or((0, 0));
            let next_balance = available - item.base_qty;
            if !allow_negative_stock && next_balance < 0 {
                return Err(common::insufficient_stock(format!(
                    "Stock insuffisant pour « {} ».",
                    item.product_name
                )));
            }
            sqlx::query(
                "INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
                 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 ON CONFLICT(product_id) DO UPDATE SET
                   quantity_base = excluded.quantity_base,
                   updated_at = excluded.updated_at",
            )
            .bind(&item.product_id)
            .bind(next_balance)
            .bind(damaged)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO stock_movements (
                   id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
                   balance_after_base, reference_type, reference_id, note, user_id
                 ) VALUES (?, ?, 'SALE', ?, ?, ?, 'SALE', ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(&item.product_id)
            .bind(-item.base_qty)
            .bind(item.unit_cost_xof)
            .bind(next_balance)
            .bind(&sale_id)
            .bind(format!("Vente {sale_number} ({} {})", item.quantity, item.unit_code))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;

            if item.apply_consignment {
                if let Some(ref pkg) = item.bottle_packaging_type_id {
                    if item.bottle_deposit_xof > 0 {
                        let amount = mul_xof(item.bottle_deposit_xof, item.base_qty, "Consigne")?;
                        record_sale_consignment_delta(
                            &mut *tx, pkg, holder_type, &holder_id, item.base_qty, amount,
                            &sale_id, &format!("Consigne bouteilles vente {sale_number}"), actor_user_id,
                        )
                        .await?;
                    }
                }
                if let Some(ref pkg) = item.crate_packaging_type_id {
                    if item.crate_deposit_xof > 0 && item.unit_code == "CASIER" {
                        let amount = mul_xof(item.crate_deposit_xof, item.quantity, "Consigne")?;
                        record_sale_consignment_delta(
                            &mut *tx, pkg, holder_type, &holder_id, item.quantity, amount,
                            &sale_id, &format!("Consigne casiers vente {sale_number}"), actor_user_id,
                        )
                        .await?;
                    }
                }
            }
        }

        for payment in &payments {
            let payment_id = json::new_id();
            let payment_number = doc_number("PAY");
            sqlx::query(
                "INSERT INTO payments (
                   id, payment_number, direction, party_type, party_id,
                   payment_method, amount_xof, external_reference, cash_session_id, user_id
                 ) VALUES (?, ?, 'INBOUND', 'CUSTOMER', ?, ?, ?, ?, ?, ?)",
            )
            .bind(&payment_id)
            .bind(&payment_number)
            .bind(customer.as_ref().and_then(|c| text(c, "id")))
            .bind(&payment.payment_method)
            .bind(payment.amount_xof)
            .bind(&payment.external_reference)
            .bind(open_session.as_ref().map(|row| row.0.clone()))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
                 VALUES (?, ?, 'SALE', ?, ?)",
            )
            .bind(json::new_id())
            .bind(&payment_id)
            .bind(&sale_id)
            .bind(payment.amount_xof)
            .execute(&mut *tx)
            .await?;
            if payment.payment_method == "CASH" {
                if let Some(ref session) = open_session {
                    sqlx::query(
                        "INSERT INTO cash_movements (
                           id, cash_session_id, movement_type, amount_signed_xof,
                           reference_type, reference_id, description, user_id
                         ) VALUES (?, ?, 'SALE_CASH', ?, 'SALE', ?, ?, ?)",
                    )
                    .bind(json::new_id())
                    .bind(&session.0)
                    .bind(payment.amount_xof)
                    .bind(&sale_id)
                    .bind(format!("Encaissement espèces vente {sale_number}"))
                    .bind(actor_user_id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }

        if let Some(ref customer) = customer {
            if credit_amount_xof > 0 {
                let id = text(customer, "id").unwrap_or_default();
                let row = sqlx::query(
                    "SELECT COALESCE(SUM(credit_amount_xof), 0) AS debt_xof
                     FROM sales WHERE customer_id = ? AND status = 'VALIDATED'",
                )
                .bind(&id)
                .fetch_one(&mut *tx)
                .await?;
                let debt = number(&json::row_to_json(row, &[]), "debtXof").max(0);
                sqlx::query(
                    "UPDATE customers SET commercial_debt_xof = ?,
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                         sync_version = sync_version + 1 WHERE id = ?",
                )
                .bind(debt)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            }
        }

        audit(
            &mut *tx,
            actor_user_id,
            "SALE_VALIDATED",
            "sales",
            &sale_id,
            &json!({
                "saleNumber": sale_number, "priceTier": price_tier,
                "totalPayableXof": total_payable_xof, "paidAmountXof": paid_amount_xof,
                "creditAmountXof": credit_amount_xof,
                "consignmentTotalXof": consignment_total_xof
            }),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    get_sale(pool, &sale_id).await
}

pub async fn cancel_sale(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let sale_id = json::id_field(input)?;
    let reason = json::text_field(input, "reason", 3, 240, "Motif d'annulation")?;
    let sale = get_sale(pool, &sale_id).await?;
    if text(&sale, "status").as_deref() == Some("CANCELLED") {
        return Err(conflict("Cette vente est déjà annulée."));
    }
    let sale_number = text(&sale, "saleNumber").unwrap_or_default();
    let customer_id = text(&sale, "customerId");
    let items = sale.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let payments = sale.get("payments").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE sales SET status = 'CANCELLED',
                 cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 cancelled_by_user_id = ?, cancel_reason = ?,
                 sync_version = sync_version + 1 WHERE id = ?",
        )
        .bind(actor_user_id)
        .bind(&reason)
        .bind(&sale_id)
        .execute(&mut *tx)
        .await?;

        // RÈGLE 3 : écritures compensatoires sur le stock, jamais de suppression.
        for item in &items {
            let product_id = text(item, "productId").unwrap_or_default();
            let base_qty = number(item, "baseQty");
            let unit_cost = number(item, "unitCostXof");
            let current: Option<(i64, i64)> = sqlx::query_as(
                "SELECT quantity_base, damaged_quantity_base FROM stock_balances WHERE product_id = ?",
            )
            .bind(&product_id)
            .fetch_optional(&mut *tx)
            .await?;
            let (available, damaged) = current.unwrap_or((0, 0));
            let next_qty = available + base_qty;
            sqlx::query(
                "INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
                 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 ON CONFLICT(product_id) DO UPDATE SET
                   quantity_base = excluded.quantity_base,
                   updated_at = excluded.updated_at",
            )
            .bind(&product_id)
            .bind(next_qty)
            .bind(damaged)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO stock_movements (
                   id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
                   balance_after_base, reference_type, reference_id, note, user_id
                 ) VALUES (?, ?, 'SALE_CANCEL', ?, ?, ?, 'SALE', ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(&product_id)
            .bind(base_qty)
            .bind(unit_cost)
            .bind(next_qty)
            .bind(&sale_id)
            .bind(format!("Annulation vente {sale_number} : {reason}"))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;
        }

        // Compensation des consignes générées par la vente.
        let deposits: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
            "SELECT packaging_type_id, holder_type, holder_id, quantity_delta, amount_xof
             FROM consignment_movements
             WHERE reference_type = 'SALE' AND reference_id = ?
               AND movement_type = 'SALE_DEPOSIT'",
        )
        .bind(&sale_id)
        .fetch_all(&mut *tx)
        .await?;
        for dep in &deposits {
            sqlx::query(
                "INSERT INTO consignment_movements (
                   id, packaging_type_id, movement_type, holder_type, holder_id,
                   quantity_delta, amount_xof, reference_type, reference_id, note, user_id
                 ) VALUES (?, ?, 'REFUND', ?, ?, ?, ?, 'SALE_CANCEL', ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(&dep.0)
            .bind(&dep.1)
            .bind(&dep.2)
            .bind(-dep.3)
            .bind(dep.4)
            .bind(&sale_id)
            .bind(format!("Annulation consigne vente {sale_number}"))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;
            if dep.1 == "CUSTOMER" {
                sqlx::query(
                    "UPDATE consignment_balances
                     SET quantity = MAX(0, quantity - ?),
                         deposit_value_xof = MAX(0, deposit_value_xof - ?),
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     WHERE holder_type = 'CUSTOMER' AND holder_id = ? AND packaging_type_id = ?",
                )
                .bind(dep.3)
                .bind(dep.4)
                .bind(&dep.2)
                .bind(&dep.0)
                .execute(&mut *tx)
                .await?;
            }
        }

        // Compensation des encaissements associés à la vente.
        let open_session: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM cash_sessions WHERE status = 'OPEN'
             ORDER BY opened_at DESC LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        for payment in &payments {
            let method = text(payment, "paymentMethod").unwrap_or_else(|| "CASH".to_string());
            let amount = number(payment, "amountXof");
            sqlx::query(
                "INSERT INTO payments (
                   id, payment_number, direction, party_type, party_id,
                   payment_method, amount_xof, external_reference, cash_session_id, user_id
                 ) VALUES (?, ?, 'OUTBOUND', 'CUSTOMER', ?, ?, ?, ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(doc_number("REM"))
            .bind(&customer_id)
            .bind(&method)
            .bind(amount)
            .bind(format!("ANNUL-{sale_number}"))
            .bind(open_session.as_ref().map(|row| row.0.clone()))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;
            if method == "CASH" {
                if let Some(ref session) = open_session {
                    sqlx::query(
                        "INSERT INTO cash_movements (
                           id, cash_session_id, movement_type, amount_signed_xof,
                           reference_type, reference_id, description, user_id
                         ) VALUES (?, ?, 'MANUAL_OUT', ?, 'SALE_CANCEL', ?, ?, ?)",
                    )
                    .bind(json::new_id())
                    .bind(&session.0)
                    .bind(-amount)
                    .bind(&sale_id)
                    .bind(format!("Remboursement annulation vente {sale_number}"))
                    .bind(actor_user_id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }

        if let Some(ref id) = customer_id {
            let row = sqlx::query(
                "SELECT COALESCE(SUM(credit_amount_xof), 0) AS debt_xof
                 FROM sales WHERE customer_id = ? AND status = 'VALIDATED'",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            let debt = number(&json::row_to_json(row, &[]), "debtXof").max(0);
            sqlx::query(
                "UPDATE customers SET commercial_debt_xof = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     sync_version = sync_version + 1 WHERE id = ?",
            )
            .bind(debt)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }

        audit(
            &mut *tx,
            actor_user_id,
            "SALE_CANCELLED",
            "sales",
            &sale_id,
            &json!({ "saleNumber": sale_number, "reason": reason }),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    get_sale(pool, &sale_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tarifs_et_permission_de_remise() {
        assert_eq!(PRICE_TIERS.len(), 2);
        assert_eq!(PERM_DISCOUNT, "pos.discount.apply");
    }

    #[test]
    fn validation_du_panier() {
        let panier = serde_json::json!({
            "idempotencyKey": "12345678", "priceTier": "RETAIL",
            "items": [{ "productId": "p1", "unitId": "u1", "quantity": 1 }]
        });
        assert_eq!(json::text_field(&panier, "idempotencyKey", 8, 200, "Clé").unwrap(), "12345678");
        assert!(json::enum_field(&panier, "priceTier", PRICE_TIERS).is_ok());
        assert!(json::array_field(&panier, "items", 1, "Panier").is_ok());
        assert_eq!(panier.get("payments").and_then(Value::as_array), None);
    }
}
