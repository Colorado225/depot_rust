//! LOT 10 — Pool SQLite local, UN SEUL propriétaire du schéma.
//!
//! Le runtime Rust applique lui-même `migrations/*.sql` dans la table
//! `schema_migrations` avec sommes de contrôle SHA-256, exactement comme
//! `server/db/sqlite.ts` (LOT 9). `sqlx::migrate!` est interdit : il créerait
//! une seconde table `_sqlx_migrations`, incompatible avec la base existante.
//!
//! Ordre de démarrage impératif (parité LOT 9) :
//!   1. restauration différée éventuelle, AVANT toute ouverture du pool ;
//!   2. ouverture WAL + FK + synchronous NORMAL + busy_timeout ;
//!   3. création de `schema_migrations` si absente ;
//!   4. application des migrations manquantes, chacune dans une transaction ;
//!   5. traçage de la restauration appliquée.

pub mod restore;

use crate::error::AppError;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, Instant};

/// LOT 11 — permissions privées : 0700 pour les dossiers, 0600 pour les fichiers.
/// Sans effet sur Windows (ACL héritées du profil) : le durcissement Windows
/// reste un point ouvert documenté du LOT 11.
pub fn secure_dir(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|e| {
            AppError::Internal(format!("Permissions du dossier {} : {e}", path.display()))
        })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub fn secure_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// LOT 11 — base et sidecars WAL en 0600, dossier de données en 0700.
pub fn secure_database_files(db_path: &Path) {
    if let Some(parent) = db_path.parent() {
        let _ = secure_dir(parent);
    }
    secure_file(db_path);
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = db_path.as_os_str().to_os_string();
        name.push(suffix);
        secure_file(Path::new(&PathBuf::from(name)));
    }
}

/// État applicatif partagé par toutes les commandes Tauri.
pub struct AppState {
    pub pool: SqlitePool,
    pub db_path: PathBuf,
}

/// Dossier des migrations : fourni par la coquille Tauri en release, sinon
/// chemin du dépôt au moment de la compilation (développement).
pub fn resolve_migrations_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DEPOTPRO_MIGRATIONS_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let compile_time = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../migrations"));
    if compile_time.is_dir() {
        return compile_time;
    }
    PathBuf::from("migrations")
}

fn parse_migration_name(filename: &str) -> Option<(i64, String)> {
    let stem = filename.strip_suffix(".sql")?;
    let split = stem.find('_')?;
    let version = stem[..split].parse::<i64>().ok()?;
    if version <= 0 {
        return None;
    }
    let description = stem[split + 1..].replace('_', " ");
    Some((version, description))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Applique les migrations absentes et renvoie leur nombre.
pub async fn apply_migrations(pool: &SqlitePool, dir: &Path) -> Result<u64, AppError> {
    if !dir.is_dir() {
        return Err(AppError::Migration(format!(
            "Répertoire des migrations introuvable : {}",
            dir.display()
        )));
    }

    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            filename TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL,
            checksum_sha256 TEXT NOT NULL,
            execution_ms INTEGER NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );",
    )
    .execute(pool)
    .await?;

    let applied: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT version, filename, checksum_sha256 FROM schema_migrations ORDER BY version ASC")
            .fetch_all(pool)
            .await?;

    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| AppError::Migration(format!("Lecture de {} impossible : {e}", dir.display())))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".sql"))
        .collect();
    names.sort();

    let mut applied_now = 0_u64;
    for name in names {
        let Some((version, description)) = parse_migration_name(&name) else {
            continue;
        };
        let sql = std::fs::read_to_string(dir.join(&name))
            .map_err(|e| AppError::Migration(format!("Lecture de {name} impossible : {e}")))?;
        let checksum = sha256_hex(sql.as_bytes());

        if let Some((_, _, previous)) = applied.iter().find(|(v, _, _)| *v == version) {
            if previous != &checksum {
                return Err(AppError::Migration(format!(
                    "Somme de contrôle modifiée pour la migration déjà appliquée {name}"
                )));
            }
            continue;
        }

        let started = Instant::now();
        let mut tx = pool.begin().await?;
        let result = async {
            sqlx::raw_sql(&sql).execute(&mut *tx).await?;
            sqlx::query(
                "INSERT INTO schema_migrations
                 (version, filename, description, checksum_sha256, execution_ms)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(version)
            .bind(&name)
            .bind(&description)
            .bind(&checksum)
            .bind(i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX))
            .execute(&mut *tx)
            .await?;
            Ok::<(), sqlx::Error>(())
        }
        .await;

        match result {
            Ok(()) => {
                tx.commit().await?;
                applied_now += 1;
            }
            Err(err) => {
                // Le rollback est explicite : aucune migration partiellement appliquée.
                let _ = tx.rollback().await;
                return Err(AppError::Migration(format!(
                    "Échec d'application de la migration {name} : {err}"
                )));
            }
        }
    }

    Ok(applied_now)
}

/// Initialise la base locale. `restore-pending.json` est traité AVANT l'ouverture.
pub async fn init_sqlite_pool(db_path: &Path) -> Result<SqlitePool, AppError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::Internal(format!("Impossible de créer le répertoire de données : {e}"))
        })?;
        // LOT 11 — dossier privé AVANT toute écriture, y compris le marqueur et la clé.
        secure_dir(parent)?;
    }

    let applied_restore = restore::apply_pending_restore(db_path).await?;

    let db_url = format!("sqlite://{}", db_path.to_string_lossy());
    let options = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // Les PRAGMAs sont (re)affirmés sur la connexion réellement utilisée.
    sqlx::raw_sql("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")
        .execute(&pool)
        .await?;

    let migrations_dir = resolve_migrations_dir();
    apply_migrations(&pool, &migrations_dir).await?;

    if let Some(info) = applied_restore {
        restore::record_restore_applied(&pool, &info).await?;
    }

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_noms_de_migrations() {
        assert_eq!(
            parse_migration_name("0014_lot10_rust_native.sql"),
            Some((14, "lot10 rust native".to_string()))
        );
        assert_eq!(parse_migration_name("README.md"), None);
        assert_eq!(parse_migration_name("0000_bad.sql"), None);
    }

    #[test]
    fn checksum_sha256_stable() {
        assert_eq!(
            sha256_hex(b"SELECT 1;"),
            "17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a"
        );
    }
}
