//! LOT 10 — Tranche 4, primitives des sauvegardes LOT 9 (port Rust de
//! `server/domain/backup.ts`, `server/db/pendingRestore.ts`).
//!
//! Aucune dépendance supplémentaire : SHA-256 (`sha2`), base64 maison pour le
//! transport binaire Tauri, contrôle SQLite via SQLx en lecture seule. Le
//! sidecar Node n'est plus nécessaire pour créer, importer, vérifier ou
//! télécharger une sauvegarde.

use crate::error::AppError;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;

pub const RESTORE_CONFIRMATION: &str = "RESTAURER";
pub const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
pub const DEFAULT_IMPORT_MAX_BYTES: i64 = 256 * 1024 * 1024;
pub const BACKUP_TYPES: &[&str] = &["MANUAL", "AUTO", "USB_EXPORT", "PRE_RESTORE"];
pub const BACKUP_ORIGINS: &[&str] = &["LOCAL", "IMPORTED"];

/// Horodatage ISO strictement identique à `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn file_stamp() -> String {
    now_iso().replace(':', "-").replace('.', "-")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// SHA-256 hexadécimal nu (même contrat que `sha256FileSync` du backend Node).
pub fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file = File::open(path)
        .map_err(|err| AppError::Internal(format!("Lecture {} impossible : {err}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|err| {
            AppError::Internal(format!("Empreinte de {} impossible : {err}", path.display()))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(BASE64_ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub fn base64_decode(value: &str) -> Result<Vec<u8>, AppError> {
    let bytes = value.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(AppError::Validation("Encodage base64 invalide (longueur).".into()));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let padding = chunk.iter().filter(|b| **b == b'=').count();
        if padding > 2 || chunk[..chunk.len() - padding.min(chunk.len())]
            .iter()
            .any(|b| base64_value(*b).is_none())
        {
            return Err(AppError::Validation("Encodage base64 invalide (caractère).".into()));
        }
        if padding > 0 && chunk[chunk.len() - padding..].iter().any(|b| *b != b'=') {
            return Err(AppError::Validation("Encodage base64 invalide (padding).".into()));
        }
        let v0 = base64_value(chunk[0]).unwrap_or(0) as u32;
        let v1 = base64_value(chunk[1]).unwrap_or(0) as u32;
        let v2 = base64_value(chunk[2]).unwrap_or(0) as u32;
        let v3 = base64_value(chunk[3]).unwrap_or(0) as u32;
        let triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
        out.push((triple >> 16) as u8);
        if padding < 2 {
            out.push((triple >> 8) as u8);
        }
        if padding < 1 {
            out.push(triple as u8);
        }
    }
    Ok(out)
}

/// Le nom d'origine n'est JAMAIS utilisé pour construire un chemin.
pub fn safe_original_name(raw: &str) -> String {
    let basename = Path::new(raw)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "sauvegarde.db".to_string());
    basename
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .take(120)
        .collect()
}

pub fn manifest_path(file_path: &Path) -> PathBuf {
    let mut name = file_path.as_os_str().to_os_string();
    name.push(".manifest.json");
    PathBuf::from(name)
}

pub fn pending_restore_marker_path(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("restore-pending.json")
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn write_private(path: &Path, content: &str) -> Result<(), AppError> {
    std::fs::write(path, content).map_err(|err| {
        AppError::Internal(format!("Écriture {} impossible : {err}", path.display()))
    })?;
    restrict_permissions(path);
    Ok(())
}

/// Écrit un fichier binaire importé avec des droits privés (mode 0o600 Unix).
pub fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    std::fs::write(path, bytes).map_err(|err| {
        AppError::Internal(format!("Écriture {} impossible : {err}", path.display()))
    })?;
    restrict_permissions(path);
    Ok(())
}

/// Écrit un manifeste **scellé** (LOT 11). `db_path` localise la clé HMAC.
pub fn write_manifest(
    db_path: &Path,
    file_path: &Path,
    manifest: &Value,
) -> Result<(), AppError> {
    let sealed = seal_manifest_value(db_path, manifest)?;
    let pretty = serde_json::to_string_pretty(&sealed)
        .map_err(|err| AppError::Internal(format!("Manifeste JSON : {err}")))?;
    write_private(&manifest_path(file_path), &format!("{pretty}\n"))
}

/// Version courante : 2 = manifeste SCELLÉ (HMAC-SHA256, LOT 11).
/// La version 1 (LOT 9) reste détectable : statut `UNSEALED`, à recréer.
pub const MANIFEST_VERSION: i64 = 2;

/// Contexte de domaine du sceau de manifeste (identique à `localSeal.ts`).
pub const MANIFEST_SEAL_CONTEXT: &str = "depotpro-manifest-seal-v2";

/// Message canonique du manifeste : ORDRE FIXE, identique au backend Node.
pub fn manifest_seal_message(
    format: &str,
    version: i64,
    backup_id: &str,
    backup_type: &str,
    origin: &str,
    file_name: &str,
    file_size_bytes: i64,
    sha256: &str,
    current_lot: &str,
    created_at: &str,
) -> String {
    [
        MANIFEST_SEAL_CONTEXT.to_string(),
        format.to_string(),
        version.to_string(),
        backup_id.to_string(),
        backup_type.to_string(),
        origin.to_string(),
        file_name.to_string(),
        file_size_bytes.to_string(),
        sha256.to_string(),
        current_lot.to_string(),
        created_at.to_string(),
    ]
    .join("|")
}

/// Scelle un manifeste JSON en y ajoutant le champ `seal`.
pub fn seal_manifest_value(
    db_path: &Path,
    manifest: &Value,
) -> Result<Value, AppError> {
    let key = crate::db::restore::load_or_create_seal_key(db_path)?;
    let message = manifest_seal_message(
        manifest.get("format").and_then(Value::as_str).unwrap_or(""),
        manifest.get("version").and_then(Value::as_i64).unwrap_or(0),
        manifest.get("backupId").and_then(Value::as_str).unwrap_or(""),
        manifest.get("backupType").and_then(Value::as_str).unwrap_or(""),
        manifest.get("origin").and_then(Value::as_str).unwrap_or(""),
        manifest.get("fileName").and_then(Value::as_str).unwrap_or(""),
        manifest.get("fileSizeBytes").and_then(Value::as_i64).unwrap_or(0),
        manifest.get("sha256").and_then(Value::as_str).unwrap_or(""),
        manifest.get("currentLot").and_then(Value::as_str).unwrap_or(""),
        manifest.get("createdAt").and_then(Value::as_str).unwrap_or(""),
    );
    let mut sealed = manifest.clone();
    if let Some(object) = sealed.as_object_mut() {
        object.insert(
            "seal".to_string(),
            Value::String(hex::encode(crate::db::restore::hmac_sha256(
                &key,
                message.as_bytes(),
            ))),
        );
    }
    Ok(sealed)
}

/// Vérifie le sceau d'un manifeste. `false` si absent, non v2 ou invalide.
pub fn verify_manifest_seal(db_path: &Path, manifest: &Value) -> bool {
    let Some(seal) = manifest.get("seal").and_then(Value::as_str) else {
        return false;
    };
    let Ok(key) = crate::db::restore::load_or_create_seal_key(db_path) else {
        return false;
    };
    let message = manifest_seal_message(
        manifest.get("format").and_then(Value::as_str).unwrap_or(""),
        manifest.get("version").and_then(Value::as_i64).unwrap_or(0),
        manifest.get("backupId").and_then(Value::as_str).unwrap_or(""),
        manifest.get("backupType").and_then(Value::as_str).unwrap_or(""),
        manifest.get("origin").and_then(Value::as_str).unwrap_or(""),
        manifest.get("fileName").and_then(Value::as_str).unwrap_or(""),
        manifest.get("fileSizeBytes").and_then(Value::as_i64).unwrap_or(0),
        manifest.get("sha256").and_then(Value::as_str).unwrap_or(""),
        manifest.get("currentLot").and_then(Value::as_str).unwrap_or(""),
        manifest.get("createdAt").and_then(Value::as_str).unwrap_or(""),
    );
    let expected = hex::encode(crate::db::restore::hmac_sha256(&key, message.as_bytes()));
    expected.len() == seal.len()
        && expected
            .bytes()
            .zip(seal.bytes())
            .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// Statut du manifeste : `OK`, `ABSENT`, `MISMATCH`, `UNREADABLE`, `UNSEALED`.
pub fn inspect_manifest(
    db_path: &Path,
    file_path: &Path,
    backup_id: &str,
    expected_sha256: &str,
) -> (String, Option<String>) {
    let path = manifest_path(file_path);
    if !path.is_file() {
        return ("ABSENT".into(), None);
    }
    let parsed: Value = match std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
    {
        Some(value) => value,
        None => {
            return (
                "UNREADABLE".into(),
                Some("Manifeste JSON illisible.".into()),
            )
        }
    };
    if parsed.get("backupId").and_then(Value::as_str) != Some(backup_id)
        || parsed.get("sha256").and_then(Value::as_str) != Some(expected_sha256)
    {
        return (
            "MISMATCH".into(),
            Some("Manifeste incohérent avec l’historique (identifiant ou empreinte).".into()),
        );
    }
    if parsed.get("format").and_then(Value::as_str) != Some("depotpro-backup-manifest") {
        return (
            "UNREADABLE".into(),
            Some("Format de manifeste non reconnu.".into()),
        );
    }
    if parsed.get("version").and_then(Value::as_i64) != Some(MANIFEST_VERSION) {
        return (
            "UNSEALED".into(),
            Some(
                "Manifeste v1 non scellé : recréez la sauvegarde (aucune donnée n'est perdue, le fichier .db reste intact)."
                    .into(),
            ),
        );
    }
    if !verify_manifest_seal(db_path, &parsed) {
        return (
            "MISMATCH".into(),
            Some("Manifeste non authentifié : sceau HMAC invalide (modifié ou forgé).".into()),
        );
    }
    ("OK".into(), None)
}

pub fn read_manifest(file_path: &Path) -> Result<Value, AppError> {
    let path = manifest_path(file_path);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .ok_or_else(|| AppError::NotFound("Aucun manifeste associé à cette sauvegarde.".into()))
}

/// LOT 11 — écrit le marqueur de restauration **scellé** (HMAC-SHA256).
///
/// Le message canonique est construit ICI, avec l'ordre fixe partagé avec
/// `server/security/localSeal.ts` (Node). Sans sceau valide, le marqueur est
/// refusé au démarrage : un accès aux fichiers ne suffit plus à déclencher une
/// restauration.
pub fn write_pending_restore(db_path: &Path, pending: &Value) -> Result<(), AppError> {
    if pending.get("confirmation").and_then(Value::as_str) != Some(RESTORE_CONFIRMATION) {
        return Err(AppError::Validation(
            "Confirmation de restauration invalide.".into(),
        ));
    }
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            AppError::Internal(format!("Dossier applicatif inaccessible : {err}"))
        })?;
    }
    let sealed = seal_marker_value(db_path, pending)?;
    let pretty = serde_json::to_string_pretty(&sealed)
        .map_err(|err| AppError::Internal(format!("Marqueur de restauration : {err}")))?;
    write_private(&pending_restore_marker_path(db_path), &format!("{pretty}\n"))
}

