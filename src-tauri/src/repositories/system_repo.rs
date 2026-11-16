use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHealth {
    pub app_name: String,
    pub version: String,
    pub runtime: String,
    pub sqlite_version: String,
    pub journal_mode: String,
    pub foreign_keys_enabled: bool,
    pub db_path: String,
    pub db_size_bytes: u64,
    pub applied_migrations_count: i64,
    pub tables_count: i64,
    pub current_lot: String,
    pub offline_ready: bool,
    pub checked_at: String,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRecord {
    pub version: i64,
    pub description: String,
    pub installed_on: String,
    pub success: bool,
    pub checksum: String,
    pub execution_time: i64,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ArchitectureDecision {
    pub key: String,
    pub value: String,
    pub category: String,
    pub description: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LicenseState {
    pub id: String,
    pub edition: String,
    pub status: String,
    pub license_key_masked: Option<String>,
    pub installation_id: String,
    pub depot_name_bound: Option<String>,
    pub activated_at: Option<String>,
    pub expires_at: Option<String>,
    pub offline_allowed: bool,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLicenseInput {
    pub license_key: String,
    pub depot_name_bound: String,
}

pub async fn fetch_system_health(pool: &SqlitePool, db_path: &Path) -> Result<SystemHealth, AppError> {
    let sqlite_version: (String,) = sqlx::query_as("SELECT sqlite_version();").fetch_one(pool).await?;
    let journal_mode: (String,) = sqlx::query_as("PRAGMA journal_mode;").fetch_one(pool).await?;
    let fk_enabled: (i64,) = sqlx::query_as("PRAGMA foreign_keys;").fetch_one(pool).await?;
    let migrations_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_migrations;")
        .fetch_one(pool)
        .await
        .unwrap_or((0,));
    let tables_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
    )
    .fetch_one(pool)
    .await?;

    let current_lot: (String,) = sqlx::query_as(
        "SELECT value FROM system_meta WHERE key = 'app.lot_current';",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(("LOT_0".to_string(),));

    let db_size_bytes = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);

    Ok(SystemHealth {
        app_name: "DepotPro CI".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        runtime: "TAURI_RUST_SQLX".to_string(),
        sqlite_version: sqlite_version.0,
        journal_mode: journal_mode.0.to_uppercase(),
        foreign_keys_enabled: fk_enabled.0 == 1,
        db_path: db_path.to_string_lossy().to_string(),
        db_size_bytes,
        applied_migrations_count: migrations_count.0,
        tables_count: tables_count.0,
        current_lot: current_lot.0,
        offline_ready: true,
        checked_at: chrono::Utc::now().to_rfc3339(),
    })
}

pub async fn run_integrity_check(pool: &SqlitePool) -> Result<String, AppError> {
    let result: (String,) = sqlx::query_as("PRAGMA quick_check;").fetch_one(pool).await?;
    Ok(result.0)
}

pub async fn fetch_decisions(pool: &SqlitePool) -> Result<Vec<ArchitectureDecision>, AppError> {
    let rows = sqlx::query_as::<_, ArchitectureDecision>(
        "SELECT key, value, category, description, updated_at FROM system_meta ORDER BY category, key;",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn fetch_license_state(pool: &SqlitePool) -> Result<LicenseState, AppError> {
    let row = sqlx::query_as::<_, LicenseState>(
        "SELECT id, edition, status, license_key_masked, installation_id, depot_name_bound, activated_at, expires_at, offline_allowed, updated_at FROM license_state WHERE id = 'local-license';",
    )
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn activate_local_license(
    pool: &SqlitePool,
    input: UpdateLicenseInput,
) -> Result<LicenseState, AppError> {
    let clean_key = input.license_key.trim().to_uppercase();
    if !clean_key.starts_with("DPCI-") || clean_key.len() < 12 {
        return Err(AppError::Validation(
            "Format de clé locale invalide (attendu : DPCI-XXXX-XXXX).".into(),
        ));
    }
    let clean_depot = input.depot_name_bound.trim();
    if clean_depot.len() < 2 {
        return Err(AppError::Validation(
            "Veuillez indiquer le nom du dépôt associé à la licence locale.".into(),
        ));
    }

    let masked = format!(
        "DPCI-****-{}",
        &clean_key[clean_key.len().saturating_sub(4)..]
    );

    sqlx::query(
        "UPDATE license_state SET status = 'ACTIVE_OFFLINE', license_key_masked = ?, depot_name_bound = ?, activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'local-license';",
    )
    .bind(&masked)
    .bind(clean_depot)
    .execute(pool)
    .await?;

    fetch_license_state(pool).await
}
