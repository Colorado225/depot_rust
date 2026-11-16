//! LOT 10 — Tranche 4 : sauvegardes, portabilité USB, vérification, diagnostics
//! et restauration différée. Port fidèle de `server/repositories/backupRepo.ts`
//! et `server/repositories/reliabilityRepo.ts` (LOT 9), exécuté ENTIÈREMENT en
//! Rust/SQLx, sans backend Node.
//!
//! Invariants conservés : `VACUUM INTO` sur une copie, SHA-256, manifeste
//! `.manifest.json`, contrôle `integrity_check`/`foreign_key_check`, copie
//! `PRE_RESTORE` obligatoire, migrations appliquées sur une base SÉPARÉE, puis
//! marqueur `restore-pending.json` activé avant l'ouverture du pool au prochain
//! démarrage (`db/restore.rs`). La base active n'est jamais écrasée à chaud.

use crate::db::{self, AppState};
use crate::domain::backup as backup_domain;
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::number;
use serde_json::{Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, Instant};

const SNAPSHOT_TABLES: &[&str] = &[
    "users", "products", "stock_balances", "stock_movements", "sales", "sale_items",
    "payments", "customers", "suppliers", "purchase_orders", "goods_receipts",
    "consignment_movements", "cash_sessions", "expenses", "audit_logs",
    "backup_history", "schema_migrations",
];

const REQUIRED_TABLES: &[&str] = &[
    "system_meta", "schema_migrations", "users", "roles", "permissions",
    "role_permissions", "products", "stock_balances", "sales", "payments",
    "consignment_movements", "cash_sessions", "expenses", "audit_logs",
    "backup_history",
];

#[derive(Debug, Clone)]
pub struct BackupPaths {
    pub db_path: PathBuf,
    pub backups_dir: PathBuf,
    pub restore_dir: PathBuf,
    pub migrations_dir: PathBuf,
}

pub fn paths_for(state: &AppState) -> BackupPaths {
    let parent = state
        .db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    BackupPaths {
        db_path: state.db_path.clone(),
        backups_dir: parent.join("backups"),
        restore_dir: parent.join("restore"),
        migrations_dir: db::resolve_migrations_dir(),
    }
}

fn cleanup(files: &[&Path]) {
    for file in files {
        let _ = std::fs::remove_file(file);
    }
}

fn remove_sidecars(db_path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let mut name = db_path.as_os_str().to_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

async fn get_meta(pool: &SqlitePool, key: &str) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM system_meta WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|value| value.0))
}

async fn set_meta(pool: &SqlitePool, key: &str, value: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO system_meta (key, value, category, description)
         VALUES (?, ?, 'BACKUP', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )
    .bind(key)
    .bind(value)
    .bind(format!("Paramètre LOT 9 : {key}"))
    .execute(pool)
    .await?;
    Ok(())
}

async fn audit(
    pool: &SqlitePool,
    user_id: Option<&str>,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(json::new_id())
    .bind(user_id)
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(payload)
    .execute(pool)
    .await?;
    Ok(())
}

