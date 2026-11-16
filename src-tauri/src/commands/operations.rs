//! LOT 10 — Tranche 2 : 30 commandes Tauri servies par le backend Rust.
//!
//! React UI → Tauri Commands → services de domaine Rust → dépôts SQLx → SQLite.
//! Les lectures exigent une session valide ; les écritures exigent la même
//! permission RBAC que les routes Express (`catalog.products.write`,
//! `stock.adjust`, `purchase.manage`). La permission est vérifiée AVANT toute
//! requête métier. Aucune logique n'est déléguée à la webview.

use crate::db::AppState;
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::auth_repo::{validate_session_token, AuthenticatedUser};
use crate::repositories::{catalog_repo as catalog, purchase_repo as purchases};
use crate::repositories::{stock_repo as stock, supplier_repo as suppliers};
use crate::security::session;
use sqlx::SqlitePool;
use tauri::State;

const PERM_CATALOG: &str = "catalog.products.write";
const PERM_STOCK: &str = "stock.adjust";
const PERM_PURCHASE: &str = "purchase.manage";

fn fail(err: AppError) -> String {
    String::from(err)
}

/// Lecture : `requireAuth` du backend Node (session valide, sans permission dédiée).
async fn read_actor(pool: &SqlitePool, input: &Json) -> Result<AuthenticatedUser, String> {
    validate_session_token(pool, &json::token(input).map_err(fail)?)
        .await
        .map_err(fail)
}

/// Écriture : `requirePermission` du backend Node.
async fn write_actor(
    pool: &SqlitePool,
    input: &Json,
    permission: &str,
) -> Result<AuthenticatedUser, String> {
    session::actor(pool, input, permission).await.map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 2 — Catalogue (12 commandes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn catalog_list_categories(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    catalog::list_categories(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_create_category(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CATALOG).await?;
    catalog::create_category(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_list_brands(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    catalog::list_brands(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_create_brand(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CATALOG).await?;
    catalog::create_brand(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_list_units(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    catalog::list_units(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_list_packaging(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    catalog::list_packaging(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_create_packaging(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CATALOG).await?;
    catalog::create_packaging(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_update_packaging(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CATALOG).await?;
    catalog::update_packaging(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_list_products(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    catalog::list_products(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_create_product(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CATALOG).await?;
    catalog::create_product(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_update_product(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CATALOG).await?;
    catalog::update_product(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn catalog_toggle_product_active(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_CATALOG).await?;
    catalog::toggle_product_active(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 3 — Stocks & mouvements (5 commandes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn stock_list_balances(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    stock::list_balances(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn stock_list_movements(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    stock::list_movements(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn stock_record_movement(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_STOCK).await?;
    stock::record_movement(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn stock_list_inventories(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    stock::list_inventories(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn stock_validate_inventory(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_STOCK).await?;
    stock::validate_inventory(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

// ---------------------------------------------------------------------------
// Fournisseurs (4 commandes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn suppliers_list(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    suppliers::list_suppliers(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn suppliers_create(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    suppliers::create_supplier(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn suppliers_update(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    suppliers::update_supplier(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn suppliers_toggle_active(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    suppliers::toggle_supplier_active(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 4 — Achats, réceptions, règlements et retours (9 commandes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn purchases_list_orders(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    purchases::list_orders(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn purchases_create_order(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    purchases::create_order(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn purchases_validate_order(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    purchases::validate_order(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn purchases_cancel_order(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    purchases::cancel_order(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn purchases_receive_order(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    purchases::receive_order(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn purchases_list_receipts(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    purchases::list_receipts(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn purchases_list_payments(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = read_actor(&state.pool, &input).await?;
    purchases::list_payments(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn purchases_record_payment(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    purchases::record_payment(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn purchases_record_return(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = write_actor(&state.pool, &input, PERM_PURCHASE).await?;
    purchases::record_return(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}
