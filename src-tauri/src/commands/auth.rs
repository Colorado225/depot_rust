use crate::commands::system::AppState;
use crate::domain::auth::{
    AuthorizationServiceTrait, DefaultAuthorizationService, Permission, Role, RoleCode,
    SecurityContext, User,
};
use crate::error::AppError;
use crate::repositories::auth_repo::{
    fetch_business_settings, get_bootstrap_status, initialize_depot_and_owner, login_user,
    require_permission, validate_session_token, AuthSessionResponse, AuthenticatedUser,
    BootstrapStatus, BusinessSettings, InitializeDepotInput,
};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserInput {
    pub full_name: String,
    pub phone: Option<String>,
    pub job_title: Option<String>,
    pub username: String,
    pub password: String,
    pub role_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordInput {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionCheckResult {
    pub allowed: bool,
    pub permission_code: String,
    pub role_name: String,
}

fn to_security_context(auth_user: AuthenticatedUser) -> SecurityContext {
    let permissions = auth_user
        .permissions
        .into_iter()
        .map(|code| Permission {
            id: code.clone(),
            module: code.split('.').next().unwrap_or("CORE").to_uppercase(),
            description: code.clone(),
            code,
        })
        .collect();

    SecurityContext {
        session_id: "tauri-active".to_string(),
        user: User {
            id: auth_user.id,
            employee_id: auth_user.employee_id,
            username: auth_user.username,
            full_name: auth_user.full_name,
            role_id: auth_user.role_id.clone(),
            is_active: true,
            failed_attempts: 0,
            locked_until: None,
            last_login_at: auth_user.last_login_at,
            created_at: String::new(),
        },
        role: Role {
            id: auth_user.role_id,
            code: RoleCode::from_db(&auth_user.role_code),
            name: auth_user.role_name,
            description: None,
            is_system: true,
            permissions,
        },
    }
}

#[tauri::command]
pub async fn auth_bootstrap_status(state: State<'_, AppState>) -> Result<BootstrapStatus, String> {
    get_bootstrap_status(&state.pool)
        .await
        .map_err(String::from)
}

#[tauri::command]
pub async fn auth_initialize_depot(
    state: State<'_, AppState>,
    input: InitializeDepotInput,
) -> Result<AuthSessionResponse, String> {
    initialize_depot_and_owner(&state.pool, input)
        .await
        .map_err(String::from)
}

#[tauri::command]
pub async fn auth_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<AuthSessionResponse, String> {
    login_user(&state.pool, &username, &password)
        .await
        .map_err(String::from)
}

#[tauri::command]
pub async fn auth_check_permission(
    state: State<'_, AppState>,
    token: String,
    permission_code: String,
) -> Result<PermissionCheckResult, String> {
    let user = require_permission(&state.pool, &token, &permission_code)
        .await
        .map_err(String::from)?;
    let ctx = to_security_context(user);
    let authz = DefaultAuthorizationService;
    authz
        .authorize(&ctx, &permission_code)
        .map_err(String::from)?;

    Ok(PermissionCheckResult {
        allowed: true,
        permission_code,
        role_name: ctx.role.name,
    })
}

#[tauri::command]
pub async fn auth_get_current_session(
    state: State<'_, AppState>,
    token: String,
) -> Result<SecurityContext, String> {
    let user = validate_session_token(&state.pool, &token)
        .await
        .map_err(String::from)?;
    Ok(to_security_context(user))
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>, token: String) -> Result<(), String> {
    let _ = (&state.pool, token);
    Ok(())
}

#[tauri::command]
pub async fn auth_change_password(
    state: State<'_, AppState>,
    token: String,
    input: ChangePasswordInput,
) -> Result<(), String> {
    let _ = (&state.pool, token, input);
    Err(String::from(AppError::Internal(
        "Signature prête pour exécution SQLx desktop".into(),
    )))
}

#[tauri::command]
pub async fn auth_create_user(
    state: State<'_, AppState>,
    token: String,
    input: CreateUserInput,
) -> Result<User, String> {
    let _actor = require_permission(&state.pool, &token, "auth.users.manage")
        .await
        .map_err(String::from)?;
    let _ = input;
    Err(String::from(AppError::Internal(
        "Signature prête pour exécution SQLx desktop".into(),
    )))
}

#[tauri::command]
pub async fn auth_unlock_user(
    state: State<'_, AppState>,
    token: String,
    target_user_id: String,
) -> Result<(), String> {
    let _actor = require_permission(&state.pool, &token, "auth.users.manage")
        .await
        .map_err(String::from)?;
    let _ = target_user_id;
    Ok(())
}

#[tauri::command]
pub async fn settings_get(
    state: State<'_, AppState>,
    token: String,
) -> Result<BusinessSettings, String> {
    require_permission(&state.pool, &token, "settings.depot.manage")
        .await
        .map_err(String::from)?;
    fetch_business_settings(&state.pool)
        .await
        .map_err(String::from)
}
