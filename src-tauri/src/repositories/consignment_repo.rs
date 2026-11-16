//! LOT 10 — Tranche 3, Consignes & emballages : port de
//! `server/repositories/consignmentRepo.ts`.
//!
//! Les soldes d'emballages sont séparés des créances et du stock marchand.
//! Aucun solde ne peut devenir négatif ; chaque variation est journalisée
//! dans `consignment_movements`, avec remboursement et mouvement de caisse
//! atomiques quand il est demandé.

use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{
    self, audit, doc_number, find, mul_xof, not_found, number, text, conflict, validation,
    PAYMENT_METHODS,
};
use serde_json::json;
use sqlx::sqlite::SqliteConnection;
use sqlx::SqlitePool;

const DEPOT_HOLDER_ID: &str = "DEPOT_MAIN";
const CUSTOMER_OPERATIONS: &[&str] = &["SALE_DEPOSIT", "EXCHANGE", "BREAKAGE", "LOSS"];
const SUPPLIER_OPERATIONS: &[&str] = &["SUPPLIER_DEPOSIT", "SUPPLIER_RETURN"];
const DEPOT_OPERATIONS: &[&str] = &["EXCHANGE", "BREAKAGE", "LOSS"];

async fn packaging_type(
    tx: &mut SqliteConnection,
    packaging_type_id: &str,
) -> Result<Json, AppError> {
    let row = sqlx::query(
        "SELECT id, code, name, kind, deposit_amount_xof
         FROM packaging_types WHERE id = ?",
    )
    .bind(packaging_type_id)
    .fetch_optional(&mut *tx)
    .await?;
    row.map(|r| json::row_to_json(r, &[]))
        .ok_or_else(|| not_found("Type d'emballage consigné introuvable."))
}

async fn holder_balance(
    tx: &mut SqliteConnection,
    holder_type: &str,
    holder_id: &str,
    packaging_type_id: &str,
) -> Result<Option<(String, i64, i64)>, AppError> {
    let row = sqlx::query_as(
        "SELECT id, quantity, deposit_value_xof FROM consignment_balances
         WHERE holder_type = ? AND holder_id = ? AND packaging_type_id = ?",
    )
    .bind(holder_type)
    .bind(holder_id)
    .bind(packaging_type_id)
    .fetch_optional(&mut *tx)
    .await?;
    Ok(row)
}

async fn upsert_balance_delta(
    tx: &mut SqliteConnection,
    holder_type: &str,
    holder_id: &str,
    packaging_type_id: &str,
    qty_delta: i64,
    value_delta_xof: i64,
) -> Result<(), AppError> {
    let existing = holder_balance(&mut *tx, holder_type, holder_id, packaging_type_id).await?;
    let (current_qty, current_value) = existing
        .as_ref()
        .map(|row| (row.1, row.2))
        .unwrap_or((0, 0));
    let next_qty = current_qty + qty_delta;
    let next_value = (current_value + value_delta_xof).max(0);
    if next_qty < 0 {
        return Err(conflict(format!(
            "Solde d'emballages insuffisant ({current_qty} disponible, variation {qty_delta})."
        )));
    }
    match existing {
        Some((id, _, _)) => {
            sqlx::query(
                "UPDATE consignment_balances
                 SET quantity = ?, deposit_value_xof = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?",
            )
            .bind(next_qty)
            .bind(if next_qty == 0 { 0 } else { next_value })
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO consignment_balances (
                   id, holder_type, holder_id, packaging_type_id, quantity, deposit_value_xof
                 ) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(holder_type)
            .bind(holder_id)
            .bind(packaging_type_id)
            .bind(next_qty)
            .bind(if next_qty == 0 { 0 } else { value_delta_xof.max(0) })
            .execute(&mut *tx)
            .await?;
        }
    }
    Ok(())
}