async fn audit_tx(
    tx: &mut SqliteConnection,
    user_id: Option<&str>,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(json::new_id())
    .bind(user_id)
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(payload)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

async fn current_lot(pool: &SqlitePool) -> Result<String, AppError> {
    Ok(get_meta(pool, "app.lot_current")
        .await?
        .unwrap_or_else(|| "INCONNU".into()))
}

fn config_value(raw: Option<String>, default: i64, min: i64, max: i64) -> i64 {
    raw.and_then(|value| value.parse::<i64>().ok())
        .filter(|value| (min..=max).contains(value))
        .unwrap_or(default)
}

pub async fn get_config(pool: &SqlitePool) -> Result<Json, AppError> {
    let enabled = get_meta(pool, "backup.auto_enabled").await?.as_deref() != Some("0");
    let hours = config_value(
        get_meta(pool, "backup.auto_interval_hours").await?,
        24,
        1,
        720,
    );
    let retention = config_value(
        get_meta(pool, "backup.retention_count").await?,
        7,
        1,
        365,
    );
    Ok(serde_json::json!({
        "autoEnabled": enabled,
        "autoIntervalHours": hours,
        "retentionCount": retention,
    }))
}

pub async fn update_config(
    pool: &SqlitePool,
    user_id: Option<&str>,
    input: &Json,
) -> Result<Json, AppError> {
    let enabled = json::bool_field(input, "autoEnabled")?;
    let hours = json::i64_field(input, "autoIntervalHours")?;
    let retention = json::i64_field(input, "retentionCount")?;
    if !(1..=720).contains(&hours) || !(1..=365).contains(&retention) {
        return Err(AppError::Validation(
            "autoIntervalHours doit être entre 1 et 720 ; retentionCount entre 1 et 365.".into(),
        ));
    }

    let mut tx = pool.begin().await?;
    let result = async {
        set_meta_in_tx(&mut tx, "backup.auto_enabled", if enabled { "1" } else { "0" }).await?;
        set_meta_in_tx(&mut tx, "backup.auto_interval_hours", &hours.to_string()).await?;
        set_meta_in_tx(&mut tx, "backup.retention_count", &retention.to_string()).await?;
        audit_tx(
            &mut tx,
            user_id,
            "BACKUP_CONFIG_UPDATED",
            "system_meta",
            "backup",
            &serde_json::json!({
                "autoEnabled": enabled,
                "autoIntervalHours": hours,
                "retentionCount": retention,
            })
            .to_string(),
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
    get_config(pool).await
}

async fn set_meta_in_tx(
    tx: &mut SqliteConnection,
    key: &str,
    value: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO system_meta (key, value, category, description)
         VALUES (?, ?, 'BACKUP', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )
    .bind(key)
    .bind(value)
    .bind(format!("Paramètre LOT 9 : {key}"))
    .execute(&mut *tx)
    .await?;
    Ok(())
}

fn to_entry(row: &Json) -> Json {
    let file_path = row
        .get("filePath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let path = PathBuf::from(&file_path);
    let file_exists = path.is_file();
    let stored_checksum = row
        .get("sha256Checksum")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let checksum_matches = file_exists
        && backup_domain::sha256_file(&path)
            .map(|computed| computed == stored_checksum)
            .unwrap_or(false);
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    serde_json::json!({
        "id": row.get("id").and_then(Value::as_str).unwrap_or(""),
        "backupType": row.get("backupType").and_then(Value::as_str).unwrap_or("MANUAL"),
        "origin": row.get("origin").and_then(Value::as_str).unwrap_or("LOCAL"),
        "fileName": file_name,
        "filePath": file_path,
        "fileSizeBytes": number(row, "fileSizeBytes"),
        "sha256Checksum": stored_checksum,
        "integrityStatus": row.get("integrityStatus").and_then(Value::as_str).unwrap_or("FAILED"),
        "createdByUserId": row.get("createdByUserId").and_then(Value::as_str),
        "createdByUsername": row.get("createdByUsername").and_then(Value::as_str),
        "createdAt": row.get("createdAt").and_then(Value::as_str),
        "fileExists": file_exists,
        "checksumMatches": checksum_matches,
        "manifestPresent": backup_domain::manifest_path(&path).is_file(),
    })
}

async fn list_rows(pool: &SqlitePool, limit: i64) -> Result<Vec<Json>, AppError> {
    let rows = sqlx::query(
        "SELECT b.id, b.backup_type, b.origin, b.file_path, b.file_size_bytes,
                b.sha256_checksum, b.integrity_status, b.created_by_user_id,
                u.username AS created_by_username, b.created_at
         FROM backup_history b
         LEFT JOIN users u ON u.id = b.created_by_user_id
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[])
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|row| to_entry(&row))
        .collect())
}

pub async fn get_overview(pool: &SqlitePool, paths: &BackupPaths) -> Result<Json, AppError> {
    let backups = list_rows(pool, 20).await?;
    let totals: (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(file_size_bytes), 0) FROM backup_history",
    )
    .fetch_one(pool)
    .await?;
    let last: (Option<String>,) = sqlx::query_as("SELECT MAX(created_at) FROM backup_history")
        .fetch_one(pool)
        .await?;
    let pending = backup_domain::read_pending_restore(&paths.db_path)?;
    Ok(serde_json::json!({
        "backupsDir": paths.backups_dir.to_string_lossy(),
        "totalBackups": totals.0,
        "totalBytes": totals.1,
        "lastBackupAt": last.0,
        "lastAutoBackupAt": get_meta(pool, "backup.last_auto_at").await?,
        "lastRestoreAt": get_meta(pool, "backup.last_restore_at").await?,
        "config": get_config(pool).await?,
        "pendingRestore": pending,
        "backups": backups,
    }))
}

pub async fn get_backup(pool: &SqlitePool, id: &str) -> Result<Json, AppError> {
    let row = sqlx::query(
        "SELECT b.id, b.backup_type, b.origin, b.file_path, b.file_size_bytes,
                b.sha256_checksum, b.integrity_status, b.created_by_user_id,
                u.username AS created_by_username, b.created_at
         FROM backup_history b
         LEFT JOIN users u ON u.id = b.created_by_user_id
         WHERE b.id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Sauvegarde introuvable : {id}")))?;
    Ok(to_entry(&json::row_to_json(row, &[])))
}

pub async fn get_manifest(pool: &SqlitePool, id: &str) -> Result<Json, AppError> {
    let entry = get_backup(pool, id).await?;
    let file_path = PathBuf::from(
        entry
            .get("filePath")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let checksum = entry
        .get("sha256Checksum")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (status, reason) = backup_domain::inspect_manifest(&file_path, id, checksum);
    if status != "OK" {
        return Err(AppError::Conflict(format!(
            "Manifeste non vérifié : {}",
            reason.unwrap_or(status)
        )));
    }
    backup_domain::read_manifest(&file_path)
}

async fn insert_history(
    tx: &mut SqliteConnection,
    id: &str,
    backup_type: &str,
    origin: &str,
    file_path: &Path,
    size: i64,
    checksum: &str,
    user_id: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO backup_history
           (id, backup_type, origin, file_path, file_size_bytes, sha256_checksum,
            integrity_status, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'VERIFIED', ?)",
    )
    .bind(id)
    .bind(backup_type)
    .bind(origin)
    .bind(file_path.to_string_lossy().to_string())
    .bind(size)
    .bind(checksum)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// Crée une copie cohérente via `VACUUM INTO`, manifeste, historique et audit.
pub async fn create_backup(
    pool: &SqlitePool,
    paths: &BackupPaths,
    user_id: Option<&str>,
    backup_type: &str,
    reason: Option<&str>,
) -> Result<Json, AppError> {
    if !backup_domain::BACKUP_TYPES.contains(&backup_type) {
        return Err(AppError::Validation(format!("Type inconnu : {backup_type}")));
    }
    std::fs::create_dir_all(&paths.backups_dir).map_err(|err| {
        AppError::Internal(format!("Dossier des sauvegardes inaccessible : {err}"))
    })?;

    let id = json::new_id();
    let short = id.chars().take(8).collect::<String>();
    let file_name = format!(
        "depotpro-{}-{}-{}.db",
        backup_type.to_lowercase(),
        backup_domain::file_stamp(),
        short
    );
    let final_path = paths.backups_dir.join(&file_name);
    let tmp_path = paths.backups_dir.join(format!("{file_name}.tmp"));
    let manifest = backup_domain::manifest_path(&final_path);
    cleanup(&[&tmp_path, &final_path, &manifest]);
    if final_path.exists() {
        return Err(AppError::Conflict(format!(
            "Un fichier de sauvegarde existe déjà : {file_name}"
        )));
    }

    let creation: Result<(i64, String), AppError> = async {
        sqlx::query("VACUUM INTO ?")
            .bind(tmp_path.to_string_lossy().to_string())
            .execute(pool)
            .await?;
        let inspection = backup_domain::assert_sqlite_file_healthy(&tmp_path).await?;
        let checksum = backup_domain::sha256_file(&tmp_path)?;
        let size = i64::try_from(
            std::fs::metadata(&tmp_path)
                .map_err(|err| AppError::Internal(format!("Stat de la copie impossible : {err}")))?
                .len(),
        )
        .unwrap_or(i64::MAX);
        std::fs::rename(&tmp_path, &final_path).map_err(|err| {
            AppError::Internal(format!("Activation de la copie impossible : {err}"))
        })?;
        let manifest_value = serde_json::json!({
            "format": "depotpro-backup-manifest",
            "version": 1,
            "app": "DepotPro CI",
            "currency": "XOF",
            "backupId": id,
            "backupType": backup_type,
            "origin": "LOCAL",
            "fileName": file_name,
            "fileSizeBytes": size,
            "sha256": checksum,
            "integrityResult": inspection.integrity_result,
            "foreignKeyViolations": inspection.foreign_key_violations,
            "currentLot": current_lot(pool).await?,
            "createdAt": backup_domain::now_iso(),
        });
        backup_domain::write_manifest(&final_path, &manifest_value)?;
        Ok((size, checksum))
    }
    .await;

    let (size, checksum) = match creation {
        Ok(values) => values,
        Err(err) => {
            cleanup(&[&tmp_path, &final_path, &manifest]);
            return Err(err);
        }
    };

    let mut tx = pool.begin().await?;
    let history = async {
        insert_history(
            &mut tx,
            &id,
            backup_type,
            "LOCAL",
            &final_path,
            size,
            &checksum,
            user_id,
        )
        .await?;
        audit_tx(
            &mut tx,
            user_id,
            &format!("BACKUP_{backup_type}_CREATED"),
            "backup_history",
            &id,
            &serde_json::json!({
                "fileName": file_name,
                "fileSizeBytes": size,
                "sha256": checksum,
                "reason": reason,
            })
            .to_string(),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match history {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            cleanup(&[&final_path, &manifest]);
            return Err(err);
        }
    }

    if backup_type == "AUTO" {
        set_meta(pool, "backup.last_auto_at", &backup_domain::now_iso()).await?;
        let retention = number(&get_config(pool).await?, "retentionCount");
        prune_auto_backups(pool, retention).await?;
    }
    get_backup(pool, &id).await
}

pub async fn run_auto_backup(
    pool: &SqlitePool,
    paths: &BackupPaths,
) -> Result<Json, AppError> {
    create_backup(
        pool,
        paths,
        None,
        "AUTO",
        Some("Déclenchement manuel de la sauvegarde automatique"),
    )
    .await
}

/// Horloge de sauvegarde automatique locale (5 s puis toutes les 15 min).
pub async fn auto_backup_if_due(
    pool: &SqlitePool,
    db_path: &Path,
) -> Result<Option<Json>, AppError> {
    let config = get_config(pool).await?;
    if config.get("autoEnabled").and_then(Value::as_bool) != Some(true) {
        return Ok(None);
    }
    let hours = number(&config, "autoIntervalHours").max(1);
    let last = get_meta(pool, "backup.last_auto_at").await?;
    let due = match last {
        Some(raw) => chrono::DateTime::parse_from_rfc3339(&raw)
            .map(|moment| {
                chrono::Utc::now()
                    .signed_duration_since(moment.with_timezone(&chrono::Utc))
                    .num_hours()
                    >= hours
            })
            .unwrap_or(true),
        None => true,
    };
    if !due {
        return Ok(None);
    }
    let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
    let paths = BackupPaths {
        db_path: db_path.to_path_buf(),
        backups_dir: parent.join("backups"),
        restore_dir: parent.join("restore"),
        migrations_dir: db::resolve_migrations_dir(),
    };
    create_backup(
        pool,
        &paths,
        None,
        "AUTO",
        Some("Sauvegarde automatique locale"),
    )
    .await
    .map(Some)
}

pub async fn prune_auto_backups(pool: &SqlitePool, retention: i64) -> Result<usize, AppError> {
    let rows = sqlx::query(
        "SELECT id, file_path FROM backup_history
         WHERE backup_type = 'AUTO'
         ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(pool)
    .await?;
    let keep = retention.max(1) as usize;
    let mut removed = 0;
    for row in rows.into_iter().skip(keep) {
        let dto = json::row_to_json(row, &[]);
        let id = dto.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let file_path = dto.get("filePath").and_then(Value::as_str).unwrap_or("");
        if !file_path.is_empty() && Path::new(file_path).is_file() {
            if std::fs::remove_file(file_path).is_ok() {
                removed += 1;
            }
        }
        audit(
            pool,
            None,
            "BACKUP_AUTO_PRUNED",
            "backup_history",
            &id,
            "{}",
        )
        .await?;
    }
    Ok(removed)
}

pub async fn verify_backup(
    pool: &SqlitePool,
    id: &str,
    user_id: Option<&str>,
) -> Result<Json, AppError> {
    let entry = get_backup(pool, id).await?;
    let file_path = PathBuf::from(entry.get("filePath").and_then(Value::as_str).unwrap_or(""));
    let stored = entry
        .get("sha256Checksum")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let mut checksum_computed = String::new();
    let mut integrity_result = "non vérifié".to_string();
    let mut foreign_key_violations = 0_i64;
    let mut required_tables_present = false;
    let mut tables_count = 0_i64;
    let mut migrations_count = 0_i64;
    let mut reason: Option<String> = None;

    if !file_path.is_file() {
        reason = Some("Fichier de sauvegarde absent du disque".into());
    } else {
        match backup_domain::sha256_file(&file_path) {
            Ok(computed) => checksum_computed = computed,
            Err(err) => reason = Some(err.to_string()),
        }
        if reason.is_none() {
            match backup_domain::assert_sqlite_file_healthy(&file_path).await {
                Ok(inspection) => {
                    integrity_result = inspection.integrity_result;
                    foreign_key_violations = inspection.foreign_key_violations;
                    required_tables_present = inspection.has_migrations_table;
                    tables_count = inspection.tables_count;
                    migrations_count = inspection.migrations_count;
                }
                Err(err) => reason = Some(err.to_string()),
            }
        }
    }

    let checksum_matches = !checksum_computed.is_empty() && checksum_computed == stored;
    let mut manifest_status = "ABSENT".to_string();
    if reason.is_none() {
        let (status, manifest_reason) =
            backup_domain::inspect_manifest(&file_path, id, &stored);
        manifest_status = status;
        if manifest_status == "MISMATCH" || manifest_status == "UNREADABLE" {
            reason = manifest_reason;
        }
    }
    let status = if reason.is_none()
        && checksum_matches
        && integrity_result.to_lowercase() == "ok"
        && foreign_key_violations == 0
    {
        "OK"
    } else {
        "FAILED"
    };
    let final_reason: Option<String> = reason.or_else(|| {
        if checksum_matches {
            None
        } else {
            Some("Empreinte SHA-256 différente de celle enregistrée".into())
        }
    });

    let mut tx = pool.begin().await?;
    let write = async {
        sqlx::query("UPDATE backup_history SET integrity_status = ? WHERE id = ?")
            .bind(if status == "OK" { "VERIFIED" } else { "FAILED" })
            .bind(id)
            .execute(&mut *tx)
            .await?;
        audit_tx(
            &mut tx,
            user_id,
            "BACKUP_VERIFIED",
            "backup_history",
            id,
            &serde_json::json!({
                "status": status,
                "checksumMatches": checksum_matches,
                "manifestStatus": manifest_status,
                "reason": final_reason.clone(),
            })
            .to_string(),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match write {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }

    Ok(serde_json::json!({
        "backupId": id,
        "status": status,
        "integrityResult": integrity_result,
        "foreignKeyViolations": foreign_key_violations,
        "requiredTablesPresent": required_tables_present,
        "tablesCount": tables_count,
        "migrationsCount": migrations_count,
        "checksumStored": stored,
        "checksumComputed": checksum_computed,
        "checksumMatches": checksum_matches,
        "manifestStatus": manifest_status,
        "checkedAt": backup_domain::now_iso(),
        "reason": final_reason,
    }))
}

pub async fn read_backup_file(pool: &SqlitePool, id: &str) -> Result<Json, AppError> {
    let entry = get_backup(pool, id).await?;
    let file_path = PathBuf::from(entry.get("filePath").and_then(Value::as_str).unwrap_or(""));
    if !file_path.is_file() {
        return Err(AppError::NotFound(
            "Le fichier de sauvegarde a été déplacé ou supprimé.".into(),
        ));
    }
    let verification = verify_backup(pool, id, None).await?;
    if verification.get("status").and_then(Value::as_str) != Some("OK") {
        return Err(AppError::Conflict(format!(
            "Téléchargement refusé : sauvegarde non vérifiée ({}).",
            verification
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("intégrité incertaine")
        )));
    }
    let bytes = std::fs::read(&file_path).map_err(|err| {
        AppError::Internal(format!("Lecture de la sauvegarde impossible : {err}"))
    })?;
    Ok(serde_json::json!({
        "fileName": entry.get("fileName").and_then(Value::as_str).unwrap_or("sauvegarde.db"),
        "fileSizeBytes": i64::try_from(bytes.len()).unwrap_or(i64::MAX),
        "sha256Checksum": entry.get("sha256Checksum").and_then(Value::as_str).unwrap_or(""),
        "mimeType": "application/octet-stream",
        "contentBase64": backup_domain::base64_encode(&bytes),
    }))
}

pub async fn import_external_backup(
    pool: &SqlitePool,
    paths: &BackupPaths,
    user_id: Option<&str>,
    bytes: Vec<u8>,
    original_name: &str,
    source_checksum: Option<String>,
) -> Result<Json, AppError> {
    let max_bytes = config_value(
        get_meta(pool, "backup.import_max_bytes").await?,
        backup_domain::DEFAULT_IMPORT_MAX_BYTES,
        1,
        backup_domain::DEFAULT_IMPORT_MAX_BYTES * 4,
    );
    let size_i64 = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    if bytes.len() < 512 {
        return Err(AppError::Validation(
            "Fichier vide ou tronqué : une sauvegarde DepotPro CI est un fichier SQLite complet."
                .into(),
        ));
    }
    if size_i64 > max_bytes {
        return Err(AppError::Validation(format!(
            "Sauvegarde trop volumineuse ({size_i64} octets, limite {max_bytes} octets)."
        )));
    }
    if &bytes[..16] != backup_domain::SQLITE_MAGIC {
        return Err(AppError::Validation(
            "Le fichier n’est pas une base SQLite (en-tête « SQLite format 3 » absent).".into(),
        ));
    }
    let expected = source_checksum
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    if let Some(value) = &expected {
        let valid = value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit());
        if !valid {
            return Err(AppError::Validation(
                "Empreinte SHA-256 de transfert invalide.".into(),
            ));
        }
    }

    std::fs::create_dir_all(&paths.backups_dir).map_err(|err| {
        AppError::Internal(format!("Dossier des sauvegardes inaccessible : {err}"))
    })?;
    let id = json::new_id();
    let short = id.chars().take(8).collect::<String>();
    let file_name = format!(
        "depotpro-import-{}-{}.db",
        backup_domain::file_stamp(),
        short
    );
    let final_path = paths.backups_dir.join(&file_name);
    let tmp_path = paths.backups_dir.join(format!("{file_name}.tmp"));
    let manifest = backup_domain::manifest_path(&final_path);
    let safe_name = backup_domain::safe_original_name(original_name);
    cleanup(&[&tmp_path]);

    let staged: Result<(String, String, i64), AppError> = async {
        backup_domain::write_private_bytes(&tmp_path, &bytes)?;
        let checksum = backup_domain::sha256_file(&tmp_path)?;
        if let Some(value) = &expected {
            if *value != checksum {
                return Err(AppError::Validation(
                    "Empreinte SHA-256 de transfert différente du fichier reçu : copie interrompue ou modifiée."
                        .into(),
                ));
            }
        }
        let inspection = backup_domain::assert_sqlite_file_healthy(&tmp_path).await?;
        std::fs::rename(&tmp_path, &final_path).map_err(|err| {
            AppError::Internal(format!("Activation de l'import impossible : {err}"))
        })?;
        let manifest_value = serde_json::json!({
            "format": "depotpro-backup-manifest",
            "version": 1,
            "app": "DepotPro CI",
            "currency": "XOF",
            "backupId": id,
            "backupType": "USB_EXPORT",
            "origin": "IMPORTED",
            "fileName": file_name,
            "fileSizeBytes": size_i64,
            "sha256": checksum,
            "integrityResult": inspection.integrity_result,
            "foreignKeyViolations": inspection.foreign_key_violations,
            "currentLot": current_lot(pool).await?,
            "createdAt": backup_domain::now_iso(),
        });
        backup_domain::write_manifest(&final_path, &manifest_value)?;
        Ok((checksum, inspection.integrity_result, inspection.foreign_key_violations))
    }
    .await;

    let (checksum, _integrity, _violations) = match staged {
        Ok(values) => values,
        Err(err) => {
            cleanup(&[&tmp_path, &final_path, &manifest]);
            return Err(err);
        }
    };

    let mut tx = pool.begin().await?;
    let history = async {
        insert_history(
            &mut tx,
            &id,
            "USB_EXPORT",
            "IMPORTED",
            &final_path,
            size_i64,
            &checksum,
            user_id,
        )
        .await?;
        audit_tx(
            &mut tx,
            user_id,
            "BACKUP_IMPORTED",
            "backup_history",
            &id,
            &serde_json::json!({
                "originalName": safe_name,
                "fileName": file_name,
                "fileSizeBytes": size_i64,
                "sha256": checksum,
            })
            .to_string(),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match history {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            cleanup(&[&final_path, &manifest]);
            return Err(err);
        }
    }
    get_backup(pool, &id).await
}

async fn snapshot_rows(pool: &SqlitePool) -> Result<Json, AppError> {
    let mut out = Map::new();
    for table in SNAPSHOT_TABLES {
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind(*table)
        .fetch_optional(pool)
        .await?;
        let count = if exists.is_some() {
            let sql = format!(
                "SELECT COUNT(*) FROM {}",
                backup_domain::quote_ident(table)
            );
            let row: (i64,) = sqlx::query_as(&sql).fetch_one(pool).await?;
            row.0
        } else {
            0
        };
        out.insert((*table).to_string(), Value::from(count));
    }
    Ok(Value::Object(out))
}

fn staged_connect_options(path: &Path) -> Result<SqliteConnectOptions, AppError> {
    let url = format!("sqlite://{}", path.to_string_lossy());
    Ok(SqliteConnectOptions::from_str(&url)?
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5)))
}

pub async fn restore_backup(
    pool: &SqlitePool,
    paths: &BackupPaths,
    user_id: Option<&str>,
    input: &Json,
) -> Result<Json, AppError> {
    let id = json::str_field(input, "id")?;
    let confirmation = json::str_field(input, "confirmation")?;
    if confirmation != backup_domain::RESTORE_CONFIRMATION {
        return Err(AppError::Validation(format!(
            "Confirmation requise : saisissez exactement « {} » pour restaurer.",
            backup_domain::RESTORE_CONFIRMATION
        )));
    }
    let activate_on_restart = json::opt_bool(input, "activateOnRestart").unwrap_or(true);
    if activate_on_restart
        && backup_domain::read_pending_restore(&paths.db_path)?.is_some()
    {
        return Err(AppError::Conflict(
            "Une restauration est déjà programmée. Annulez-la ou redémarrez l’application avant d’en préparer une autre."
                .into(),
        ));
    }

    let verification = verify_backup(pool, &id, user_id).await?;
    if verification.get("status").and_then(Value::as_str) != Some("OK") {
        return Err(AppError::Conflict(format!(
            "Restauration refusée : la sauvegarde n'est pas intègre ({}).",
            verification
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("contrôle échoué")
        )));
    }
    let entry = get_backup(pool, &id).await?;
    let source_path = PathBuf::from(entry.get("filePath").and_then(Value::as_str).unwrap_or(""));

    // 1. Copie PRE_RESTORE obligatoire de la base active.
    let restore_reason = format!("Avant restauration de {id}");
    let pre_restore = create_backup(
        pool,
        paths,
        user_id,
        "PRE_RESTORE",
        Some(restore_reason.as_str()),
    )
    .await?;
    let pre_restore_id = pre_restore
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // 2. Restauration RÉELLE sur une base SÉPARÉE : migrations, contrôles,
    //    snapshots avant/après, puis retour en journal DELETE.
    std::fs::create_dir_all(&paths.restore_dir).map_err(|err| {
        AppError::Internal(format!("Dossier de restauration inaccessible : {err}"))
    })?;
    let staged_path = paths.restore_dir.join(format!(
        "restore-staging-{}-{}.db",
        backup_domain::file_stamp(),
        json::new_id().chars().take(8).collect::<String>()
    ));
    std::fs::copy(&source_path, &staged_path).map_err(|err| {
        AppError::Internal(format!("Copie de restauration impossible : {err}"))
    })?;
    let rows_before = snapshot_rows(pool).await?;

    let staged_result: Result<(Json, i64), AppError> = async {
        let staged_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(staged_connect_options(&staged_path)?)
            .await?;
        let migrations_applied = db::apply_migrations(&staged_pool, &paths.migrations_dir).await?;
        let rows_after = snapshot_rows(&staged_pool).await?;
        let integrity: (String,) = sqlx::query_as("PRAGMA integrity_check;")
            .fetch_one(&staged_pool)
            .await?;
        if integrity.0.to_lowercase() != "ok" {
            staged_pool.close().await;
            return Err(AppError::Validation(
                "PRAGMA integrity_check a échoué sur la base restaurée".into(),
            ));
        }
        let fk_rows = sqlx::query("PRAGMA foreign_key_check;")
            .fetch_all(&staged_pool)
            .await?;
        if !fk_rows.is_empty() {
            staged_pool.close().await;
            return Err(AppError::Validation(format!(
                "{} violation(s) de clé étrangère sur la base restaurée",
                fk_rows.len()
            )));
        }
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE);")
            .execute(&staged_pool)
            .await?;
        sqlx::query("PRAGMA journal_mode = DELETE;")
            .execute(&staged_pool)
            .await?;
        staged_pool.close().await;
        Ok((rows_after, i64::try_from(migrations_applied).unwrap_or(i64::MAX)))
    }
    .await;

    let (rows_after, migrations_applied) = match staged_result {
        Ok(values) => values,
        Err(err) => {
            cleanup(&[&staged_path]);
            remove_sidecars(&staged_path);
            return Err(err);
        }
    };
    remove_sidecars(&staged_path);
    backup_domain::assert_sqlite_file_healthy(&staged_path).await?;
    let staged_checksum = backup_domain::sha256_file(&staged_path)?;

    if activate_on_restart {
        let pending = serde_json::json!({
            "version": 1,
            "backupId": id,
            "sourceChecksum": entry.get("sha256Checksum").and_then(Value::as_str).unwrap_or(""),
            "stagedPath": staged_path.to_string_lossy(),
            "stagedChecksum": staged_checksum,
            "preRestoreBackupId": pre_restore_id,
            "requestedByUserId": user_id,
            "confirmation": backup_domain::RESTORE_CONFIRMATION,
            "createdAt": backup_domain::now_iso(),
        });
        backup_domain::write_pending_restore(&paths.db_path, &pending)?;
    }

    audit(
        pool,
        user_id,
        if activate_on_restart {
            "BACKUP_RESTORE_PREPARED"
        } else {
            "BACKUP_RESTORE_VERIFIED_ONLY"
        },
        "backup_history",
        &id,
        &serde_json::json!({
            "stagedPath": staged_path.to_string_lossy(),
            "stagedChecksum": staged_checksum,
            "preRestoreBackupId": pre_restore_id,
            "migrationsAppliedOnStaged": migrations_applied,
        })
        .to_string(),
    )
    .await?;

    Ok(serde_json::json!({
        "mode": if activate_on_restart { "PENDING_RESTART" } else { "VERIFIED_ONLY" },
        "backupId": id,
        "verification": verification,
        "preRestoreBackupId": pre_restore_id,
        "stagedPath": staged_path.to_string_lossy(),
        "stagedChecksum": staged_checksum,
        "migrationsAppliedOnStaged": migrations_applied,
        "rowsBefore": rows_before,
        "rowsAfter": rows_after,
        "requiresRestart": activate_on_restart,
        "createdAt": backup_domain::now_iso(),
        "message": if activate_on_restart {
            format!(
                "Restauration vérifiée sur une base séparée ({} tables). Redémarrez DepotPro CI hors connexion pour l'activer ; la base actuelle reste intacte d'ici là.",
                number(&verification, "tablesCount")
            )
        } else {
            "Restauration vérifiée sur une base séparée uniquement. La base active n’a pas été modifiée.".to_string()
        },
    }))
}

pub async fn cancel_restore(
    pool: &SqlitePool,
    paths: &BackupPaths,
    user_id: Option<&str>,
) -> Result<Json, AppError> {
    let cancelled = backup_domain::cancel_pending_restore(&paths.db_path)?;
    if cancelled {
        audit(
            pool,
            user_id,
            "BACKUP_RESTORE_CANCELLED",
            "system",
            "restore-pending",
            "{}",
        )
        .await?;
    }
    Ok(serde_json::json!({ "cancelled": cancelled }))
}

// ---------------------------------------------------------------------------
// Diagnostics LOT 9 (10 contrôles) et self-tests de non-régression
// ---------------------------------------------------------------------------

async fn migration_checksum_mismatches(
    pool: &SqlitePool,
    migrations_dir: &Path,
) -> Result<(i64, i64), AppError> {
    let rows = sqlx::query("SELECT filename, checksum_sha256 FROM schema_migrations ORDER BY version ASC")
        .fetch_all(pool)
        .await?;
    let checked = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    let mut mismatches = 0_i64;
    for row in rows {
        let dto = json::row_to_json(row, &[]);
        let filename = dto.get("filename").and_then(Value::as_str).unwrap_or("");
        let stored = dto.get("checksumSha256").and_then(Value::as_str).unwrap_or("");
        let file = migrations_dir.join(filename);
        let computed = std::fs::read(&file)
            .map(|bytes| backup_domain::sha256_hex(&bytes))
            .unwrap_or_default();
        if computed != stored {
            mismatches += 1;
        }
    }
    Ok((checked, mismatches))
}

async fn non_integer_money_columns(pool: &SqlitePool) -> Result<i64, AppError> {
    let tables = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(pool)
    .await?;
    let mut offenders = 0_i64;
    for table in tables {
        let table_name: String = table.try_get(0)?;
        let pragma = format!(
            "PRAGMA table_info({})",
            backup_domain::quote_ident(&table_name)
        );
        let columns = sqlx::query(&pragma).fetch_all(pool).await?;
        for column in columns {
            let column_name: String = column.try_get(1)?;
            if !column_name.ends_with("_xof") {
                continue;
            }
            let sql = format!(
                "SELECT 1 FROM {} WHERE typeof({}) NOT IN ('integer', 'null') LIMIT 1",
                backup_domain::quote_ident(&table_name),
                backup_domain::quote_ident(&column_name)
            );
            if sqlx::query(&sql).fetch_optional(pool).await?.is_some() {
                offenders += 1;
            }
        }
    }
    Ok(offenders)
}

fn check(id: &str, label: &str, passed: bool, details: String) -> Json {
    serde_json::json!({
        "id": id,
        "label": label,
        "status": if passed { "OK" } else { "FAILED" },
        "details": details,
    })
}

pub async fn diagnostics(
    pool: &SqlitePool,
    paths: &BackupPaths,
) -> Result<Json, AppError> {
    let started = Instant::now();
    let mut checks: Vec<Json> = Vec::new();

    let journal: (String,) = sqlx::query_as("PRAGMA journal_mode;")
        .fetch_one(pool)
        .await?;
    let foreign_keys: (i64,) = sqlx::query_as("PRAGMA foreign_keys;")
        .fetch_one(pool)
        .await?;
    let wal_ok = journal.0.to_lowercase() == "wal" && foreign_keys.0 == 1;
    checks.push(check(
        "wal-fk",
        "Journal WAL et clés étrangères actifs",
        wal_ok,
        format!(
            "journal_mode={} ; foreign_keys={}",
            journal.0.to_uppercase(),
            foreign_keys.0
        ),
    ));

    let integrity: (String,) = sqlx::query_as("PRAGMA integrity_check;")
        .fetch_one(pool)
        .await?;
    checks.push(check(
        "integrity-check",
        "Intégrité physique complète (PRAGMA integrity_check)",
        integrity.0.to_lowercase() == "ok",
        format!("Résultat : {}", integrity.0),
    ));

    let fk_rows = sqlx::query("PRAGMA foreign_key_check;")
        .fetch_all(pool)
        .await?;
    checks.push(check(
        "foreign-key-check",
        "Aucune référence orpheline (PRAGMA foreign_key_check)",
        fk_rows.is_empty(),
        format!("{} violation(s) détectée(s)", fk_rows.len()),
    ));

    let present = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .fetch_all(pool)
        .await?
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>(0).ok())
        .collect::<std::collections::HashSet<_>>();
    let missing = REQUIRED_TABLES
        .iter()
        .filter(|table| !present.contains(**table))
        .copied()
        .collect::<Vec<_>>();
    checks.push(check(
        "schema-tables",
        "Schéma DepotPro CI complet",
        missing.is_empty(),
        if missing.is_empty() {
            format!("{} tables critiques présentes", REQUIRED_TABLES.len())
        } else {
            format!("Manquantes : {}", missing.join(", "))
        },
    ));

    let (migration_checked, mismatches) =
        migration_checksum_mismatches(pool, &paths.migrations_dir).await?;
    checks.push(check(
        "migration-checksums",
        "Migrations versionnées non altérées (SHA-256)",
        migration_checked > 0 && mismatches == 0,
        format!("{migration_checked} migration(s) vérifiée(s), {mismatches} anomalie(s)"),
    ));

    let currency = get_meta(pool, "app.currency")
        .await?
        .unwrap_or_else(|| "INCONNUE".into());
    checks.push(check(
        "currency-xof",
        "Devise unique FCFA (XOF)",
        currency == "XOF",
        format!("app.currency = {currency}"),
    ));

    let money_offenders = non_integer_money_columns(pool).await?;
    checks.push(check(
        "xof-integers",
        "Montants XOF strictement entiers en base",
        money_offenders == 0,
        if money_offenders == 0 {
            "Aucune valeur décimale ou texte dans les colonnes *_xof".into()
        } else {
            format!("{money_offenders} colonne(s) contiennent une valeur non entière")
        },
    ));

    let negative_stock: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM stock_balances WHERE quantity_base < 0 OR damaged_quantity_base < 0",
    )
    .fetch_one(pool)
    .await?;
    checks.push(check(
        "no-negative-stock",
        "Aucun stock négatif",
        negative_stock.0 == 0,
        format!("{} ligne(s) négative(s)", negative_stock.0),
    ));

    let owner_backup: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE p.code = 'backup.manage' AND r.code = 'OWNER'",
    )
    .fetch_one(pool)
    .await?;
    let other_roles: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE p.code = 'backup.manage' AND r.code <> 'OWNER' AND r.is_system = 1",
    )
    .fetch_one(pool)
    .await?;
    checks.push(check(
        "backup-rbac",
        "Droit backup.manage réservé au Propriétaire",
        owner_backup.0 == 1 && other_roles.0 == 0,
        format!(
            "OWNER = {} ; autres rôles système = {}",
            if owner_backup.0 > 0 { "oui" } else { "non" },
            other_roles.0
        ),
    ));

    let tables_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_one(pool)
    .await?;
    let migrations_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_migrations")
        .fetch_one(pool)
        .await?;
    let last_backup: (Option<String>,) =
        sqlx::query_as("SELECT MAX(created_at) FROM backup_history")
            .fetch_one(pool)
            .await?;
    checks.push(check(
        "backup-history",
        "Historique des sauvegardes disponible",
        true,
        format!(
            "Dernière sauvegarde : {} (historique consultable)",
            last_backup.0.unwrap_or_else(|| "aucune".into())
        ),
    ));

    let overall = checks
        .iter()
        .all(|entry| entry.get("status").and_then(Value::as_str) == Some("OK"));
    Ok(serde_json::json!({
        "overall": if overall { "OK" } else { "FAILED" },
        "checkedAt": backup_domain::now_iso(),
        "durationMs": i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX),
        "integrityResult": integrity.0,
        "foreignKeyViolations": i64::try_from(fk_rows.len()).unwrap_or(i64::MAX),
        "tablesCount": tables_count.0,
        "migrationsCount": migrations_count.0,
        "migrationChecksumMismatches": mismatches,
        "nonIntegerMoneyColumns": money_offenders,
        "negativeStockRows": negative_stock.0,
        "currency": currency,
        "lastBackupAt": last_backup.0,
        "checks": checks,
    }))
}

