use crate::commands::system::AppState;
use crate::error::AppError;
use crate::models::finance::{
    CashSessionModel, CashSessionStatus, ExpenseModel, OpenCashSessionInput, RecordExpenseInput,
};
use crate::repositories::auth_repo::require_permission;
use sqlx::{FromRow, SqlitePool};
use tauri::State;
use uuid::Uuid;

/// Ouvre une nouvelle session de caisse avec son fond de caisse initial (en FCFA entiers).
/// Vérifie côté backend :
/// - permission `cash.session.operate`
/// - caisse enregistreuse active existante
/// - absence d'une autre session `OPEN` simultanée
/// - écriture atomique dans `cash_sessions`, `cash_movements` (`OPENING`) et `audit_logs`.
pub async fn open_cash_session_impl(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: OpenCashSessionInput,
) -> Result<CashSessionModel, AppError> {
    input.validate()?;

    let register_row = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT id, name, is_active FROM cash_registers WHERE id = ?",
    )
    .bind(input.cash_register_id.trim())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Caisse enregistreuse introuvable.".into()))?;

    if register_row.2 != 1 {
        return Err(AppError::Conflict(
            "Cette caisse enregistreuse est désactivée.".into(),
        ));
    }

    let existing_open = sqlx::query_scalar::<_, String>(
        "SELECT id FROM cash_sessions WHERE status = 'OPEN' LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    if existing_open.is_some() {
        return Err(AppError::Conflict(
            "Une session de caisse est déjà ouverte. Clôturez-la avant d'en ouvrir une nouvelle."
                .into(),
        ));
    }

    let session_id = Uuid::new_v4().to_string();
    let opening_mov_id = Uuid::new_v4().to_string();
    let audit_id = Uuid::new_v4().to_string();
    let clean_notes = input
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO cash_sessions (
            id, cash_register_id, opened_by_user_id, opening_balance_xof, status, notes
        ) VALUES (?, ?, ?, ?, 'OPEN', ?)
        "#,
    )
    .bind(&session_id)
    .bind(&register_row.0)
    .bind(actor_user_id)
    .bind(input.opening_balance_xof)
    .bind(&clean_notes)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO cash_movements (
            id, cash_session_id, movement_type, amount_signed_xof,
            reference_type, reference_id, description, user_id
        ) VALUES (?, ?, 'OPENING', ?, 'CASH_SESSION', ?, ?, ?)
        "#,
    )
    .bind(&opening_mov_id)
    .bind(&session_id)
    .bind(input.opening_balance_xof)
    .bind(&session_id)
    .bind(format!("Ouverture {} — fond initial", register_row.1))
    .bind(actor_user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
        VALUES (?, ?, 'CASH_SESSION_OPENED', 'cash_sessions', ?, ?)
        "#,
    )
    .bind(&audit_id)
    .bind(actor_user_id)
    .bind(&session_id)
    .bind(
        serde_json::json!({
            "cashRegisterId": register_row.0,
            "openingBalanceXof": input.opening_balance_xof,
        })
        .to_string(),
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let created = sqlx::query_as::<_, CashSessionModel>(
        r#"
        SELECT id, cash_register_id, opened_by_user_id, closed_by_user_id,
               opening_balance_xof, theoretical_closing_xof, declared_closing_xof,
               variance_xof, status, opened_at, closed_at, notes
        FROM cash_sessions
        WHERE id = ?
        "#,
    )
    .bind(&session_id)
    .fetch_one(pool)
    .await?;

    Ok(created)
}

#[derive(Debug, FromRow)]
struct ExpenseDbRow {
    id: String,
    category_id: String,
    amount_xof: i64,
    payment_method: crate::models::finance::PaymentMethod,
    cash_session_id: Option<String>,
    receipt_reference: Option<String>,
    description: String,
    expense_date: String,
    user_id: String,
    created_at: String,
    sync_version: i64,
}

