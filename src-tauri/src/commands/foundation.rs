//! LOT 10 — Tranche 1 : 23 commandes Tauri servies par le backend Rust.
//!
//! Architecture cible du §3 : React UI → Tauri Commands → services Rust →
//! dépôts SQLx → SQLite. Chaque commande reçoit le payload `camelCase` du
//! client (`input`) et renvoie un DTO `camelCase` identique au backend HTTP.
//! Les permissions sont vérifiées AVANT toute lecture/écriture métier.

use crate::db::AppState;
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::auth_repo::AuthenticatedUser;
use crate::repositories::foundation_repo as repo;
use crate::security::session;
use sqlx::SqlitePool;
use tauri::State;

const PERM_ADMIN: &str = "settings.depot.manage";
const PERM_USERS: &str = "auth.users.manage";

fn fail(err: AppError) -> String {
    String::from(err)
}

async fn actor(pool: &SqlitePool, input: &Json, permission: &str) -> Result<AuthenticatedUser, String> {
    session::actor(pool, input, permission).await.map_err(fail)
}

async fn authenticated(pool: &SqlitePool, input: &Json) -> Result<AuthenticatedUser, String> {
    crate::repositories::auth_repo::validate_session_token(pool, &json::token(input).map_err(fail)?)
        .await
        .map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 0 — Système
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_system_health(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _ = input;
    repo::health(&state.pool, &state.db_path).await.map_err(fail)
}

#[tauri::command]
pub async fn get_migrations_status(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_ADMIN).await?;
    repo::migrations(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn get_architectural_decisions(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_ADMIN).await?;
    repo::decisions(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn get_license_state(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_ADMIN).await?;
    repo::license(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn update_local_license(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_ADMIN).await?;
    repo::activate_license(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn reset_local_license(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = actor(&state.pool, &input, PERM_ADMIN).await?;
    repo::reset_trial_license(&state.pool, &user.id).await.map_err(fail)
}

#[tauri::command]
pub async fn trigger_integrity_check(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_ADMIN).await?;
    repo::integrity_check(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn run_foundation_self_test(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_ADMIN).await?;
    repo::foundation_self_tests(&state.pool).await.map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 1 — Authentification, RBAC, utilisateurs
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn auth_bootstrap_status(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _ = input;
    repo::bootstrap(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_initialize_depot(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    repo::initialize_depot(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_login(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    repo::login(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    repo::logout(&state.pool, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_me(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let token = json::token(&input).map_err(fail)?;
    repo::me(&state.pool, &token).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_change_password(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = authenticated(&state.pool, &input).await?;
    // LOT 11 — le jeton courant est transmis pour conserver SA session ; toutes
    // les autres sessions de ce compte sont révoquées par le dépôt.
    let keep_token = json::opt_str(&input, "token");
    repo::change_password(&state.pool, &user.id, keep_token.as_deref(), &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn auth_list_users(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_USERS).await?;
    repo::list_users(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_create_user(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = actor(&state.pool, &input, PERM_USERS).await?;
    repo::create_user(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_toggle_user_status(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = actor(&state.pool, &input, PERM_USERS).await?;
    repo::toggle_user_status(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn auth_unlock_user(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = actor(&state.pool, &input, PERM_USERS).await?;
    repo::unlock_user(&state.pool, &user.id, &input).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_update_user_role(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = actor(&state.pool, &input, PERM_USERS).await?;
    repo::update_user_role(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn auth_list_roles(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_USERS).await?;
    repo::list_roles(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn auth_list_login_logs(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    actor(&state.pool, &input, PERM_USERS).await?;
    repo::list_login_logs(&state.pool, &input).await.map_err(fail)
}

// ---------------------------------------------------------------------------
// LOT 1 — Paramètres du dépôt
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    authenticated(&state.pool, &input).await?;
    repo::settings_get(&state.pool).await.map_err(fail)
}

#[tauri::command]
pub async fn settings_update(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = actor(&state.pool, &input, PERM_ADMIN).await?;
    repo::settings_update(&state.pool, &user.id, &input)
        .await
        .map_err(fail)
}
