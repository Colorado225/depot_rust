//! LOT 10 — Tranche 3, Caisse & trésorerie : port de
//! `server/repositories/financeRepo.ts`.
//!
//! Sessions de caisse, mouvements manuels, clôture avec écart, correction
//! administrative justifiée, dépenses, réconciliation par canal de paiement
//! et trésorerie nette : tous les calculs sont exécutés côté Rust, en XOF
//! entiers, avec transactions et audit.

use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{
    attach, audit, bounded_limit, find, not_found, number, text, conflict, validation,
    PAYMENT_METHODS,
};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteRow;
use sqlx::SqlitePool;

const BOOL_REGISTERS: &[&str] = &["isActive"];
const DIRECTIONS: &[&str] = &["INBOUND", "OUTBOUND"];
const MANUAL_DIRECTIONS: &[&str] = &["IN", "OUT"];

pub async fn list_registers(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows = sqlx::query("SELECT id, code, name, is_active FROM cash_registers ORDER BY code ASC")
        .fetch_all(pool)
        .await?;
    Ok(json::rows_to_json(rows, BOOL_REGISTERS))
}

async fn compute_channels(pool: &SqlitePool, session_id: Option<String>) -> Result<Json, AppError> {
    let payments = sqlx::query(
        "SELECT payment_method, direction, COALESCE(SUM(amount_xof), 0) AS total_xof,
                COUNT(*) AS tx_count
         FROM payments
         WHERE (? IS NULL OR cash_session_id = ?)
         GROUP BY payment_method, direction",
    )
    .bind(session_id.clone())
    .bind(session_id.clone())
    .fetch_all(pool)
    .await?;
    let expenses = sqlx::query(
        "SELECT payment_method, COALESCE(SUM(amount_xof), 0) AS total_xof,
                COUNT(*) AS tx_count
         FROM expenses
         WHERE (? IS NULL OR cash_session_id = ?)
         GROUP BY payment_method",
    )
    .bind(session_id.clone())
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    let mut channels: Vec<Json> = Vec::with_capacity(PAYMENT_METHODS.len());
    for method in PAYMENT_METHODS {
        let mut inbound = 0_i64;
        let mut outbound = 0_i64;
        let mut spent = 0_i64;
        let mut count = 0_i64;
        for row in &payments {
            let dto = json::row_to_json((*row).clone(), &[]);
            if text(&dto, "paymentMethod").as_deref() != Some(*method) {
                continue;
            }
            let total = number(&dto, "totalXof");
            count += number(&dto, "txCount");
            if text(&dto, "direction").as_deref() == Some("INBOUND") {
                inbound += total;
            } else {
                outbound += total;
            }
        }
        for row in &expenses {
            let dto = json::row_to_json((*row).clone(), &[]);
            if text(&dto, "paymentMethod").as_deref() != Some(*method) {
                continue;
            }
            spent += number(&dto, "totalXof");
            count += number(&dto, "txCount");
        }
        channels.push(json!({
            "paymentMethod": method,
            "inboundXof": inbound,
            "outboundPaymentsXof": outbound,
            "expensesXof": spent,
            "netXof": inbound - outbound - spent,
            "transactionCount": count
        }));
    }
    Ok(Value::Array(channels))
}