/// Enregistre une dépense opérationnelle en garantissant qu'elle est rattachée soit à une session
/// de caisse active (`status = 'OPEN'`), soit explicitement à un compte de trésorerie général.
pub async fn record_expense_impl(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: RecordExpenseInput,
) -> Result<ExpenseModel, AppError> {
    input.validate()?;

    let category_exists =
        sqlx::query_scalar::<_, String>("SELECT name FROM expense_categories WHERE id = ?")
            .bind(input.category_id.trim())
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound("Catégorie de dépense introuvable.".into()))?;

    let active_session_id = if let Some(ref sid) = input.cash_session_id {
        let status = sqlx::query_scalar::<_, CashSessionStatus>(
            "SELECT status FROM cash_sessions WHERE id = ?",
        )
        .bind(sid.trim())
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Session de caisse introuvable.".into()))?;

        if status != CashSessionStatus::Open {
            return Err(AppError::Conflict(
                "Impossible d'imputer une dépense sur une session de caisse déjà clôturée.".into(),
            ));
        }
        Some(sid.trim().to_string())
    } else {
        None
    };

    let expense_id = Uuid::new_v4().to_string();
    let clean_desc = input.description.trim().to_string();
    let clean_ref = input
        .receipt_reference
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO expenses (
            id, category_id, amount_xof, payment_method, cash_session_id,
            receipt_reference, description, expense_date, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&expense_id)
    .bind(input.category_id.trim())
    .bind(input.amount_xof)
    .bind(input.payment_method)
    .bind(&active_session_id)
    .bind(&clean_ref)
    .bind(&clean_desc)
    .bind(input.expense_date.trim())
    .bind(actor_user_id)
    .execute(&mut *tx)
    .await?;

    if let (Some(sid), crate::models::finance::PaymentMethod::Cash) =
        (&active_session_id, input.payment_method)
    {
        sqlx::query(
            r#"
            INSERT INTO cash_movements (
                id, cash_session_id, movement_type, amount_signed_xof,
                reference_type, reference_id, description, user_id
            ) VALUES (?, ?, 'EXPENSE', ?, 'EXPENSE', ?, ?, ?)
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(sid)
        .bind(-input.amount_xof)
        .bind(&expense_id)
        .bind(format!("Dépense ({}) : {}", category_exists, clean_desc))
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        r#"
        INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
        VALUES (?, ?, 'EXPENSE_RECORDED', 'expenses', ?, ?)
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(actor_user_id)
    .bind(&expense_id)
    .bind(
        serde_json::json!({
            "categoryId": input.category_id.trim(),
            "amountXof": input.amount_xof,
            "paymentMethod": input.payment_method,
            "cashSessionId": active_session_id,
            "treasuryAccount": input.treasury_account,
        })
        .to_string(),
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let row = sqlx::query_as::<_, ExpenseDbRow>(
        r#"
        SELECT id, category_id, amount_xof, payment_method, cash_session_id,
               receipt_reference, description, expense_date, user_id, created_at, sync_version
        FROM expenses WHERE id = ?
        "#,
    )
    .bind(&expense_id)
    .fetch_one(pool)
    .await?;

    Ok(ExpenseModel {
        id: row.id,
        category_id: row.category_id,
        amount_xof: row.amount_xof,
        payment_method: row.payment_method,
        cash_session_id: row.cash_session_id,
        treasury_account: input.treasury_account,
        receipt_reference: row.receipt_reference,
        description: row.description,
        expense_date: row.expense_date,
        user_id: row.user_id,
        created_at: row.created_at,
        sync_version: row.sync_version,
    })
}

/// Commande Tauri : ouverture d'une session de caisse par le caissier / gérant / propriétaire.
#[tauri::command]
pub async fn open_cash_session(
    state: State<'_, AppState>,
    token: String,
    input: OpenCashSessionInput,
) -> Result<CashSessionModel, AppError> {
    let user = require_permission(&state.pool, &token, "cash.session.operate").await?;
    open_cash_session_impl(&state.pool, &user.id, input).await
}

/// Commande Tauri : enregistrement d'une dépense opérationnelle.
#[tauri::command]
pub async fn record_expense(
    state: State<'_, AppState>,
    token: String,
    input: RecordExpenseInput,
) -> Result<ExpenseModel, AppError> {
    let user = require_permission(&state.pool, &token, "expense.write").await?;
    record_expense_impl(&state.pool, &user.id, input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::finance::{GeneralTreasuryAccount, PaymentMethod};
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn test_open_cash_session_and_record_expense_flow() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("SQLite en mémoire");

        sqlx::migrate!("../migrations")
            .run(&pool)
            .await
            .expect("Migrations");

        let user_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, role_id, is_active) VALUES (?, 'caissier', 'hash', 'role-cashier', 1)",
        )
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();

        let opened = open_cash_session_impl(
            &pool,
            &user_id,
            OpenCashSessionInput {
                cash_register_id: "reg-main".into(),
                opening_balance_xof: 50_000,
                notes: Some("Service matin".into()),
            },
        )
        .await
        .expect("Ouverture de caisse");

        assert_eq!(opened.status, CashSessionStatus::Open);
        assert_eq!(opened.opening_balance_xof, 50_000);

        // Refus d'une seconde ouverture simultanée
        let dup = open_cash_session_impl(
            &pool,
            &user_id,
            OpenCashSessionInput {
                cash_register_id: "reg-main".into(),
                opening_balance_xof: 10_000,
                notes: None,
            },
        )
        .await;
        assert!(dup.is_err());

        // Dépense liée à la session ouverte
        let exp = record_expense_impl(
            &pool,
            &user_id,
            RecordExpenseInput {
                category_id: "exp-transport".into(),
                amount_xof: 5_000,
                payment_method: PaymentMethod::Cash,
                cash_session_id: Some(opened.id.clone()),
                treasury_account: None,
                receipt_reference: Some("REC-01".into()),
                description: "Carburant livraison".into(),
                expense_date: "2026-11-15".into(),
            },
        )
        .await
        .expect("Dépense espèces sur session");
        assert_eq!(exp.amount_xof, 5_000);

        // Dépense hors session liée au compte de trésorerie général
        let exp_treasury = record_expense_impl(
            &pool,
            &user_id,
            RecordExpenseInput {
                category_id: "exp-utilities".into(),
                amount_xof: 15_000,
                payment_method: PaymentMethod::Wave,
                cash_session_id: None,
                treasury_account: Some(GeneralTreasuryAccount::WaveAccount),
                receipt_reference: None,
                description: "Facture internet".into(),
                expense_date: "2026-11-15".into(),
            },
        )
        .await
        .expect("Dépense Wave sur trésorerie générale");
        assert!(exp_treasury.cash_session_id.is_none());
    }
}
