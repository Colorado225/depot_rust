use crate::error::AppError;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

/// Initialise la connexion SQLite locale avec :
/// - Mode WAL (Write-Ahead Logging) pour concurrence et résilience aux coupures
/// - Clés étrangères activées (PRAGMA foreign_keys = ON)
/// - Migrations SQL versionnées exécutées atomiquement au démarrage
pub async fn init_sqlite_pool(db_path: &Path) -> Result<SqlitePool, AppError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Internal(format!("Impossible de créer le répertoire de données : {e}")))?;
    }

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

    // Migrations SQL versionnées depuis ../migrations
    sqlx::migrate!("../migrations").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_sqlite_wal_fk_and_migrations() {
        let temp_dir = std::env::temp_dir().join(format!("depotpro_test_{}", uuid::Uuid::new_v4()));
        let db_path: PathBuf = temp_dir.join("depotpro_test.db");

        let pool = init_sqlite_pool(&db_path).await.expect("Pool SQLite initialisé");

        let journal_mode: (String,) = sqlx::query_as("PRAGMA journal_mode;")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(journal_mode.0.to_lowercase(), "wal");

        let fk_enabled: (i64,) = sqlx::query_as("PRAGMA foreign_keys;")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(fk_enabled.0, 1);

        // Vérifie que l'insertion avec clé étrangère invalide échoue
        let fk_err = sqlx::query(
            "INSERT INTO users (id, username, password_hash, role_id) VALUES ('u1', 'test', 'hash', 'role-inexistant')"
        )
        .execute(&pool)
        .await;
        assert!(fk_err.is_err());

        pool.close().await;
        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