async fn hydrate_sessions(pool: &SqlitePool, rows: Vec<SqliteRow>) -> Result<Json, AppError> {
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let dto = json::row_to_json(row, &[]);
        let session_id = text(&dto, "id").unwrap_or_default();
        let agg = sqlx::query(
            "SELECT
               COALESCE(SUM(CASE WHEN movement_type NOT IN ('OPENING', 'CLOSING_ADJUSTMENT')
                                 AND amount_signed_xof > 0 THEN amount_signed_xof ELSE 0 END), 0) AS cash_in_xof,
               COALESCE(SUM(CASE WHEN movement_type NOT IN ('OPENING', 'CLOSING_ADJUSTMENT')
                                 AND amount_signed_xof < 0 THEN -amount_signed_xof ELSE 0 END), 0) AS cash_out_xof,
               COALESCE(SUM(CASE WHEN movement_type != 'CLOSING_ADJUSTMENT'
                                 THEN amount_signed_xof ELSE 0 END), 0) AS computed_theoretical_xof
             FROM cash_movements WHERE cash_session_id = ?",
        )
        .bind(&session_id)
        .fetch_one(pool)
        .await?;
        let agg = json::row_to_json(agg, &[]);
        let status = text(&dto, "status").unwrap_or_default();
        let stored_theoretical = dto.get("theoreticalClosingXof").and_then(Value::as_i64);
        let theoretical = if status == "CLOSED" {
            stored_theoretical.unwrap_or(number(&agg, "computedTheoreticalXof"))
        } else {
            number(&agg, "computedTheoreticalXof")
        };
        let dto = attach(dto, "cashInXof", json!(number(&agg, "cashInXof")));
        let dto = attach(dto, "cashOutXof", json!(number(&agg, "cashOutXof")));
        let dto = attach(dto, "theoreticalClosingXof", json!(theoretical));
        let channels = compute_channels(pool, Some(session_id)).await?;
        out.push(attach(dto, "channels", channels));
    }
    Ok(Value::Array(out))
}

pub async fn list_sessions(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT cs.id, cs.cash_register_id, cr.code AS register_code,
                cr.name AS register_name, cs.opened_by_user_id,
                COALESCE(eo.full_name, uo.username) AS opened_by_name,
                cs.closed_by_user_id,
                COALESCE(ec.full_name, uc.username) AS closed_by_name,
                cs.opening_balance_xof, cs.theoretical_closing_xof,
                cs.declared_closing_xof, cs.variance_xof, cs.status,
                cs.opened_at, cs.closed_at, cs.notes
         FROM cash_sessions cs
         JOIN cash_registers cr ON cr.id = cs.cash_register_id
         JOIN users uo ON uo.id = cs.opened_by_user_id
         LEFT JOIN employees eo ON eo.id = uo.employee_id
         LEFT JOIN users uc ON uc.id = cs.closed_by_user_id
         LEFT JOIN employees ec ON ec.id = uc.employee_id
         ORDER BY CASE WHEN cs.status = 'OPEN' THEN 0 ELSE 1 END, cs.opened_at DESC
         LIMIT ?",
    )
    .bind(bounded_limit(input, 30, 200))
    .fetch_all(pool)
    .await?;
    hydrate_sessions(pool, rows).await
}

async fn session_by_id(pool: &SqlitePool, session_id: &str) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT cs.id, cs.cash_register_id, cr.code AS register_code,
                cr.name AS register_name, cs.opened_by_user_id,
                COALESCE(eo.full_name, uo.username) AS opened_by_name,
                cs.closed_by_user_id,
                COALESCE(ec.full_name, uc.username) AS closed_by_name,
                cs.opening_balance_xof, cs.theoretical_closing_xof,
                cs.declared_closing_xof, cs.variance_xof, cs.status,
                cs.opened_at, cs.closed_at, cs.notes
         FROM cash_sessions cs
         JOIN cash_registers cr ON cr.id = cs.cash_register_id
         JOIN users uo ON uo.id = cs.opened_by_user_id
         LEFT JOIN employees eo ON eo.id = uo.employee_id
         LEFT JOIN users uc ON uc.id = cs.closed_by_user_id
         LEFT JOIN employees ec ON ec.id = uc.employee_id
         WHERE cs.id = ?",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Err(not_found("Session de caisse introuvable."));
    }
    let hydrated = hydrate_sessions(pool, rows).await?;
    hydrated
        .as_array()
        .and_then(|items| items.first())
        .cloned()
        .ok_or_else(|| not_found("Session de caisse introuvable."))
}

pub async fn session_detail(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let session_id = json::id_field(input)?;
    let session = session_by_id(pool, &session_id).await?;
    let rows = sqlx::query(
        "SELECT cm.id, cm.cash_session_id, cm.movement_type, cm.amount_signed_xof,
                cm.reference_type, cm.reference_id, cm.description, cm.user_id,
                COALESCE(e.full_name, u.username) AS user_name, cm.created_at
         FROM cash_movements cm
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE cm.cash_session_id = ?
         ORDER BY cm.created_at DESC, cm.rowid DESC",
    )
    .bind(&session_id)
    .fetch_all(pool)
    .await?;
    Ok(json!({ "session": session, "movements": json::rows_to_json(rows, &[]) }))
}