/// Contexte de domaine du sceau : empêche le rejeu d'un sceau d'un autre usage.
pub const RESTORE_SEAL_CONTEXT: &str = "depotpro-restore-seal-v1";

/// Message canonique : ORDRE FIXE, identique à `localSeal.ts` et `db/restore.rs`.
pub fn restore_seal_message(
    version: i64,
    backup_id: &str,
    staged_path: &str,
    staged_checksum: &str,
    confirmation: &str,
    requested_by_user_id: Option<&str>,
) -> String {
    [
        RESTORE_SEAL_CONTEXT.to_string(),
        version.to_string(),
        backup_id.to_string(),
        staged_path.to_string(),
        staged_checksum.to_string(),
        confirmation.to_string(),
        requested_by_user_id.unwrap_or_default().to_string(),
    ]
    .join("|")
}

/// Ajoute (ou remplace) le champ `seal` d'un marqueur JSON.
fn seal_marker_value(db_path: &Path, pending: &Value) -> Result<Value, AppError> {
    let key = crate::db::restore::load_or_create_seal_key(db_path)?;
    let version = pending.get("version").and_then(Value::as_i64).unwrap_or(1);
    let message = restore_seal_message(
        version,
        pending.get("backupId").and_then(Value::as_str).unwrap_or(""),
        pending.get("stagedPath").and_then(Value::as_str).unwrap_or(""),
        pending.get("stagedChecksum").and_then(Value::as_str).unwrap_or(""),
        pending.get("confirmation").and_then(Value::as_str).unwrap_or(""),
        pending.get("requestedByUserId").and_then(Value::as_str),
    );
    let mut sealed = pending.clone();
    if let Some(object) = sealed.as_object_mut() {
        object.insert(
            "seal".to_string(),
            Value::String(hex::encode(crate::db::restore::hmac_sha256(
                &key,
                message.as_bytes(),
            ))),
        );
    }
    Ok(sealed)
}

