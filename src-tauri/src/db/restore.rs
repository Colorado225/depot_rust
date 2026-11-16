//! LOT 10 — Parité LOT 9 : activation d'une restauration différée.
//!
//! Port fidèle de `server/db/pendingRestore.ts`. Appelé AVANT l'ouverture du
//! pool applicatif par `init_sqlite_pool()`. La base active n'est JAMAIS
//! écrasée à chaud ; toute défaillance laisse la base courante intacte et
//! conserve le marqueur pour un diagnostic explicite au redémarrage suivant.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;

pub const RESTORE_CONFIRMATION: &str = "RESTAURER";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRestore {
    version: i64,
    backup_id: String,
    staged_path: String,
    staged_checksum: String,
    requested_by_user_id: Option<String>,
    confirmation: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRestoreInfo {
    pub backup_id: String,
    pub staged_path: String,
    pub pre_restore_copy_path: Option<String>,
    pub applied_at: String,
    pub requested_by_user_id: Option<String>,
}

fn marker_path(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("restore-pending.json")
}

pub fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| AppError::Internal(format!("Lecture de {} impossible : {e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| AppError::Internal(format!("Empreinte SHA-256 impossible : {e}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn connect_options(path: &Path, read_only: bool) -> Result<SqliteConnectOptions, AppError> {
    let url = format!("sqlite://{}", path.to_string_lossy());
    Ok(SqliteConnectOptions::from_str(&url)?
        .create_if_missing(false)
        .read_only(read_only))
}

/// Contrôle complet de la copie staged : magic SQLite, integrity_check, FK,
/// présence de `schema_migrations` et d'un schéma DepotPro CI complet.
async fn assert_staged_healthy(path: &Path) -> Result<(), AppError> {
    let options = connect_options(path, true)?;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;

    let result = async {
        let integrity: (String,) = sqlx::query_as("PRAGMA integrity_check;")
            .fetch_one(&pool)
            .await?;
        if integrity.0.to_lowercase() != "ok" {
            return Err(AppError::Validation(format!(
                "Copie SQLite corrompue (PRAGMA integrity_check = {}).",
                integrity.0
            )));
        }

        let fk_rows = sqlx::query("PRAGMA foreign_key_check;")
            .fetch_all(&pool)
            .await?;
        if !fk_rows.is_empty() {
            return Err(AppError::Validation(format!(
                "Copie SQLite incohérente : {} violation(s) de clé étrangère.",
                fk_rows.len()
            )));
        }

        let tables: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
        )
        .fetch_one(&pool)
        .await?;
        let has_migrations: Option<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations';",
        )
        .fetch_optional(&pool)
        .await?;
        if has_migrations.is_none() || tables.0 < 20 {
            return Err(AppError::Validation(
                "Le fichier ne contient pas un schéma DepotPro CI complet (migrations absentes)."
                    .into(),
            ));
        }
        Ok::<(), sqlx::Error>(())
    }
    .await;

    pool.close().await;
    result?;
    Ok(())
}

fn remove_sidecars(db_path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let mut name = db_path.as_os_str().to_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

async fn checkpoint_current_db(db_path: &Path) -> Result<(), AppError> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connect_options(db_path, false)?)
        .await?;
    let result = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE);")
        .execute(&pool)
        .await;
    pool.close().await;
    result?;
    Ok(())
}

/// Applique le marqueur s'il existe. Renvoie `None` dans le cas nominal.
pub async fn apply_pending_restore(db_path: &Path) -> Result<Option<AppliedRestoreInfo>, AppError> {
    let marker = marker_path(db_path);
    if !marker.exists() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(&marker).map_err(|_| {
        AppError::Migration(format!(
            "Marqueur de restauration illisible ({}). Aucune base n'a été remplacée : supprimez ou corrigez ce fichier puis redémarrez.",
            marker.display()
        ))
    })?;
    let pending: PendingRestore = serde_json::from_str(&raw).map_err(|e| {
        AppError::Migration(format!(
            "Marqueur de restauration invalide ({}) : {e}. Aucune base n'a été remplacée.",
            marker.display()
        ))
    })?;

    if pending.version != 1
        || pending.confirmation != RESTORE_CONFIRMATION
        || pending.backup_id.is_empty()
        || pending.staged_checksum.len() != 64
        || pending.staged_path.is_empty()
    {
        return Err(AppError::Migration(format!(
            "Marqueur de restauration invalide ({}). Aucune base n'a été remplacée.",
            marker.display()
        )));
    }

    let staged = PathBuf::from(&pending.staged_path);
    if !staged.is_file() {
        return Err(AppError::Migration(format!(
            "Copie de restauration introuvable ({}). Base courante conservée.",
            staged.display()
        )));
    }
    if sha256_file(&staged)? != pending.staged_checksum {
        return Err(AppError::Migration(
            "Empreinte SHA-256 de la copie de restauration modifiée. Restauration refusée, base courante conservée."
                .into(),
        ));
    }
    assert_staged_healthy(&staged).await?;

    if db_path.exists() {
        checkpoint_current_db(db_path).await?;
        remove_sidecars(db_path);
    }

    let mut pre_restore_copy_path: Option<String> = None;
    if db_path.exists() {
        let stamp = chrono::Utc::now()
            .format("%Y-%m-%dT%H-%M-%S-%3fZ")
            .to_string();
        let copy = db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!("depotpro.pre-restore-{stamp}.db"));
        std::fs::rename(db_path, &copy).map_err(|e| {
            AppError::Migration(format!(
                "Impossible de conserver la base courante avant restauration : {e}"
            ))
        })?;
        pre_restore_copy_path = Some(copy.to_string_lossy().to_string());
    }

    // Activation par COPIE (la source staged reste vérifiable), avec rollback fichier.
    let copy_result = std::fs::copy(&staged, db_path).and_then(|_| {
        remove_sidecars(db_path);
        Ok(())
    });
    if let Err(err) = copy_result {
        if let Some(copy) = &pre_restore_copy_path {
            let _ = std::fs::remove_file(db_path);
            let _ = std::fs::rename(copy, db_path);
        }
        return Err(AppError::Migration(format!(
            "Échec de l'activation de la restauration : {err}. Base courante restaurée."
        )));
    }

    let _ = std::fs::remove_file(&marker);

    Ok(Some(AppliedRestoreInfo {
        backup_id: pending.backup_id,
        staged_path: pending.staged_path,
        pre_restore_copy_path,
        applied_at: chrono::Utc::now().to_rfc3339(),
        requested_by_user_id: pending.requested_by_user_id,
    }))
}

/// Trace l'activation dans `system_meta` et `audit_logs` (parité LOT 9).
pub async fn record_restore_applied(pool: &SqlitePool, info: &AppliedRestoreInfo) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO system_meta (key, value, category, description)
         VALUES ('backup.last_restore_at', ?, 'BACKUP', 'Dernière restauration appliquée au démarrage')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )
    .bind(&info.applied_at)
    .execute(pool)
    .await?;

    let payload = serde_json::to_string(info).unwrap_or_else(|_| "{}".to_string());
    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, 'BACKUP_RESTORE_APPLIED', 'backup_history', ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(info.requested_by_user_id.as_deref())
    .bind(&info.backup_id)
    .bind(payload)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_est_immuable() {
        assert_eq!(RESTORE_CONFIRMATION, "RESTAURER");
    }

    #[test]
    fn marqueur_est_a_cote_de_la_base() {
        let p = Path::new("/tmp/depot/depotpro.db");
        assert_eq!(
            marker_path(p),
            PathBuf::from("/tmp/depot/restore-pending.json")
        );
    }
}
