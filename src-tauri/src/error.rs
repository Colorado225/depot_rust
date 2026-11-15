use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ValidationError,
    DatabaseError,
    PermissionDenied,
    InsufficientStock,
    Conflict,
    NotFound,
    InternalError,
}

#[derive(Debug, Serialize)]
pub struct AppErrorPayload {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Erreur de validation : {0}")]
    Validation(String),

    #[error("Erreur de base de données : {0}")]
    Database(#[from] sqlx::Error),

    #[error("Migration SQLite échouée : {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("Accès refusé : {0}")]
    PermissionDenied(String),

    #[error("Stock insuffisant : {0}")]
    InsufficientStock(String),

    #[error("Conflit d'état : {0}")]
    Conflict(String),

    #[error("Ressource introuvable : {0}")]
    NotFound(String),

    #[error("Erreur interne : {0}")]
    Internal(String),
}

impl AppError {
    pub fn to_payload(&self) -> AppErrorPayload {
        let code = match self {
            Self::Validation(_) => ErrorCode::ValidationError,
            Self::Database(_) | Self::Migration(_) => ErrorCode::DatabaseError,
            Self::PermissionDenied(_) => ErrorCode::PermissionDenied,
            Self::InsufficientStock(_) => ErrorCode::InsufficientStock,
            Self::Conflict(_) => ErrorCode::Conflict,
            Self::NotFound(_) => ErrorCode::NotFound,
            Self::Internal(_) => ErrorCode::InternalError,
        };

        AppErrorPayload {
            code,
            message: self.to_string(),
            details: None,
        }
    }
}

impl From<AppError> for String {
    fn from(err: AppError) -> Self {
        serde_json::to_string(&err.to_payload()).unwrap_or_else(|_| err.to_string())
    }
}