pub fn read_pending_restore(db_path: &Path) -> Result<Option<Value>, AppError> {
    let marker = pending_restore_marker_path(db_path);
    if !marker.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&marker).map_err(|_| {
        AppError::Internal(format!(
            "Marqueur de restauration illisible ({}). Aucune base n'a été remplacée.",
            marker.display()
        ))
    })?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|err| {
        AppError::Internal(format!("Marqueur de restauration invalide ({err})."))
    })?;
    let valid = parsed.get("version").and_then(Value::as_i64) == Some(1)
        && parsed.get("backupId").and_then(Value::as_str).is_some()
        && parsed.get("stagedPath").and_then(Value::as_str).is_some()
        && parsed.get("stagedChecksum").and_then(Value::as_str).is_some()
        && parsed.get("confirmation").and_then(Value::as_str) == Some(RESTORE_CONFIRMATION);
    if !valid {
        return Err(AppError::Internal(
            "Marqueur de restauration invalide. Aucune base n'a été remplacée.".into(),
        ));
    }
    Ok(Some(parsed))
}

pub fn cancel_pending_restore(db_path: &Path) -> Result<bool, AppError> {
    let marker = pending_restore_marker_path(db_path);
    if !marker.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(&marker).map_err(|err| {
        AppError::Internal(format!("Annulation de la restauration impossible : {err}"))
    })?;
    Ok(true)
}

