//! LOT 10 — Parité LOT 9 : activation d'une restauration différée.
//!
//! Port fidèle de `server/db/pendingRestore.ts`. Appelé AVANT l'ouverture du
//! pool applicatif par `init_sqlite_pool()`. La base active n'est JAMAIS
//! écrasée à chaud ; toute défaillance laisse la base courante intacte et
//! conserve le marqueur pour un diagnostic explicite au redémarrage suivant.

use crate::db::secure_dir;
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
    /// LOT 11 — sceau HMAC-SHA256 (clé locale hors base). Absent = marqueur
    /// non écrit par cette installation → restauration refusée.
    seal: Option<String>,
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

/// LOT 11 — clé de scellement locale (32 octets hex, 0600), à côté de la base.
/// Emplacement historique du fichier de clé (LOT 11.1 → 11.6).
/// Depuis le LOT 11.6 la clé vit dans le trousseau ; ce chemin ne sert plus
/// qu'à détecter une installation antérieure et à la migrer.
pub fn seal_key_path(db_path: &Path) -> PathBuf {
    crate::db::keys::fallback_path(db_path, crate::db::keys::KeyKind::Seal)
}

/// Lit la clé de scellement sans jamais en créer une.
/// `Ok(None)` = cette installation n'a encore jamais scellé (ou la clé n'est
/// pas disponible) : un marqueur ou un manifeste scellé par un AUTRE poste doit
/// alors être refusé, pas vérifié avec une clé neuve.
pub fn read_seal_key(db_path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    Ok(crate::db::keys::load_or_create_key(
        db_path,
        crate::db::keys::KeyKind::Seal,
        false,
    )?
    .map(|loaded| loaded.key))
}

/// Charge la clé de scellement, ou la crée au premier usage.
/// LOT 11.6 : trousseau du système d'abord (option O1), fichier 0600 en repli.
pub fn load_or_create_seal_key(db_path: &Path) -> Result<Vec<u8>, AppError> {
    crate::db::keys::load_or_create_key(db_path, crate::db::keys::KeyKind::Seal, true)?
        .map(|loaded| loaded.key)
        .ok_or_else(|| {
            AppError::Internal("Clé de scellement indisponible sur ce poste.".into())
        })
}

/// Message canonique : ORDRE FIXE, identique à `localSeal.ts` (Node).
fn restore_seal_message(pending: &PendingRestore) -> String {
    [
        crate::domain::backup::RESTORE_SEAL_CONTEXT.to_string(),
        pending.version.to_string(),
        pending.backup_id.clone(),
        pending.staged_path.clone(),
        pending.staged_checksum.clone(),
        pending.confirmation.clone(),
        pending.requested_by_user_id.clone().unwrap_or_default(),
    ]
    .join("|")
}

fn hex_constant_time_eq(left: &str, right: &str) -> bool {
    let (Ok(a), Ok(b)) = (hex::decode(left), hex::decode(right)) else {
        return false;
    };
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let mut diff = 0_u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Vérifie le sceau du marqueur. Ne lève jamais : motif lisible en cas d'échec.
fn verify_restore_seal(db_path: &Path, pending: &PendingRestore) -> Result<(), String> {
    let Some(seal) = pending.seal.as_deref() else {
        return Err(
            "marqueur non scellé : il n'a pas été écrit par cette installation (falsification probable)."
                .into(),
        );
    };
    let key = match read_seal_key(db_path) {
        Ok(Some(key)) => key,
        Ok(None) => {
            return Err("aucune clé de scellement sur cette installation : marqueur provenant d'un autre poste.".into())
        }
        Err(err) => return Err(String::from(err)),
    };
    let expected = hex::encode(hmac_sha256(&key, restore_seal_message(pending).as_bytes()));
    if !hex_constant_time_eq(&expected, seal) {
        return Err("sceau HMAC invalide : marqueur modifié ou forgé.".into());
    }
    Ok(())
}

/// HMAC-SHA256 minimal (RFC 2104) : aucune dépendance nouvelle.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut block = [0_u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(64 + message.len());
    inner.extend(block.iter().map(|b| b ^ 0x36));
    inner.extend_from_slice(message);
    let inner_hash = Sha256::digest(&inner);
    let mut outer = Vec::with_capacity(64 + 32);
    outer.extend(block.iter().map(|b| b ^ 0x5c));
    outer.extend_from_slice(&inner_hash);
    Sha256::digest(&outer).to_vec()
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

    // LOT 11 — le sceau est vérifié AVANT toute autre étape : un marqueur forgé
    // à la main est refusé, la base courante reste intacte.
    if let Err(reason) = verify_restore_seal(db_path, &pending) {
        return Err(AppError::Migration(format!(
            "Restauration refusée : {reason} Aucune base n'a été remplacée. Supprimez {} pour démarrer normalement.",
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

    /// LOT 11 — VECTEUR PARTAGÉ avec Node (`tests/lot11-securite-locale.test.ts`).
    /// Clé 32 octets nuls, message canonique fixe : le HMAC doit être identique
    /// dans les deux runtimes, sinon un marqueur scellé par l'un est refusé par
    /// l'autre (rupture de la portabilité des sauvegardes).
    #[test]
    fn hmac_sha256_vecteur_partage_avec_node() {
        let message = "depotpro-restore-seal-v1|1|b1|/tmp/s.db|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|RESTAURER|u1";
        let digest = hex::encode(hmac_sha256(&vec![0_u8; 32], message.as_bytes()));
        assert_eq!(
            digest,
            "9de55c67ed2c7d01b8a426bd6e216f8d985f259fea3843279486f31845e08e3b"
        );
    }

    #[test]
    fn message_canonique_ordre_fixe() {
        let pending = PendingRestore {
            version: 1,
            backup_id: "b1".into(),
            staged_path: "/tmp/s.db".into(),
            staged_checksum: "a".repeat(64),
            requested_by_user_id: Some("u1".into()),
            confirmation: "RESTAURER".into(),
            seal: None,
        };
        assert_eq!(
            restore_seal_message(&pending),
            format!("depotpro-restore-seal-v1|1|b1|/tmp/s.db|{}|RESTAURER|u1", "a".repeat(64))
        );
    }

    #[test]
    fn sceau_absent_ou_invalide_est_refuse() {
        let dir = std::env::temp_dir().join(format!("depotpro-seal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("depotpro.db");
        let mut pending = PendingRestore {
            version: 1,
            backup_id: "b1".into(),
            staged_path: "/tmp/s.db".into(),
            staged_checksum: "a".repeat(64),
            requested_by_user_id: None,
            confirmation: "RESTAURER".into(),
            seal: None,
        };
        assert!(verify_restore_seal(&db_path, &pending).is_err());

        let key = load_or_create_seal_key(&db_path).unwrap();
        pending.seal = Some(hex::encode(hmac_sha256(&key, restore_seal_message(&pending).as_bytes())));
        assert!(verify_restore_seal(&db_path, &pending).is_ok());

        // Altération d'un seul champ : le sceau ne couvre plus le contenu.
        pending.staged_checksum = "b".repeat(64);
        assert!(verify_restore_seal(&db_path, &pending).is_err());

        let _ = std::fs::remove_dir_all(&dir);
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