pub async fn summary(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT cb.holder_type, pt.kind AS packaging_kind,
                COALESCE(SUM(cb.quantity), 0) AS qty,
                COALESCE(SUM(cb.deposit_value_xof), 0) AS value_xof
         FROM consignment_balances cb
         JOIN packaging_types pt ON pt.id = cb.packaging_type_id
         GROUP BY cb.holder_type, pt.kind",
    )
    .fetch_all(pool)
    .await?;
    let mut out = json!({
        "depotBottlesQty": 0, "depotCratesQty": 0, "depotTotalValueXof": 0,
        "customerQty": 0, "customerValueXof": 0,
        "supplierQty": 0, "supplierValueXof": 0
    });
    for row in rows {
        let dto = json::row_to_json(row, &[]);
        let holder = text(&dto, "holderType").unwrap_or_default();
        let kind = text(&dto, "packagingKind").unwrap_or_default();
        let qty = number(&dto, "qty");
        let value = number(&dto, "valueXof");
        let (qty_key, value_key) = match holder.as_str() {
            "DEPOT" => {
                if kind == "BOTTLE" {
                    let current = number(&out, "depotBottlesQty");
                    out["depotBottlesQty"] = json!(current + qty);
                }
                if kind == "CRATE" {
                    let current = number(&out, "depotCratesQty");
                    out["depotCratesQty"] = json!(current + qty);
                }
                ("", "depotTotalValueXof")
            }
            "CUSTOMER" => ("customerQty", "customerValueXof"),
            "SUPPLIER" => ("supplierQty", "supplierValueXof"),
            _ => continue,
        };
        if !qty_key.is_empty() {
            let current_qty = number(&out, qty_key);
            out[qty_key] = json!(current_qty + qty);
        }
        let current_value = number(&out, value_key);
        out[value_key] = json!(current_value + value);
    }
    Ok(out)
}