#[derive(Debug, Clone)]
pub struct SqliteInspection {
    pub integrity_result: String,
    pub foreign_key_violations: i64,
    pub tables_count: i64,
    pub migrations_count: i64,
    pub has_migrations_table: bool,
}

fn connect_options(path: &Path, read_only: bool) -> Result<SqliteConnectOptions, AppError> {
    let url = format!("sqlite://{}", path.to_string_lossy());
    Ok(SqliteConnectOptions::from_str(&url)?
        .create_if_missing(false)
        .read_only(read_only))
}

/// Ouvre une copie SQLite HORS du pool applicatif et la valide complètement.
pub async fn inspect_sqlite_file(path: &Path) -> Result<SqliteInspection, AppError> {
    if !path.is_file() {
        return Err(AppError::NotFound(format!(
            "Fichier SQLite introuvable : {}",
            path.display()
        )));
    }
    let mut file = File::open(path)
        .map_err(|err| AppError::Validation(format!("Fichier illisible : {err}")))?;
    let mut header = [0_u8; 16];
    let read = file
        .read(&mut header)
        .map_err(|err| AppError::Validation(format!("En-tête SQLite illisible : {err}")))?;
    if read != SQLITE_MAGIC.len() || &header != SQLITE_MAGIC {
        return Err(AppError::Validation(
            "Le fichier n’est pas une base SQLite (magic header absent).".into(),
        ));
    }
    drop(file);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connect_options(path, true)?)
        .await?;
    let result = async {
        let integrity: (String,) = sqlx::query_as("PRAGMA integrity_check;")
            .fetch_one(&pool)
            .await?;
        let fk_rows = sqlx::query("PRAGMA foreign_key_check;").fetch_all(&pool).await?;
        let tables: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
        )
        .fetch_one(&pool)
        .await?;
        let migrations_table: Option<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations';",
        )
        .fetch_optional(&pool)
        .await?;
        let migrations_count = if migrations_table.is_some() {
            let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_migrations;")
                .fetch_one(&pool)
                .await?;
            row.0
        } else {
            0
        };
        Ok::<SqliteInspection, sqlx::Error>(SqliteInspection {
            integrity_result: integrity.0,
            foreign_key_violations: i64::try_from(fk_rows.len()).unwrap_or(i64::MAX),
            tables_count: tables.0,
            migrations_count,
            has_migrations_table: migrations_table.is_some(),
        })
    }
    .await;
    pool.close().await;
    result.map_err(AppError::Database)
}

