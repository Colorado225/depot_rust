//! LOT 10 — Session et RBAC côté Rust.
//!
//! Le jeton est transmis dans le payload JSON (`token`) par `invokeBackend()`,
//! exactement comme l'en-tête `Authorization: Bearer` du backend Node. Les
//! permissions sont vérifiées AVANT toute écriture métier.

use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::auth_repo::{require_permission, validate_session_token, AuthenticatedUser};
use sqlx::SqlitePool;

pub async fn actor(pool: &SqlitePool, input: &Json, permission: &str) -> Result<AuthenticatedUser, AppError> {
    let token = json::token(input)?;
    require_permission(pool, &token, permission).await
}

pub async fn optional_session(pool: &SqlitePool, input: &Json) -> Result<Option<AuthenticatedUser>, AppError> {
    let token = match json::opt_str(input, "token") {
        Some(token) => token,
        None => return Ok(None),
    };
    match validate_session_token(pool, &token).await {
        Ok(user) => Ok(Some(user)),
        Err(_) => Ok(None),
    }
}
