use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Modèle persistant d'une permission atomique dans SQLite (`permissions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModel {
    pub id: Uuid,
    pub code: String,
    pub module: String,
    pub description: String,
}

/// Modèle persistant d'un rôle applicatif dans SQLite (`roles`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleModel {
    pub id: Uuid,
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub is_system: bool,
    pub created_at: String,
}

/// Table de liaison rôle <-> permission (`role_permissions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolePermissionModel {
    pub role_id: Uuid,
    pub permission_id: Uuid,
}

/// Modèle d'un compte utilisateur (`users`).
/// `password_hash` est marqué `skip_serializing` afin de ne jamais fuiter vers le frontend React.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserModel {
    pub id: Uuid,
    pub employee_id: Option<Uuid>,
    pub username: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub role_id: Uuid,
    pub is_active: bool,
    pub failed_attempts: i64,
    pub locked_until: Option<String>,
    pub last_login_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub sync_version: i64,
}

/// Projection sécurisée d'un utilisateur authentifié avec son rôle et ses permissions résolus en Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedUserModel {
    pub user: UserModel,
    pub role: RoleModel,
    pub permissions: Vec<PermissionModel>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_model_serde_with_uuid_redacts_password_hash() {
        let user_id = Uuid::new_v4();
        let role_id = Uuid::new_v4();
        let perm_id = Uuid::new_v4();

        let auth = AuthenticatedUserModel {
            user: UserModel {
                id: user_id,
                employee_id: None,
                username: "patron".into(),
                password_hash: "$argon2id$secret".into(),
                role_id,
                is_active: true,
                failed_attempts: 0,
                locked_until: None,
                last_login_at: None,
                created_at: "2026-11-15T10:00:00Z".into(),
                updated_at: "2026-11-15T10:00:00Z".into(),
                sync_version: 1,
            },
            role: RoleModel {
                id: role_id,
                code: "OWNER".into(),
                name: "Propriétaire".into(),
                description: None,
                is_system: true,
                created_at: "2026-11-15T10:00:00Z".into(),
            },
            permissions: vec![PermissionModel {
                id: perm_id,
                code: "auth.users.manage".into(),
                module: "AUTH".into(),
                description: "Gérer les utilisateurs".into(),
            }],
        };

        let json = serde_json::to_string(&auth).expect("Sérialisation JSON");
        assert!(!json.contains("secret"));
        assert!(json.contains(&user_id.to_string()));
        assert!(json.contains("auth.users.manage"));
    }
}