pub async fn self_tests(
    pool: &SqlitePool,
    paths: &BackupPaths,
) -> Result<Json, AppError> {
    let report = diagnostics(pool, paths).await?;
    let empty_checks: Vec<Json> = Vec::new();
    let mut checks: Vec<Json> = report
        .get("checks")
        .and_then(Value::as_array)
        .unwrap_or(&empty_checks)
        .iter()
        .map(|entry| {
            serde_json::json!({
                "id": entry.get("id").and_then(Value::as_str).unwrap_or(""),
                "label": entry.get("label").and_then(Value::as_str).unwrap_or(""),
                "passed": entry.get("status").and_then(Value::as_str) == Some("OK"),
                "details": entry.get("details").and_then(Value::as_str).unwrap_or(""),
            })
        })
        .collect();

    let probe_key = "selftest.lot9.rollback.probe";
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO system_meta (key, value, category) VALUES (?, 'TEMP', 'TEST')",
    )
    .bind(probe_key)
    .execute(&mut *tx)
    .await?;
    tx.rollback().await?;
    let residue: Option<(String,)> =
        sqlx::query_as("SELECT value FROM system_meta WHERE key = ?")
            .bind(probe_key)
            .fetch_optional(pool)
            .await?;
    let rollback_ok = residue.is_none();
    checks.push(serde_json::json!({
        "id": "tx-rollback",
        "label": "Rollback transactionnel sans résidu",
        "passed": rollback_ok,
        "details": if rollback_ok {
            "Écriture de test annulée proprement"
        } else {
            "Résidu détecté après ROLLBACK"
        },
    }));

    let offline: (i64,) = sqlx::query_as(
        "SELECT offline_allowed FROM license_state WHERE id = 'local-license'",
    )
    .fetch_one(pool)
    .await?;
    let offline_ok = offline.0 == 1;
    checks.push(serde_json::json!({
        "id": "offline-ready",
        "label": "Fonctionnement 100 % hors ligne préservé",
        "passed": offline_ok,
        "details": if offline_ok {
            "Licence locale offline_allowed = 1, aucune dépendance réseau"
        } else {
            "Mode hors ligne désactivé"
        },
    }));

    let all_passed = checks
        .iter()
        .all(|entry| entry.get("passed").and_then(Value::as_bool) == Some(true));
    Ok(serde_json::json!({
        "allPassed": all_passed,
        "executedAt": backup_domain::now_iso(),
        "checks": checks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_temoins_et_diagnostics() {
        assert_eq!(SNAPSHOT_TABLES.len(), 17);
        assert_eq!(REQUIRED_TABLES.len(), 15);
        assert!(SNAPSHOT_TABLES.contains(&"schema_migrations"));
    }

    #[test]
    fn configuration_bornee() {
        assert_eq!(config_value(Some("24".into()), 24, 1, 720), 24);
        assert_eq!(config_value(Some("9999".into()), 24, 1, 720), 24);
        assert_eq!(config_value(None, 7, 1, 365), 7);
    }
}
