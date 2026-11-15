use crate::repositories::system_repo::{
    activate_local_license, fetch_decisions, fetch_license_state, fetch_system_health,
    run_integrity_check, ArchitectureDecision, LicenseState, SystemHealth, UpdateLicenseInput,
};
use sqlx::SqlitePool;
use std::path::PathBuf;
use tauri::State;

pub struct AppState {
    pub pool: SqlitePool,
    pub db_path: PathBuf,
}

#[tauri::command]
pub async fn check_system_health(state: State<'_, AppState>) -> Result<SystemHealth, String> {
    fetch_system_health(&state.pool, &state.db_path)
        .await
        .map_err(String::from)
}

#[tauri::command]
pub async fn get_architectural_decisions(
    state: State<'_, AppState>,
) -> Result<Vec<ArchitectureDecision>, String> {
    fetch_decisions(&state.pool).await.map_err(String::from)
}

#[tauri::command]
pub async fn get_license_state(state: State<'_, AppState>) -> Result<LicenseState, String> {
    fetch_license_state(&state.pool).await.map_err(String::from)
}

#[tauri::command]
pub async fn update_local_license(
    state: State<'_, AppState>,
    input: UpdateLicenseInput,
) -> Result<LicenseState, String> {
    activate_local_license(&state.pool, input)
        .await
        .map_err(String::from)
}

#[tauri::command]
pub async fn trigger_integrity_check(state: State<'_, AppState>) -> Result<String, String> {
    run_integrity_check(&state.pool).await.map_err(String::from)
}