pub async fn list_balances(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let holder_type = json::opt_str(input, "holderType");
    let holder_id = json::opt_str(input, "holderId");
    let kind = json::opt_str(input, "kind");
    let only_non_zero = json::opt_bool(input, "onlyNonZero").unwrap_or(false);
    let rows = sqlx::query(
        "SELECT cb.id, cb.holder_type, cb.holder_id,
                CASE
                  WHEN cb.holder_type = 'DEPOT' THEN 'Dépôt (Emballages vides)'
                  WHEN cb.holder_type = 'CUSTOMER' THEN COALESCE(c.full_name, 'Client inconnu')
                  WHEN cb.holder_type = 'SUPPLIER' THEN COALESCE(s.name, 'Fournisseur inconnu')
                  ELSE cb.holder_id
                END AS holder_name,
                cb.packaging_type_id, pt.code AS packaging_code,
                pt.name AS packaging_name, pt.kind AS packaging_kind,
                pt.deposit_amount_xof, cb.quantity, cb.deposit_value_xof, cb.updated_at
         FROM consignment_balances cb
         JOIN packaging_types pt ON pt.id = cb.packaging_type_id
         LEFT JOIN customers c ON cb.holder_type = 'CUSTOMER' AND c.id = cb.holder_id
         LEFT JOIN suppliers s ON cb.holder_type = 'SUPPLIER' AND s.id = cb.holder_id
         WHERE (? IS NULL OR cb.holder_type = ?)
           AND (? IS NULL OR cb.holder_id = ?)
           AND (? IS NULL OR pt.kind = ?)
           AND (? IS NULL OR cb.quantity != 0)
         ORDER BY cb.holder_type ASC, holder_name ASC, pt.kind ASC, pt.name ASC",
    )
    .bind(holder_type.clone())
    .bind(holder_type)
    .bind(holder_id.clone())
    .bind(holder_id)
    .bind(kind.clone())
    .bind(kind)
    .bind(if only_non_zero { Some(1_i64) } else { None::<i64> })
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

async fn list_movements_query(
    pool: &SqlitePool,
    holder_type: Option<String>,
    holder_id: Option<String>,
    packaging_type_id: Option<String>,
    movement_type: Option<String>,
    limit: i64,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT cm.id, cm.packaging_type_id, pt.code AS packaging_code,
                pt.name AS packaging_name, pt.kind AS packaging_kind,
                cm.movement_type, cm.holder_type, cm.holder_id,
                CASE
                  WHEN cm.holder_type = 'DEPOT' THEN 'Dépôt'
                  WHEN cm.holder_type = 'CUSTOMER' THEN COALESCE(c.full_name, 'Client comptoir')
                  WHEN cm.holder_type = 'SUPPLIER' THEN COALESCE(s.name, 'Fournisseur')
                  ELSE cm.holder_id
                END AS holder_name,
                cm.quantity_delta, cm.amount_xof, cm.reference_type,
                cm.reference_id, cm.note, cm.user_id,
                COALESCE(e.full_name, u.username) AS user_name, cm.created_at
         FROM consignment_movements cm
         JOIN packaging_types pt ON pt.id = cm.packaging_type_id
         LEFT JOIN customers c ON cm.holder_type = 'CUSTOMER' AND c.id = cm.holder_id
         LEFT JOIN suppliers s ON cm.holder_type = 'SUPPLIER' AND s.id = cm.holder_id
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE (? IS NULL OR cm.holder_type = ?)
           AND (? IS NULL OR cm.holder_id = ?)
           AND (? IS NULL OR cm.packaging_type_id = ?)
           AND (? IS NULL OR cm.movement_type = ?)
         ORDER BY cm.created_at DESC, cm.rowid DESC
         LIMIT ?",
    )
    .bind(holder_type.clone())
    .bind(holder_type)
    .bind(holder_id.clone())
    .bind(holder_id)
    .bind(packaging_type_id.clone())
    .bind(packaging_type_id)
    .bind(movement_type.clone())
    .bind(movement_type)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

pub async fn list_movements(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_movements_query(
        pool,
        json::opt_str(input, "holderType"),
        json::opt_str(input, "holderId"),
        json::opt_str(input, "packagingTypeId"),
        json::opt_str(input, "movementType"),
        common::bounded_limit(input, 150, 300),
    )
    .await
}

async fn movement_by_id(pool: &SqlitePool, movement_id: &str) -> Result<Json, AppError> {
    let rows = list_movements_query(pool, None, None, None, None, 50).await?;
    find(&rows, "id", movement_id)
        .cloned()
        .ok_or_else(|| conflict("Mouvement de consigne introuvable à la relecture."))
}

pub async fn customer_return(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let customer_id = json::text_field(input, "customerId", 1, 80, "Client")?;
    let packaging_type_id = json::text_field(input, "packagingTypeId", 1, 80, "Emballage")?;
    let quantity = json::positive_i64(input, "quantity", "Quantité retournée")?;
    let refund_customer = json::opt_bool(input, "refundCustomer").unwrap_or(false);
    let payment_method = json::opt_str(input, "paymentMethod");
    if let Some(ref method) = payment_method {
        if !PAYMENT_METHODS.contains(&method.as_str()) {
            return Err(validation(format!("Méthode de paiement invalide : {method}")));
        }
    }
    let external_reference = json::optional_text(input, "externalReference", 100, "Référence")?;
    let note = json::optional_text(input, "note", 240, "Note")?;

    let mut tx = pool.begin().await?;
    let summary_value = async {
        let pkg = packaging_type(&mut *tx, &packaging_type_id).await?;
        let customer = sqlx::query(
            "SELECT id, full_name, is_active FROM customers WHERE id = ?",
        )
        .bind(&customer_id)
        .fetch_optional(&mut *tx)
        .await?;
        let customer = customer
            .map(|row| json::row_to_json(row, &[]))
            .ok_or_else(|| not_found("Client introuvable."))?;
        let customer_name = text(&customer, "fullName").unwrap_or_default();

        let balance = holder_balance(&mut *tx, "CUSTOMER", &customer_id, &packaging_type_id).await?;
        let held_qty = balance.as_ref().map(|row| row.1).unwrap_or(0);
        if quantity > held_qty {
            return Err(conflict(format!(
                "Retour impossible : {customer_name} détient {held_qty} « {} », demandé {quantity}.",
                text(&pkg, "name").unwrap_or_default()
            )));
        }
        let deposit_returned = balance
            .as_ref()
            .map(|row| row.2)
            .unwrap_or(0)
            .min(mul_xof(number(&pkg, "depositAmountXof"), quantity, "Consigne retournée")?);
        let movement_id = json::new_id();
        let refund_amount = if refund_customer { deposit_returned } else { 0 };

        upsert_balance_delta(
            &mut *tx, "CUSTOMER", &customer_id, &packaging_type_id,
            -quantity, -deposit_returned,
        )
        .await?;
        upsert_balance_delta(
            &mut *tx, "DEPOT", DEPOT_HOLDER_ID, &packaging_type_id,
            quantity, deposit_returned,
        )
        .await?;

        let movement_note = note.clone().unwrap_or_else(|| {
            format!(
                "Retour {quantity} × {} ({customer_name})",
                text(&pkg, "name").unwrap_or_default()
            )
        });
        sqlx::query(
            "INSERT INTO consignment_movements (
               id, packaging_type_id, movement_type, holder_type, holder_id,
               quantity_delta, amount_xof, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, 'CUSTOMER_RETURN', 'CUSTOMER', ?, ?, ?, 'CONSIGNMENT', ?, ?, ?)",
        )
        .bind(&movement_id)
        .bind(&packaging_type_id)
        .bind(&customer_id)
        .bind(-quantity)
        .bind(deposit_returned)
        .bind(&movement_id)
        .bind(movement_note)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;

        if refund_customer && refund_amount > 0 {
            let method = payment_method.clone().unwrap_or_else(|| "CASH".to_string());
            sqlx::query(
                "INSERT INTO consignment_movements (
                   id, packaging_type_id, movement_type, holder_type, holder_id,
                   quantity_delta, amount_xof, reference_type, reference_id, note, user_id
                 ) VALUES (?, ?, 'REFUND', 'CUSTOMER', ?, ?, ?, 'CONSIGNMENT_RETURN', ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(&packaging_type_id)
            .bind(&customer_id)
            .bind(-quantity)
            .bind(refund_amount)
            .bind(&movement_id)
            .bind(format!(
                "Remboursement consigne {quantity} × {}",
                text(&pkg, "name").unwrap_or_default()
            ))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;

            let open_session: Option<(String,)> = sqlx::query_as(
                "SELECT id FROM cash_sessions WHERE status = 'OPEN'
                 ORDER BY opened_at DESC LIMIT 1",
            )
            .fetch_optional(&mut *tx)
            .await?;
            let payment_id = json::new_id();
            let payment_number = doc_number("RCONS");
            sqlx::query(
                "INSERT INTO payments (
                   id, payment_number, direction, party_type, party_id,
                   payment_method, amount_xof, external_reference, cash_session_id, user_id
                 ) VALUES (?, ?, 'OUTBOUND', 'CUSTOMER', ?, ?, ?, ?, ?, ?)",
            )
            .bind(&payment_id)
            .bind(&payment_number)
            .bind(&customer_id)
            .bind(&method)
            .bind(refund_amount)
            .bind(&external_reference)
            .bind(open_session.as_ref().map(|row| row.0.clone()))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
                 VALUES (?, ?, 'CONSIGNMENT_REFUND', ?, ?)",
            )
            .bind(json::new_id())
            .bind(&payment_id)
            .bind(&movement_id)
            .bind(refund_amount)
            .execute(&mut *tx)
            .await?;
            if method == "CASH" {
                if let Some(ref session) = open_session {
                    sqlx::query(
                        "INSERT INTO cash_movements (
                           id, cash_session_id, movement_type, amount_signed_xof,
                           reference_type, reference_id, description, user_id
                         ) VALUES (?, ?, 'CONSIGNMENT_REFUND', ?, 'CONSIGNMENT_RETURN', ?, ?, ?)",
                    )
                    .bind(json::new_id())
                    .bind(&session.0)
                    .bind(-refund_amount)
                    .bind(&movement_id)
                    .bind(format!("Remboursement consigne {customer_name} ({payment_number})"))
                    .bind(actor_user_id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }

        audit(
            &mut *tx,
            actor_user_id,
            "CONSIGNMENT_CUSTOMER_RETURN",
            "consignment_movements",
            &movement_id,
            &json!({
                "customerId": customer_id, "packagingTypeId": packaging_type_id,
                "quantityReturned": quantity, "refundedAmountXof": refund_amount
            }),
        )
        .await?;
        Ok::<(String, i64), AppError>((movement_id, refund_amount))
    }
    .await;
    let (movement_id, refunded) = match summary_value {
        Ok(value) => {
            tx.commit().await?;
            value
        }
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    };
    let mut conn = pool.acquire().await?;
    let updated = holder_balance(
        &mut *conn,
        "CUSTOMER",
        &customer_id,
        &packaging_type_id,
    )
    .await?;
    Ok(json!({
        "movementId": movement_id,
        "remainingCustomerQty": updated.map(|row| row.1).unwrap_or(0),
        "refundedAmountXof": refunded
    }))
}

async fn insert_operation_movement(
    tx: &mut SqliteConnection,
    movement_id: &str,
    packaging_type_id: &str,
    operation: &str,
    holder_type: &str,
    holder_id: &str,
    qty_delta: i64,
    amount_xof: i64,
    reference_type: &str,
    note: String,
    actor_user_id: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO consignment_movements (
           id, packaging_type_id, movement_type, holder_type, holder_id,
           quantity_delta, amount_xof, reference_type, reference_id, note, user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(movement_id)
    .bind(packaging_type_id)
    .bind(operation)
    .bind(holder_type)
    .bind(holder_id)
    .bind(qty_delta)
    .bind(amount_xof)
    .bind(reference_type)
    .bind(movement_id)
    .bind(note)
    .bind(actor_user_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

pub async fn customer_operation(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let customer_id = json::text_field(input, "customerId", 1, 80, "Client")?;
    let packaging_type_id = json::text_field(input, "packagingTypeId", 1, 80, "Emballage")?;
    let quantity = json::positive_i64(input, "quantity", "Quantité")?;
    let operation = json::enum_field(input, "operation", CUSTOMER_OPERATIONS)?;
    let note = json::optional_text(input, "note", 240, "Note")?;
    let movement_id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        let pkg = packaging_type(&mut *tx, &packaging_type_id).await?;
        let customer = sqlx::query("SELECT id, full_name FROM customers WHERE id = ?")
            .bind(&customer_id)
            .fetch_optional(&mut *tx)
            .await?;
        let customer = customer
            .map(|row| json::row_to_json(row, &[]))
            .ok_or_else(|| not_found("Client introuvable."))?;
        let customer_name = text(&customer, "fullName").unwrap_or_default();
        let value_xof = mul_xof(number(&pkg, "depositAmountXof"), quantity, "Consigne")?;

        let mut qty_delta = quantity;
        if operation == "SALE_DEPOSIT" {
            upsert_balance_delta(
                &mut *tx, "CUSTOMER", &customer_id, &packaging_type_id, quantity, value_xof,
            )
            .await?;
        } else if operation == "EXCHANGE" {
            let depot = holder_balance(&mut *tx, "DEPOT", DEPOT_HOLDER_ID, &packaging_type_id).await?;
            if depot.map(|row| row.1).unwrap_or(0) < quantity {
                upsert_balance_delta(
                    &mut *tx, "DEPOT", DEPOT_HOLDER_ID, &packaging_type_id, quantity, value_xof,
                )
                .await?;
            }
        } else {
            let bal = holder_balance(&mut *tx, "CUSTOMER", &customer_id, &packaging_type_id).await?;
            if bal.map(|row| row.1).unwrap_or(0) < quantity {
                return Err(conflict(format!(
                    "Solde client insuffisant pour imputer {quantity} {}.",
                    text(&pkg, "name").unwrap_or_default()
                )));
            }
            qty_delta = -quantity;
            upsert_balance_delta(
                &mut *tx, "CUSTOMER", &customer_id, &packaging_type_id,
                -quantity, -value_xof,
            )
            .await?;
        }
        insert_operation_movement(
            &mut *tx, &movement_id, &packaging_type_id, &operation, "CUSTOMER",
            &customer_id, qty_delta,
            if operation == "EXCHANGE" { 0 } else { value_xof },
            "CONSIGNMENT",
            note.unwrap_or_else(|| format!("{operation} · {customer_name}")),
            actor_user_id,
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
    movement_by_id(pool, &movement_id).await
}

pub async fn supplier_operation(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let supplier_id = json::text_field(input, "supplierId", 1, 80, "Fournisseur")?;
    let packaging_type_id = json::text_field(input, "packagingTypeId", 1, 80, "Emballage")?;
    let quantity = json::positive_i64(input, "quantity", "Quantité")?;
    let operation = json::enum_field(input, "operation", SUPPLIER_OPERATIONS)?;
    let note = json::optional_text(input, "note", 240, "Note")?;
    let movement_id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        let pkg = packaging_type(&mut *tx, &packaging_type_id).await?;
        let supplier = sqlx::query("SELECT id, name FROM suppliers WHERE id = ?")
            .bind(&supplier_id)
            .fetch_optional(&mut *tx)
            .await?;
        let supplier = supplier
            .map(|row| json::row_to_json(row, &[]))
            .ok_or_else(|| not_found("Fournisseur introuvable."))?;
        let supplier_name = text(&supplier, "name").unwrap_or_default();
        let value_xof = mul_xof(number(&pkg, "depositAmountXof"), quantity, "Consigne")?;

        if operation == "SUPPLIER_DEPOSIT" {
            upsert_balance_delta(
                &mut *tx, "SUPPLIER", &supplier_id, &packaging_type_id, quantity, value_xof,
            )
            .await?;
            upsert_balance_delta(
                &mut *tx, "DEPOT", DEPOT_HOLDER_ID, &packaging_type_id, quantity, value_xof,
            )
            .await?;
        } else {
            let depot = holder_balance(&mut *tx, "DEPOT", DEPOT_HOLDER_ID, &packaging_type_id).await?;
            let depot_qty = depot.as_ref().map(|row| row.1).unwrap_or(0);
            if depot_qty < quantity {
                return Err(conflict(format!(
                    "Stock d'emballages vides au dépôt insuffisant ({depot_qty} dispo, demandé {quantity})."
                )));
            }
            let supplier_bal = holder_balance(&mut *tx, "SUPPLIER", &supplier_id, &packaging_type_id).await?;
            let supplier_qty = supplier_bal.as_ref().map(|row| row.1).unwrap_or(0);
            if supplier_qty < quantity {
                return Err(conflict(format!(
                    "Le dépôt doit seulement {supplier_qty} « {} » à {supplier_name}.",
                    text(&pkg, "name").unwrap_or_default()
                )));
            }
            upsert_balance_delta(
                &mut *tx, "DEPOT", DEPOT_HOLDER_ID, &packaging_type_id, -quantity, -value_xof,
            )
            .await?;
            upsert_balance_delta(
                &mut *tx, "SUPPLIER", &supplier_id, &packaging_type_id, -quantity, -value_xof,
            )
            .await?;
        }
        insert_operation_movement(
            &mut *tx, &movement_id, &packaging_type_id, &operation, "SUPPLIER",
            &supplier_id,
            if operation == "SUPPLIER_DEPOSIT" { quantity } else { -quantity },
            value_xof,
            "SUPPLIER_CONSIGNMENT",
            note.unwrap_or_else(|| format!("{operation} · {supplier_name}")),
            actor_user_id,
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
    movement_by_id(pool, &movement_id).await
}

pub async fn depot_operation(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let packaging_type_id = json::text_field(input, "packagingTypeId", 1, 80, "Emballage")?;
    let quantity = json::positive_i64(input, "quantity", "Quantité")?;
    let operation = json::enum_field(input, "operation", DEPOT_OPERATIONS)?;
    let note = json::optional_text(input, "note", 240, "Note")?;
    let movement_id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        let pkg = packaging_type(&mut *tx, &packaging_type_id).await?;
        let value_xof = mul_xof(number(&pkg, "depositAmountXof"), quantity, "Consigne")?;
        let qty_delta = if operation == "EXCHANGE" { quantity } else { -quantity };
        let val_delta = if operation == "EXCHANGE" { value_xof } else { -value_xof };
        upsert_balance_delta(
            &mut *tx, "DEPOT", DEPOT_HOLDER_ID, &packaging_type_id, qty_delta, val_delta,
        )
        .await?;
        insert_operation_movement(
            &mut *tx, &movement_id, &packaging_type_id, &operation, "DEPOT",
            DEPOT_HOLDER_ID, qty_delta, value_xof, "DEPOT_PACKAGING",
            note.unwrap_or_else(|| {
                format!("Mouvement dépôt {operation} ({})", text(&pkg, "name").unwrap_or_default())
            }),
            actor_user_id,
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
    movement_by_id(pool, &movement_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_de_titulaires_et_operations() {
        assert_eq!("DEPOT,CUSTOMER,SUPPLIER".split(',').count(), 3);
        assert_eq!(DEPOT_HOLDER_ID, "DEPOT_MAIN");
        assert!(CUSTOMER_OPERATIONS.contains(&"BREAKAGE"));
        assert!(SUPPLIER_OPERATIONS.contains(&"SUPPLIER_RETURN"));
        assert!(DEPOT_OPERATIONS.contains(&"EXCHANGE"));
    }

    #[test]
    fn validation_des_operations() {
        let ok = serde_json::json!({
            "packagingTypeId": "pkg1", "quantity": 3, "operation": "BREAKAGE"
        });
        assert!(json::enum_field(&ok, "operation", DEPOT_OPERATIONS).is_ok());
        let bad = serde_json::json!({
            "packagingTypeId": "pkg1", "quantity": 0, "operation": "BREAKAGE"
        });
        assert!(json::positive_i64(&bad, "quantity", "Quantité").is_err());
        let _ = json!(null);
    }
}
