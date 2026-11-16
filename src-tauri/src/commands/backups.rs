//! LOT 10 — Tranche 4 : 9 commandes du registre de parité + 4 commandes de
//! service pour les transferts binaires (manifeste, téléchargement, import,
//! export de rapport). Toutes exigent une session valide et la permission
//! `backup.manage` (ou `reports.view` pour l'export), comme les routes Node.

use crate::db::AppState;
use crate::domain::backup as backup_domain;
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::backup_repo as backups;
use crate::repositories::report_export_repo as exports;
use crate::security::session;
use sqlx::SqlitePool;
use tauri::State;

const PERM_BACKUP_MANAGE: &str = "backup.manage";
const PERM_REPORTS_VIEW: &str = "reports.view";

fn fail(err: AppError) -> String {
    String::from(err)
}

async fn backup_actor(
    pool: &SqlitePool,
    input: &Json,
) -> Result<crate::repositories::auth_repo::AuthenticatedUser, String> {
    session::actor(pool, input, PERM_BACKUP_MANAGE)
        .await
        .map_err(fail)
}

async fn reports_actor(
    pool: &SqlitePool,
    input: &Json,
) -> Result<crate::repositories::auth_repo::AuthenticatedUser, String> {
    session::actor(pool, input, PERM_REPORTS_VIEW)
        .await
        .map_err(fail)
}

// ---------------------------------------------------------------------------
// Registre de parité : 9 commandes backup_*
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn backup_overview(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = backup_actor(&state.pool, &input).await?;
    let paths = backups::paths_for(&state);
    backups::get_overview(&state.pool, &paths).await.map_err(fail)
}

#[tauri::command]
pub async fn backup_config_update(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = backup_actor(&state.pool, &input).await?;
    backups::update_config(&state.pool, Some(&user.id), &input)
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn backup_create(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = backup_actor(&state.pool, &input).await?;
    let backup_type = json::opt_str(&input, "type").unwrap_or_else(|| "MANUAL".into());
    if backup_type != "MANUAL" && backup_type != "USB_EXPORT" {
        return Err(fail(AppError::Validation(
            "Type de sauvegarde invalide (MANUAL ou USB_EXPORT).".into(),
        )));
    }
    let reason = if backup_type == "USB_EXPORT" {
        "Export pour support amovible"
    } else {
        "Sauvegarde manuelle"
    };
    let paths = backups::paths_for(&state);
    backups::create_backup(
        &state.pool,
        &paths,
        Some(&user.id),
        &backup_type,
        Some(reason),
    )
    .await
    .map_err(fail)
}

#[tauri::command]
pub async fn backup_auto_run(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = backup_actor(&state.pool, &input).await?;
    let paths = backups::paths_for(&state);
    backups::run_auto_backup(&state.pool, &paths).await.map_err(fail)
}

#[tauri::command]
pub async fn backup_diagnostics(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = backup_actor(&state.pool, &input).await?;
    let paths = backups::paths_for(&state);
    backups::diagnostics(&state.pool, &paths).await.map_err(fail)
}

#[tauri::command]
pub async fn backup_self_test(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = backup_actor(&state.pool, &input).await?;
    let paths = backups::paths_for(&state);
    backups::self_tests(&state.pool, &paths).await.map_err(fail)
}

#[tauri::command]
pub async fn backup_cancel_restore(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = backup_actor(&state.pool, &input).await?;
    let paths = backups::paths_for(&state);
    backups::cancel_restore(&state.pool, &paths, Some(&user.id))
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn backup_verify(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = backup_actor(&state.pool, &input).await?;
    let id = json::id_field(&input).map_err(fail)?;
    backups::verify_backup(&state.pool, &state.db_path, &id, Some(&user.id))
        .await
        .map_err(fail)
}

#[tauri::command]
pub async fn backup_restore(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = backup_actor(&state.pool, &input).await?;
    let _id = json::id_field(&input).map_err(fail)?;
    let paths = backups::paths_for(&state);
    backups::restore_backup(&state.pool, &paths, Some(&user.id), &input)
        .await
        .map_err(fail)
}

// ---------------------------------------------------------------------------
// Services binaires : hors registre des 95 commandes, exclusivement Tauri IPC
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn backup_get_manifest(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = backup_actor(&state.pool, &input).await?;
    let id = json::id_field(&input).map_err(fail)?;
    backups::get_manifest(&state.pool, &state.db_path, &id).await.map_err(fail)
}

#[tauri::command]
pub async fn backup_download_file(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let _user = backup_actor(&state.pool, &input).await?;
    let id = json::id_field(&input).map_err(fail)?;
    backups::read_backup_file(&state.pool, &state.db_path, &id).await.map_err(fail)
}

#[tauri::command]
pub async fn backup_import_file(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = backup_actor(&state.pool, &input).await?;
    let encoded = json::str_field(&input, "contentBase64").map_err(fail)?;
    let bytes = backup_domain::base64_decode(&encoded).map_err(fail)?;
    let original_name = json::opt_str(&input, "originalName").unwrap_or_else(|| "sauvegarde.db".into());
    let source_checksum = json::opt_str(&input, "sourceChecksum");
    let paths = backups::paths_for(&state);
    backups::import_external_backup(
        &state.pool,
        &paths,
        Some(&user.id),
        bytes,
        &original_name,
        source_checksum,
    )
    .await
    .map_err(fail)
}

#[tauri::command]
pub async fn reports_export_file(state: State<'_, AppState>, input: Json) -> Result<Json, String> {
    let user = reports_actor(&state.pool, &input).await?;
    let file = exports::export_dataset(&state.pool, &user.id, &input)
        .await
        .map_err(fail)?;
    Ok(serde_json::json!({
        "filename": file.filename,
        "mimeType": file.mime_type,
        "contentBase64": backup_domain::base64_encode(&file.bytes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permissions_des_routes_node() {
        assert_eq!(PERM_BACKUP_MANAGE, "backup.manage");
        assert_eq!(PERM_REPORTS_VIEW, "reports.view");
    }
}
