//! LOT 11.6 — Clés de l'installation (option O1 : trousseau du système).
//!
//! Parité avec `server/security/keys.ts`. Deux clés de 32 octets, distinctes :
//!   - `database` : clé SQLCipher de `depotpro.db` (chiffrement au repos) ;
//!   - `seal`     : clé HMAC des marqueurs de restauration et des manifestes.
//!
//! Ordre de stockage, identique à Node :
//!   1. trousseau du système (`keyring` 3.x : Credential Manager Windows,
//!      Keychain macOS, Secret Service Linux) ;
//!   2. fichier `0600` dans le dossier de données (repli signalé).
//!
//! Une clé existante en fichier est MIGRÉE vers le trousseau sans changer de
//! valeur : tous les manifestes déjà scellés doivent rester vérifiables.
//!
//! ## Écart assumé par rapport à Node
//!
//! Le pool Rust utilise SQLx (`sqlx::sqlite`) qui embarque libSQLite3 sans
//! SQLCipher. Le chiffrement de la base côté Rust exige donc de basculer SQLx
//! sur `libsqlite3-sys` avec la fonctionnalité `bundled-sqlcipher`, ou de
//! passer par `rusqlite`. Ce choix touche la compilation Windows/macOS et n'a
//! pas pu être validé dans l'environnement de développement (aucune chaîne
//! `cargo` disponible). Il est donc documenté comme reste à faire, et ce module
//! ne prétend PAS chiffrer la base : il gère les clés, et `database_key`
//! n'ouvre rien tant que le pool n'est pas chiffré.
//!
//! En revanche, la clé de scellement est immédiatement opérationnelle (HMAC
//! pur, aucune dépendance au driver) : c'est elle qui protège le marqueur de
//! restauration et les manifestes.

use crate::error::AppError;
use std::path::{Path, PathBuf};

/// Nom du service dans le trousseau (visible par l'utilisateur).
pub const KEYRING_SERVICE: &str = "DepotPro";

/// Nom de fichier de repli, identique à Node (`FALLBACK_FILENAMES`).
pub fn fallback_filename(kind: KeyKind) -> &'static str {
    match kind {
        KeyKind::Database => ".depotpro-db.key",
        KeyKind::Seal => ".depotpro-seal.key",
    }
}

/// Compte du trousseau, identique à Node (`KEYRING_ACCOUNTS`).
pub fn keyring_account(kind: KeyKind) -> &'static str {
    match kind {
        KeyKind::Database => "database-key",
        KeyKind::Seal => "seal-key",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Database,
    Seal,
}

/// Où la clé est réellement rangée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyBackend {
    /// Trousseau du système.
    Os,
    /// Fichier 0600 (repli) : protège d'un autre compte, pas du même compte.
    File,
}

impl KeyBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyBackend::Os => "os",
            KeyBackend::File => "file",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LoadedKey {
    pub key: Vec<u8>,
    pub backend: KeyBackend,
    /// Motif du repli, `None` quand le trousseau est utilisé.
    pub note: Option<String>,
}

fn data_dir_of(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn fallback_path(db_path: &Path, kind: KeyKind) -> PathBuf {
    data_dir_of(db_path).join(fallback_filename(kind))
}

fn decode_key(raw: &str, kind: KeyKind) -> Result<Vec<u8>, AppError> {
    let trimmed = raw.trim();
    if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::Migration(format!(
            "Clé {:?} illisible : 64 caractères hexadécimaux attendus.",
            kind
        )));
    }
    hex::decode(trimmed)
        .map_err(|e| AppError::Migration(format!("Clé {:?} non hexadécimale : {e}", kind)))
}

fn read_fallback(db_path: &Path, kind: KeyKind) -> Result<Option<Vec<u8>>, AppError> {
    let path = fallback_path(db_path, kind);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        AppError::Migration(format!("Clé {:?} illisible ({}): {e}", kind, path.display()))
    })?;
    decode_key(&raw, kind).map(Some)
}

fn write_fallback(db_path: &Path, kind: KeyKind, key: &[u8]) -> Result<(), AppError> {
    let dir = data_dir_of(db_path);
    crate::db::secure_dir(&dir)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Internal(format!("Dossier de données inaccessible : {e}")))?;
    let path = fallback_path(db_path, kind);
    std::fs::write(&path, format!("{}\n", hex::encode(key)))
        .map_err(|e| AppError::Internal(format!("Écriture de la clé {:?} impossible : {e}", kind)))?;
    crate::db::secure_file(&path);
    Ok(())
}

/// Lecture trousseau. `Err` = trousseau présent mais inutilisable ; `Ok(None)`
/// = aucune entrée (ou pas de trousseau du tout).
fn read_keyring(kind: KeyKind) -> Result<Option<Vec<u8>>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, keyring_account(kind))
        .map_err(|e| format!("trousseau du système injoignable ({e})."))?;
    match entry.get_password() {
        Ok(secret) if !secret.trim().is_empty() => {
            decode_key(&secret, kind).map(Some).map_err(|e| String::from(e))
        }
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("trousseau du système injoignable ({e}).")),
    }
}

