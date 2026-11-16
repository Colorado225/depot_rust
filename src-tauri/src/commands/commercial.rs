//! LOT 10 — Tranche 3 : 33 commandes Tauri servies par le backend Rust.
//!
//! React UI → Tauri Commands → services de domaine Rust → dépôts SQLx → SQLite.
//! Permissions RBAC identiques aux routes Express de référence :
//! `pos.sale.create`, `pos.sale.cancel`, `pos.discount.apply`,
//! `consignment.manage`, `cash.session.operate`, `cash.session.override`,
//! `expense.write`, `reports.view`. Les lectures exigent une session valide.
//! Aucune logique métier n'est exécutée dans la webview ni dans un backend Node.

use crate::db::AppState;
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::auth_repo::{validate_session_token, AuthenticatedUser};
use crate::repositories::{
    consignment_repo as consignments, customer_repo as customers, finance_repo as finance,
    pos_repo as pos, reports_repo as reports,
};
use crate::security::session;
use sqlx::SqlitePool;
use tauri::State;

const PERM_SALE_CREATE: &str = "pos.sale.create";
const PERM_SALE_CANCEL: &str = "pos.sale.cancel";
const PERM_DISCOUNT: &str = "pos.discount.apply";
const PERM_CONSIGNMENT: &str = "consignment.manage";
const PERM_CASH_OPERATE: &str = "cash.session.operate";
const PERM_CASH_OVERRIDE: &str = "cash.session.override";
const PERM_EXPENSE_WRITE: &str = "expense.write";
const PERM_REPORTS_VIEW: &str = "reports.view";

fn fail(err: AppError) -> String {
    String::from(err)
}

/// `requireAuth` du backend Node : session valide, sans permission dédiée.
async fn read_actor(pool: &SqlitePool, input: &Json) -> Result<AuthenticatedUser, String> {
    validate_session_token(pool, &json::token(input).map_err(fail)?)
        .await
        .map_err(fail)
}

/// `requirePermission` du backend Node : session + permission vérifiées AVANT
/// la moindre requête métier.
async fn write_actor(
    pool: &SqlitePool,
    input: &Json,
    permission: &str,
) -> Result<AuthenticatedUser, String> {
    session::actor(pool, input, permission).await.map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 5 — Clients & créances (6 commandes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn customers_list(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    customers::list_customers(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn customers_statement(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    customers::customer_statement(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn customers_create(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_SALE_CREATE).await?;
    customers::create_customer(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn customers_update(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_SALE_CREATE).await?;
    customers::update_customer(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn customers_toggle_active(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_SALE_CREATE).await?;
    customers::toggle_customer_active(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn customers_record_payment(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_SALE_CREATE).await?;
    customers::record_customer_payment(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 5 — Point de vente (3 commandes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pos_list_sales(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    pos::list_sales(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn pos_create_sale(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_SALE_CREATE).await?;
    // `posRepo.ts` vérifie cette permission supplémentaire UNIQUEMENT si une
    // remise est appliquée. Le droit est lu depuis la session Rust chargée.
    let discount_allowed = user
        .permissions
        .iter()
        .any(|permission| permission == PERM_DISCOUNT);
    pos::create_sale(&state.pool, &user.id, discount_allowed, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn pos_cancel_sale(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_SALE_CANCEL).await?;
    pos::cancel_sale(&state.pool, &user.id, &input).await.map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 6 — Consignes & emballages (7 commandes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn consignments_summary(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    consignments::summary(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn consignments_balances(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    consignments::list_balances(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn consignments_movements(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    consignments::list_movements(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn consignments_customer_return(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CONSIGNMENT).await?;
    consignments::customer_return(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn consignments_customer_operation(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CONSIGNMENT).await?;
    consignments::customer_operation(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn consignments_supplier_operation(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CONSIGNMENT).await?;
    consignments::supplier_operation(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn consignments_depot_operation(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CONSIGNMENT).await?;
    consignments::depot_operation(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 7 — Caisse & trésorerie (13 commandes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn finance_overview(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    finance::overview(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn finance_list_registers(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    finance::list_registers(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn finance_list_sessions(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    finance::list_sessions(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn finance_session_detail(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    finance::session_detail(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn finance_open_session(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CASH_OPERATE).await?;
    finance::open_session(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn finance_manual_movement(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CASH_OPERATE).await?;
    finance::manual_movement(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn finance_close_session(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CASH_OPERATE).await?;
    finance::close_session(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn finance_override_session(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CASH_OVERRIDE).await?;
    finance::override_session(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn finance_list_expense_categories(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    finance::list_expense_categories(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn finance_create_expense_category(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_EXPENSE_WRITE).await?;
    finance::create_expense_category(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn finance_list_expenses(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    finance::list_expenses(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn finance_record_expense(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_EXPENSE_WRITE).await?;
    finance::record_expense(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn finance_list_payments(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    finance::list_payments(&state.pool, &input).await.map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 8 — Rapports (4 commandes ; `requireReportsView` sur toutes les routes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn reports_overview(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = write_actor(&state.pool, &input, PERM_REPORTS_VIEW).await?;
    reports::overview(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn reports_product_margins(
    state: State<'_, AppState>,
    input: Json,
) -> Result<Json, String> {
    let _user = write_actor(&state.pool, &input, PERM_REPORTS_VIEW).await?;
    reports::product_margins(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn reports_snapshot(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = write_actor(&state.pool, &input, PERM_REPORTS_VIEW).await?;
    reports::snapshot(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn reports_daily(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = write_actor(&state.pool, &input, PERM_REPORTS_VIEW).await?;
    reports::daily(&state.pool, &input).await.map_err(fail)
}