pub async fn overview(pool: &SqlitePool) -> Result<Json, AppError> {
    let active: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM cash_sessions WHERE status = 'OPEN'
         ORDER BY opened_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    let active_session = match active {
        Some(row) => session_by_id(pool, &row.0).await?,
        None => Value::Null,
    };
    let registers = list_registers(pool).await?;
    let channels = compute_channels(pool, None).await?;
    let mut inbound = 0_i64;
    let mut outbound = 0_i64;
    let mut expenses = 0_i64;
    if let Some(items) = channels.as_array() {
        for channel in items {
            inbound += number(channel, "inboundXof");
            outbound += number(channel, "outboundPaymentsXof");
            expenses += number(channel, "expensesXof");
        }
    }
    let closed = sqlx::query(
        "SELECT COUNT(*) AS closed_count,
                COALESCE(SUM(variance_xof), 0) AS cumulative_variance_xof
         FROM cash_sessions WHERE status = 'CLOSED'",
    )
    .fetch_one(pool)
    .await?;
    let closed = json::row_to_json(closed, &[]);
    Ok(json!({
        "activeSession": active_session,
        "registers": registers,
        "totalInboundXof": inbound,
        "totalOutboundPaymentsXof": outbound,
        "totalExpensesXof": expenses,
        "netTreasuryXof": inbound - outbound - expenses,
        "closedSessionsCount": number(&closed, "closedCount"),
        "cumulativeVarianceXof": number(&closed, "cumulativeVarianceXof"),
        "channels": channels
    }))
}

pub async fn open_session(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let cash_register_id = json::text_field(input, "cashRegisterId", 1, 80, "Caisse")?;
    let opening_balance_xof = json::non_negative_i64(input, "openingBalanceXof", "Fond de caisse initial")?;
    let notes = json::optional_text(input, "notes", 240, "Notes")?;
    let register: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT id, name, is_active FROM cash_registers WHERE id = ?",
    )
    .bind(&cash_register_id)
    .fetch_optional(pool)
    .await?;
    let register = register
        .filter(|row| row.2 == 1)
        .ok_or_else(|| not_found("Caisse enregistreuse active introuvable."))?;
    let existing: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM cash_sessions WHERE status = 'OPEN' LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    if existing.is_some() {
        return Err(conflict(
            "Une session de caisse est déjà ouverte. Clôturez-la avant d'en ouvrir une nouvelle.",
        ));
    }
    let session_id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO cash_sessions (
               id, cash_register_id, opened_by_user_id, opening_balance_xof, status, notes
             ) VALUES (?, ?, ?, ?, 'OPEN', ?)",
        )
        .bind(&session_id)
        .bind(&cash_register_id)
        .bind(actor_user_id)
        .bind(opening_balance_xof)
        .bind(&notes)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO cash_movements (
               id, cash_session_id, movement_type, amount_signed_xof,
               reference_type, reference_id, description, user_id
             ) VALUES (?, ?, 'OPENING', ?, 'CASH_SESSION', ?, ?, ?)",
        )
        .bind(json::new_id())
        .bind(&session_id)
        .bind(opening_balance_xof)
        .bind(&session_id)
        .bind(format!("Ouverture {} — fond initial", register.1))
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "CASH_SESSION_OPENED",
            "cash_sessions",
            &session_id,
            &json!({ "cashRegisterId": cash_register_id, "openingBalanceXof": opening_balance_xof }),
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
    session_by_id(pool, &session_id).await
}

