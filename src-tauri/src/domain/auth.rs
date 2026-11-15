use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Codes système immuables des 4 rôles initiaux.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RoleCode {
    Owner,
    Manager,
    Cashier,
    Warehouse,
    Custom(String),
}

impl RoleCode {
    pub fn from_db(raw: &str) -> Self {
        match raw {
            "OWNER" => Self::Owner,
            "MANAGER" => Self::Manager,
            "CASHIER" => Self::Cashier,
            "WAREHOUSE" => Self::Warehouse,
            other => Self::Custom(other.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Owner => "OWNER",
            Self::Manager => "MANAGER",
            Self::Cashier => "CASHIER",
            Self::Warehouse => "WAREHOUSE",
            Self::Custom(s) => s.as_str(),
        }
    }
}

/// Entité Permission atomique (ex: `pos.sale.create`, `catalog.products.write`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub id: String,
    pub code: String,
    pub module: String,
    pub description: String,
}

/// Entité Rôle regroupant un ensemble de permissions vérifiées côté Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub code: RoleCode,
    pub name: String,
    pub description: Option<String>,
    pub is_system: bool,
    pub permissions: Vec<Permission>,
}

/// Entité Utilisateur (aucun hash de mot de passe n'est jamais exposé vers React).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub employee_id: Option<String>,
    pub username: String,
    pub full_name: String,
    pub role_id: String,
    pub is_active: bool,
    pub failed_attempts: i64,
    pub locked_until: Option<String>,
    pub last_login_at: Option<String>,
    pub created_at: String,
}

/// Représentation persistée d'une session locale authentifiée.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSession {
    pub id: String,
    pub user_id: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
}

/// Contexte de sécurité résolu exclusivement côté backend Rust après validation du jeton.
/// Le frontend ne peut jamais forger ou contourner ce contexte.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityContext {
    pub user: User,
    pub role: Role,
    pub session_id: String,
}

impl SecurityContext {
    pub fn has_permission(&self, permission_code: &str) -> bool {
        if !self.user.is_active {
            return false;
        }
        self.role
            .permissions
            .iter()
            .any(|p| p.code == permission_code)
    }
}

/// Contrat de hachage cryptographique des mots de passe (Argon2id en production).
pub trait PasswordHasherTrait: Send + Sync {
    fn hash_password(&self, plain: &str) -> Result<String, AppError>;
    fn verify_password(&self, plain: &str, stored_hash: &str) -> bool;
}

/// Contrat de persistance du module Authentification et RBAC.
pub trait AuthRepositoryTrait: Send + Sync {
    fn find_user_by_username<'a>(
        &'a self,
        username: &'a str,
    ) -> BoxFuture<'a, Result<Option<(User, String)>, AppError>>;

    fn find_user_by_id<'a>(
        &'a self,
        user_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<User>, AppError>>;

    fn load_role_with_permissions<'a>(
        &'a self,
        role_id: &'a str,
    ) -> BoxFuture<'a, Result<Role, AppError>>;

    fn resolve_security_context<'a>(
        &'a self,
        raw_session_token: &'a str,
    ) -> BoxFuture<'a, Result<SecurityContext, AppError>>;

    fn record_login_attempt<'a>(
        &'a self,
        user_id: Option<&'a str>,
        username_attempted: &'a str,
        success: bool,
        reason: &'a str,
    ) -> BoxFuture<'a, Result<(), AppError>>;

    fn increment_failed_attempts_and_maybe_lock<'a>(
        &'a self,
        user_id: &'a str,
        max_attempts: i64,
        lock_minutes: i64,
    ) -> BoxFuture<'a, Result<(i64, Option<String>), AppError>>;

    fn unlock_user_account<'a>(
        &'a self,
        actor_user_id: &'a str,
        target_user_id: &'a str,
    ) -> BoxFuture<'a, Result<User, AppError>>;
}

/// Service métier d'autorisation : toute opération sensible doit passer par ce service côté Rust.
pub trait AuthorizationServiceTrait: Send + Sync {
    fn authorize(&self, ctx: &SecurityContext, required_permission: &str) -> Result<(), AppError>;

    fn authorize_any(
        &self,
        ctx: &SecurityContext,
        required_permissions: &[&str],
    ) -> Result<(), AppError>;
}

pub struct DefaultAuthorizationService;

impl AuthorizationServiceTrait for DefaultAuthorizationService {
    fn authorize(&self, ctx: &SecurityContext, required_permission: &str) -> Result<(), AppError> {
        if !ctx.user.is_active {
            return Err(AppError::PermissionDenied(
                "Compte utilisateur désactivé.".into(),
            ));
        }
        if !ctx.has_permission(required_permission) {
            return Err(AppError::PermissionDenied(format!(
                "Action refusée : permission « {required_permission} » requise pour le rôle {}.",
                ctx.role.name
            )));
        }
        Ok(())
    }

    fn authorize_any(
        &self,
        ctx: &SecurityContext,
        required_permissions: &[&str],
    ) -> Result<(), AppError> {
        if !ctx.user.is_active {
            return Err(AppError::PermissionDenied(
                "Compte utilisateur désactivé.".into(),
            ));
        }
        if required_permissions.iter().any(|p| ctx.has_permission(p)) {
            return Ok(());
        }
        Err(AppError::PermissionDenied(format!(
            "Action refusée pour le rôle {}.",
            ctx.role.name
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_context(role_code: RoleCode, perms: &[&str], active: bool) -> SecurityContext {
        SecurityContext {
            session_id: "sess-1".into(),
            user: User {
                id: "usr-1".into(),
                employee_id: Some("emp-1".into()),
                username: "caissier".into(),
                full_name: "Awa Koné".into(),
                role_id: "role-cashier".into(),
                is_active: active,
                failed_attempts: 0,
                locked_until: None,
                last_login_at: None,
                created_at: "2026-11-15T10:00:00Z".into(),
            },
            role: Role {
                id: "role-cashier".into(),
                code: role_code,
                name: "Caissier".into(),
                description: None,
                is_system: true,
                permissions: perms
                    .iter()
                    .map(|code| Permission {
                        id: format!("p-{code}"),
                        code: (*code).to_string(),
                        module: "TEST".into(),
                        description: (*code).to_string(),
                    })
                    .collect(),
            },
        }
    }

    #[test]
    fn test_authorization_service_enforces_permissions_in_rust() {
        let authz = DefaultAuthorizationService;
        let cashier_ctx = sample_context(RoleCode::Cashier, &["pos.sale.create"], true);

        assert!(authz.authorize(&cashier_ctx, "pos.sale.create").is_ok());
        assert!(matches!(
            authz.authorize(&cashier_ctx, "auth.users.manage"),
            Err(AppError::PermissionDenied(_))
        ));

        let disabled_ctx = sample_context(RoleCode::Owner, &["auth.users.manage"], false);
        assert!(matches!(
            authz.authorize(&disabled_ctx, "auth.users.manage"),
            Err(AppError::PermissionDenied(_))
        ));
    }
}