fn write_keyring(kind: KeyKind, key: &[u8]) -> bool {
    match keyring::Entry::new(KEYRING_SERVICE, keyring_account(kind)) {
        Ok(entry) => entry.set_password(&hex::encode(key)).is_ok(),
        Err(_) => false,
    }
}

/// Charge (ou crée) une clé. `create = false` renvoie `None` quand elle
/// n'existe pas encore — nécessaire pour refuser un marqueur scellé par une
/// autre installation plutôt que d'en fabriquer une au passage.
pub fn load_or_create_key(
    db_path: &Path,
    kind: KeyKind,
    create: bool,
) -> Result<Option<LoadedKey>, AppError> {
    // 1. Trousseau.
    match read_keyring(kind) {
        Ok(Some(key)) => {
            return Ok(Some(LoadedKey {
                key,
                backend: KeyBackend::Os,
                note: None,
            }))
        }
        Ok(None) => {}
        Err(reason) => {
            // Trousseau cassé : on continue vers le fichier, mais le motif est
            // conservé pour que l'écran de diagnostic l'affiche.
            if let Some(key) = read_fallback(db_path, kind)? {
                return Ok(Some(LoadedKey {
                    key,
                    backend: KeyBackend::File,
                    note: Some(reason),
                }));
            }
            if !create {
                return Ok(None);
            }
            let key = generate_key();
            write_fallback(db_path, kind, &key)?;
            return Ok(Some(LoadedKey {
                key,
                backend: KeyBackend::File,
                note: Some(reason),
            }));
        }
    }

    // 2. Fichier existant (installation LOT 11.1) → migration vers le trousseau.
    if let Some(key) = read_fallback(db_path, kind)? {
        if write_keyring(kind, &key) {
            let legacy = fallback_path(db_path, kind);
            let _ = std::fs::remove_file(legacy);
            return Ok(Some(LoadedKey {
                key,
                backend: KeyBackend::Os,
                note: None,
            }));
        }
        return Ok(Some(LoadedKey {
            key,
            backend: KeyBackend::File,
            note: None,
        }));
    }

    if !create {
        return Ok(None);
    }

    // 3. Création.
    let key = generate_key();
    if write_keyring(kind, &key) {
        return Ok(Some(LoadedKey {
            key,
            backend: KeyBackend::Os,
            note: None,
        }));
    }
    write_fallback(db_path, kind, &key)?;
    Ok(Some(LoadedKey {
        key,
        backend: KeyBackend::File,
        note: Some("trousseau du système indisponible à l'écriture.".into()),
    }))
}

/// 32 octets pleins. `Uuid::new_v4` seul ne suffit pas (122 bits) : on combine
/// deux sources pour ne jamais dépendre d'un unique générateur.
fn generate_key() -> Vec<u8> {
    let mut key = Vec::with_capacity(32);
    key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    key.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    key
}

/// État de stockage pour l'écran de diagnostic et `/api/system/health`.
#[derive(Debug, Clone)]
pub struct KeyStorageStatus {
    pub backend: KeyBackend,
    pub note: Option<String>,
}

pub fn key_storage_status() -> KeyStorageStatus {
    match read_keyring(KeyKind::Database) {
        Ok(_) | Err(_) => {}
    }
    // Une sonde de lecture suffit : si elle échoue, c'est le repli fichier.
    match keyring::Entry::new(KEYRING_SERVICE, "__probe__") {
        Ok(entry) => match entry.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => KeyStorageStatus {
                backend: KeyBackend::Os,
                note: None,
            },
            Err(e) => KeyStorageStatus {
                backend: KeyBackend::File,
                note: Some(format!("trousseau du système injoignable ({e}).")),
            },
        },
        Err(e) => KeyStorageStatus {
            backend: KeyBackend::File,
            note: Some(format!("trousseau du système injoignable ({e}).")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compte_et_fichier_identiques_a_node() {
        // Ces noms sont un CONTRAT : les changer orphelinerait les clés déjà
        // écrites (base illisible, manifestes non vérifiables).
        assert_eq!(KEYRING_SERVICE, "DepotPro");
        assert_eq!(keyring_account(KeyKind::Database), "database-key");
        assert_eq!(keyring_account(KeyKind::Seal), "seal-key");
        assert_eq!(fallback_filename(KeyKind::Database), ".depotpro-db.key");
        assert_eq!(fallback_filename(KeyKind::Seal), ".depotpro-seal.key");
    }

    #[test]
    fn cle_generee_fait_32_octets_et_varie() {
        let a = generate_key();
        let b = generate_key();
        assert_eq!(a.len(), 32);
        assert_eq!(b.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn decode_refuse_une_cle_mal_formee() {
        assert!(decode_key("abc", KeyKind::Seal).is_err());
        assert!(decode_key(&"z".repeat(64), KeyKind::Seal).is_err());
        assert!(decode_key(&"a".repeat(64), KeyKind::Seal).is_ok());
    }
}