pub async fn manual_movement(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let session_id = json::text_field(input, "cashSessionId", 1, 80, "Session de caisse")?;
    let direction = json::enum_field(input, "direction", MANUAL_DIRECTIONS)?;
    let amount_xof = json::positive_i64(input, "amountXof", "Montant du mouvement de caisse")?;
    let description = json::text_field(input, "description", 3, 200, "Motif")?;
    let session = session_by_id(pool, &session_id).await?;
    if text(&session, "status").as_deref() != Some("OPEN") {
        return Err(conflict("Impossible d'ajouter un mouvement sur une session clôturée."));
    }
    let theoretical = number(&session, "theoreticalClosingXof");
    if direction == "OUT" && theoretical < amount_xof {
        return Err(conflict(format!(
            "Solde espèces théorique insuffisant ({theoretical} FCFA disponible, retrait demandé {amount_xof} FCFA)."
        )));
    }
    let movement_type = if direction == "IN" { "MANUAL_IN" } else { "MANUAL_OUT" };
    let signed = if direction == "IN" { amount_xof } else { -amount_xof };
    let movement_id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO cash_movements (
               id, cash_session_id, movement_type, amount_signed_xof,
               reference_type, reference_id, description, user_id
             ) VALUES (?, ?, ?, ?, 'MANUAL', ?, ?, ?)",
        )
        .bind(&movement_id)
        .bind(&session_id)
        .bind(movement_type)
        .bind(signed)
        .bind(&movement_id)
        .bind(&description)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "CASH_MANUAL_MOVEMENT",
            "cash_movements",
            &movement_id,
            &json!({
                "cashSessionId": session_id, "movementType": movement_type,
                "amountXof": amount_xof, "description": description
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
    session_by_id(pool, &session_id).await
}

pub async fn close_session(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let session_id = json::id_field(input)?;
    let declared = json::non_negative_i64(input, "declaredClosingXof", "Montant compté en caisse")?;
    let notes = json::optional_text(input, "notes", 300, "Notes")?;
    let session = session_by_id(pool, &session_id).await?;
    if text(&session, "status").as_deref() != Some("OPEN") {
        return Err(conflict("Cette session de caisse est déjà clôturée."));
    }
    let theoretical = number(&session, "theoreticalClosingXof");
    let variance = declared - theoretical;
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE cash_sessions
             SET status = 'CLOSED', closed_by_user_id = ?,
                 theoretical_closing_xof = ?, declared_closing_xof = ?,
                 variance_xof = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 notes = COALESCE(?, notes)
             WHERE id = ? AND status = 'OPEN'",
        )
        .bind(actor_user_id)
        .bind(theoretical)
        .bind(declared)
        .bind(variance)
        .bind(&notes)
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
        if variance != 0 {
            let label = format!("{} FCFA", if variance > 0 { format!("+{variance}") } else { variance.to_string() });
            let description = match &notes {
                Some(value) => format!("Écart de clôture ({label}) : {value}"),
                None => format!("Écart constaté à la clôture ({label})"),
            };
            sqlx::query(
                "INSERT INTO cash_movements (
                   id, cash_session_id, movement_type, amount_signed_xof,
                   reference_type, reference_id, description, user_id
                 ) VALUES (?, ?, 'CLOSING_ADJUSTMENT', ?, 'CASH_SESSION', ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(&session_id)
            .bind(variance)
            .bind(&session_id)
            .bind(description)
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;
        }
        audit(
            &mut *tx,
            actor_user_id,
            "CASH_SESSION_CLOSED",
            "cash_sessions",
            &session_id,
            &json!({
                "theoreticalClosingXof": theoretical, "declaredClosingXof": declared,
                "varianceXof": variance, "notes": notes
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
    session_by_id(pool, &session_id).await
}

pub async fn override_session(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let session_id = json::id_field(input)?;
    let corrected = json::non_negative_i64(input, "correctedDeclaredXof", "Nouveau montant compté corrigé")?;
    let justification = json::text_field(input, "justification", 5, 300, "Justification")?;
    let session = session_by_id(pool, &session_id).await?;
    if text(&session, "status").as_deref() != Some("CLOSED") {
        return Err(conflict(
            "La correction administrative s'applique uniquement à une session déjà clôturée.",
        ));
    }
    let old_declared = session
        .get("declaredClosingXof")
        .and_then(Value::as_i64)
        .unwrap_or(number(&session, "theoreticalClosingXof"));
    let adjustment_delta = corrected - old_declared;
    let new_variance = corrected - number(&session, "theoreticalClosingXof");
    let previous_notes = text(&session, "notes");
    let notes = match previous_notes {
        Some(value) => format!("{value} | Rectif: {justification}"),
        None => format!("Rectif: {justification}"),
    };
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE cash_sessions
             SET declared_closing_xof = ?, variance_xof = ?, notes = ? WHERE id = ?",
        )
        .bind(corrected)
        .bind(new_variance)
        .bind(&notes)
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
        if adjustment_delta != 0 {
            sqlx::query(
                "INSERT INTO cash_movements (
                   id, cash_session_id, movement_type, amount_signed_xof,
                   reference_type, reference_id, description, user_id
                 ) VALUES (?, ?, 'CLOSING_ADJUSTMENT', ?, 'CASH_OVERRIDE', ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(&session_id)
            .bind(adjustment_delta)
            .bind(&session_id)
            .bind(format!("Correction administrative clôture : {justification}"))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;
        }
        audit(
            &mut *tx,
            actor_user_id,
            "CASH_SESSION_OVERRIDE",
            "cash_sessions",
            &session_id,
            &json!({
                "previousDeclaredXof": old_declared, "correctedDeclaredXof": corrected,
                "newVarianceXof": new_variance, "justification": justification
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
    session_by_id(pool, &session_id).await
}

pub async fn list_expense_categories(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows = sqlx::query("SELECT id, name, description FROM expense_categories ORDER BY name ASC")
        .fetch_all(pool)
        .await?;
    Ok(json::rows_to_json(rows, &[]))
}

pub async fn create_expense_category(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let name = json::text_field(input, "name", 2, 80, "Nom de catégorie")?;
    let description = json::optional_text(input, "description", 200, "Description")?;
    let duplicate: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM expense_categories WHERE LOWER(name) = LOWER(?)",
    )
    .bind(&name)
    .fetch_optional(pool)
    .await?;
    if duplicate.is_some() {
        return Err(conflict(format!("La catégorie « {name} » existe déjà.")));
    }
    let id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query("INSERT INTO expense_categories (id, name, description) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(&name)
            .bind(&description)
            .execute(&mut *tx)
            .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "EXPENSE_CATEGORY_CREATED",
            "expense_categories",
            &id,
            &json!({ "name": name }),
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
    Ok(json!({ "id": id, "name": name, "description": description }))
}

async fn list_expenses_query(
    pool: &SqlitePool,
    category_id: Option<String>,
    payment_method: Option<String>,
    limit: i64,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT ex.id, ex.category_id, ec.name AS category_name, ex.amount_xof,
                ex.payment_method, ex.cash_session_id, ex.receipt_reference,
                ex.description, ex.expense_date, ex.user_id,
                COALESCE(e.full_name, u.username) AS user_name, ex.created_at
         FROM expenses ex
         JOIN expense_categories ec ON ec.id = ex.category_id
         JOIN users u ON u.id = ex.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE (? IS NULL OR ex.category_id = ?)
           AND (? IS NULL OR ex.payment_method = ?)
         ORDER BY ex.expense_date DESC, ex.created_at DESC
         LIMIT ?",
    )
    .bind(category_id.clone())
    .bind(category_id)
    .bind(payment_method.clone())
    .bind(payment_method)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

pub async fn list_expenses(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_expenses_query(
        pool,
        json::opt_str(input, "categoryId"),
        json::opt_str(input, "paymentMethod"),
        bounded_limit(input, 150, 300),
    )
    .await
}

pub async fn record_expense(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let category_id = json::text_field(input, "categoryId", 1, 80, "Catégorie")?;
    let amount_xof = json::positive_i64(input, "amountXof", "Montant de la dépense")?;
    let payment_method = json::enum_field(input, "paymentMethod", PAYMENT_METHODS)?;
    let receipt_reference = json::optional_text(input, "receiptReference", 100, "Justificatif")?;
    let description = json::text_field(input, "description", 3, 240, "Description")?;
    let expense_date = json::opt_str(input, "expenseDate")
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());

    let category: Option<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM expense_categories WHERE id = ?",
    )
    .bind(&category_id)
    .fetch_optional(pool)
    .await?;
    let category = category.ok_or_else(|| not_found("Catégorie de dépense introuvable."))?;

    let open_session: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    if payment_method == "CASH" {
        if let Some(ref session) = open_session {
            let current = session_by_id(pool, &session.0).await?;
            let theoretical = number(&current, "theoreticalClosingXof");
            if theoretical < amount_xof {
                return Err(conflict(format!(
                    "Espèces insuffisantes en caisse ({theoretical} FCFA disponible, dépense {amount_xof} FCFA)."
                )));
            }
        }
    }

    let expense_id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO expenses (
               id, category_id, amount_xof, payment_method, cash_session_id,
               receipt_reference, description, expense_date, user_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&expense_id)
        .bind(&category.0)
        .bind(amount_xof)
        .bind(&payment_method)
        .bind(open_session.as_ref().map(|row| row.0.clone()))
        .bind(&receipt_reference)
        .bind(&description)
        .bind(&expense_date)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;
        if payment_method == "CASH" {
            if let Some(ref session) = open_session {
                sqlx::query(
                    "INSERT INTO cash_movements (
                       id, cash_session_id, movement_type, amount_signed_xof,
                       reference_type, reference_id, description, user_id
                     ) VALUES (?, ?, 'EXPENSE', ?, 'EXPENSE', ?, ?, ?)",
                )
                .bind(json::new_id())
                .bind(&session.0)
                .bind(-amount_xof)
                .bind(&expense_id)
                .bind(format!("Dépense ({}) : {description}", category.1))
                .bind(actor_user_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        audit(
            &mut *tx,
            actor_user_id,
            "EXPENSE_RECORDED",
            "expenses",
            &expense_id,
            &json!({
                "categoryId": category.0, "amountXof": amount_xof,
                "paymentMethod": payment_method,
                "cashSessionId": open_session.as_ref().map(|row| row.0.clone())
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
    let rows = list_expenses_query(pool, None, None, 50).await?;
    find(&rows, "id", &expense_id)
        .cloned()
        .ok_or_else(|| conflict("Dépense enregistrée mais introuvable à la relecture."))
}

pub async fn list_payments(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let payment_method = json::opt_str(input, "paymentMethod");
    let direction = json::opt_str(input, "direction");
    if let Some(ref value) = direction {
        if !DIRECTIONS.contains(&value.as_str()) {
            return Err(validation(format!("Direction invalide : {value}")));
        }
    }
    let rows = sqlx::query(
        "SELECT p.id, p.payment_number, p.direction, p.party_type,
                CASE
                  WHEN p.party_type = 'CUSTOMER' THEN COALESCE(c.full_name, 'Client comptoir')
                  WHEN p.party_type = 'SUPPLIER' THEN COALESCE(s.name, 'Fournisseur')
                  ELSE 'Tiers'
                END AS party_name,
                p.payment_method, p.amount_xof, p.external_reference,
                p.cash_session_id, COALESCE(e.full_name, u.username) AS user_name,
                p.created_at
         FROM payments p
         LEFT JOIN customers c ON p.party_type = 'CUSTOMER' AND c.id = p.party_id
         LEFT JOIN suppliers s ON p.party_type = 'SUPPLIER' AND s.id = p.party_id
         JOIN users u ON u.id = p.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE (? IS NULL OR p.payment_method = ?)
           AND (? IS NULL OR p.direction = ?)
         ORDER BY p.created_at DESC, p.rowid DESC
         LIMIT ?",
    )
    .bind(payment_method.clone())
    .bind(payment_method)
    .bind(direction.clone())
    .bind(direction)
    .bind(bounded_limit(input, 150, 300))
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canaux_et_directions() {
        assert_eq!(BOOL_REGISTERS.len(), 1);
        assert_eq!(PAYMENT_METHODS.len(), 6);
        assert!(DIRECTIONS.contains(&"INBOUND"));
        assert!(MANUAL_DIRECTIONS.contains(&"OUT"));
    }

    #[test]
    fn validation_des_montants_de_caisse() {
        let entree = serde_json::json!({
            "cashRegisterId": "c1", "openingBalanceXof": 25000,
            "amountXof": 500, "direction": "IN"
        });
        assert_eq!(
            json::non_negative_i64(&entree, "openingBalanceXof", "Fond").unwrap(),
            25000
        );
        assert!(json::enum_field(&entree, "direction", MANUAL_DIRECTIONS).is_ok());
        let invalide = serde_json::json!({ "amountXof": 0 });
        assert!(json::positive_i64(&invalide, "amountXof", "Montant").is_err());
    }
}