/// Contrôle LOT 9 : utilisé avant tout téléchargement ou restauration.
pub async fn assert_sqlite_file_healthy(path: &Path) -> Result<SqliteInspection, AppError> {
    let inspection = inspect_sqlite_file(path).await?;
    if inspection.integrity_result.to_lowercase() != "ok" {
        return Err(AppError::Validation(format!(
            "Copie SQLite corrompue (PRAGMA integrity_check = {}).",
            inspection.integrity_result
        )));
    }
    if inspection.foreign_key_violations > 0 {
        return Err(AppError::Validation(format!(
            "Copie SQLite incohérente : {} violation(s) de clé étrangère.",
            inspection.foreign_key_violations
        )));
    }
    if !inspection.has_migrations_table || inspection.tables_count < 20 {
        return Err(AppError::Validation(
            "Le fichier ne contient pas un schéma DepotPro CI complet (migrations absentes).".into(),
        ));
    }
    Ok(inspection)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// LOT 11 — VECTEUR PARTAGÉ avec Node (`tests/lot11-securite-locale.test.ts`).
    /// Clé 32 octets nuls : le sceau de manifeste doit être identique dans les
    /// deux runtimes, sinon une sauvegarde scellée par l'un devient
    /// « non authentifiée » pour l'autre.
    #[test]
    fn sceau_manifeste_vecteur_partage_avec_node() {
        let key = vec![0_u8; 32];
        let message = manifest_seal_message(
            "depotpro-backup-manifest",
            2,
            "b1",
            "MANUAL",
            "LOCAL",
            "depotpro-manual.db",
            4096,
            &"c".repeat(64),
            "LOT_9",
            "2026-11-16T00:00:00.000Z",
        );
        assert_eq!(
            hex::encode(crate::db::restore::hmac_sha256(&key, message.as_bytes())),
            "57ec3dfe7077b15d2b8b93fd2ecc16d1a3682fccc400cc423a2a42d881fe791e"
        );
    }

    #[test]
    fn empreinte_du_vecteur_connu() {
        assert_eq!(
            sha256_hex(b"SELECT 1;"),
            "17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a"
        );
    }

    #[test]
    fn base64_aller_retour_et_padding() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert!(base64_decode("Zm9").is_err());
    }

    #[test]
    fn noms_et_marqueur() {
        assert_eq!(safe_original_name("../../clé/USB.db"), "USB.db");
        let db = Path::new("/tmp/depot/depotpro.db");
        assert_eq!(
            pending_restore_marker_path(db),
            PathBuf::from("/tmp/depot/restore-pending.json")
        );
        assert_eq!(manifest_path(Path::new("/tmp/x.db")).to_string_lossy(), "/tmp/x.db.manifest.json");
    }
}
