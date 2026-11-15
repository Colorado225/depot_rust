use crate::error::AppError;
use crate::security::password::{hash_password, verify_password};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};

const MAX_FAILED_ATTEMPTS: i64 = 5;
const LOCK_MINUTES: i64 = 15;
const SESSION_HOURS: i64 = 12;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
    pub needs_setup: bool,
    pub depot_name: Option<String>,
    pub logo_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedUser {
    pub id: String,
    pub employee_id: Option<String>,
    pub username: String,
    pub full_name: String,
    pub role_id: String,
    pub role_code: String,
    pub role_name: String,
    pub permissions: Vec<String>,
    pub last_login_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionResponse {
    pub token: String,
    pub expires_at: String,
    pub user: AuthenticatedUser,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeDepotInput {
    pub depot_name: String,
    pub owner_full_name: String,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub logo_path: Option<String>,
    pub receipt_header: Option<String>,
    pub receipt_footer: Option<String>,
    pub default_cash_float_xof: Option<i64>,
    pub allow_negative_stock: Option<bool>,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BusinessSettings {
    pub id: String,
    pub depot_name: String,
    pub owner_name: String,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub logo_path: Option<String>,
    pub currency: String,
    pub receipt_header: Option<String>,
    pub receipt_footer: Option<String>,
    pub default_consignment_policy: String,
    pub allow_negative_stock: bool,
    pub default_cash_float_xof: i64,
    pub receipt_print_width: String,
    pub is_initialized: bool,
    pub updated_at: String,
}

fn hash_token(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

pub async fn get_bootstrap_status(pool: &SqlitePool) -> Result<BootstrapStatus, AppError> {
    let owner_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'OWNER'",
    )
    .fetch_one(pool)
    .await?;

    let settings: Option<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT depot_name, logo_path, is_initialized FROM business_settings LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    let (depot_name, logo_path, is_init) = match settings {
        Some((d, l, i)) => (Some(d), l, i),
        None => (None, None, 0),
    };

    Ok(BootstrapStatus {
        needs_setup: owner_count.0 == 0 || is_init == 0,
        depot_name,
        logo_path,
    })
}

pub async fn validate_session_token(
    pool: &SqlitePool,
    raw_token: &str,
) -> Result<AuthenticatedUser, AppError> {
    let token_hash = hash_token(raw_token);
    let session: Option<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT s.user_id, s.expires_at, s.revoked_at, u.is_active
         FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?",
    )
    .bind(&token_hash)
    .fetch_optional(pool)
    .await?;

    let (user_id, expires_at, revoked_at, is_active) =
        session.ok_or_else(|| AppError::PermissionDenied("Session invalide".into()))?;

    if revoked_at.is_some() || is_active != 1 {
        return Err(AppError::PermissionDenied("Session révoquée ou compte désactivé".into()));
    }

    let exp = chrono::DateTime::parse_from_rfc3339(&expires_at)
        .map_err(|_| AppError::PermissionDenied("Session expirée".into()))?;
    if exp <= chrono::Utc::now() {
        return Err(AppError::PermissionDenied("Session expirée".into()));
    }

    load_authenticated_user(pool, &user_id).await
}

pub async fn require_permission(
    pool: &SqlitePool,
    raw_token: &str,
    permission_code: &str,
) -> Result<AuthenticatedUser, AppError> {
    let user = validate_session_token(pool, raw_token).await?;
    if !user.permissions.iter().any(|p| p == permission_code) {
        return Err(AppError::PermissionDenied(format!(
            "Permission requise : {permission_code}"
        )));
    }
    Ok(user)
}

pub async fn initialize_depot_and_owner(
    pool: &SqlitePool,
    input: InitializeDepotInput,
) -> Result<AuthSessionResponse, AppError> {
    let status = get_bootstrap_status(pool).await?;
    if !status.needs_setup {
        return Err(AppError::Conflict(
            "Le dépôt et le compte propriétaire sont déjà initialisés.".into(),
        ));
    }

    let clean_username = input.username.trim().to_lowercase();
    let float_xof = input.default_cash_float_xof.unwrap_or(0);
    if float_xof < 0 {
        return Err(AppError::Validation("Fonds de caisse négatif interdit".into()));
    }

    let employee_id = uuid::Uuid::new_v4().to_string();
    let user_id = uuid::Uuid::new_v4().to_string();
    let password_hash = hash_password(&input.password)?;
    let raw_token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let token_hash = hash_token(&raw_token);
    let session_id = uuid::Uuid::new_v4().to_string();
    let expires_at = (chrono::Utc::now() + chrono::Duration::hours(SESSION_HOURS)).to_rfc3339();

    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO business_settings (
            id, depot_name, owner_name, phone, address, logo_path,
            currency, receipt_header, receipt_footer, default_consignment_policy,
            allow_negative_stock, default_cash_float_xof, receipt_print_width, is_initialized
         ) VALUES ('depot-settings-main', ?, ?, ?, ?, ?, 'XOF', ?, ?, 'SEPARATE_TRACKING', ?, ?, '80mm', 1)"
    )
    .bind(input.depot_name.trim())
    .bind(input.owner_full_name.trim())
    .bind(input.phone.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(input.address.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(input.logo_path.as_deref().filter(|s| !s.is_empty()))
    .bind(input.receipt_header.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(input.receipt_footer.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("Merci pour votre confiance !"))
    .bind(if input.allow_negative_stock.unwrap_or(false) { 1_i64 } else { 0_i64 })
    .bind(float_xof)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO employees (id, full_name, phone, job_title, is_active) VALUES (?, ?, ?, 'Propriétaire', 1)"
    )
    .bind(&employee_id)
    .bind(input.owner_full_name.trim())
    .bind(input.phone.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO users (id, employee_id, username, password_hash, role_id, is_active, last_login_at)
         VALUES (?, ?, ?, ?, 'role-owner', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
    )
    .bind(&user_id)
    .bind(&employee_id)
    .bind(&clean_username)
    .bind(&password_hash)
    .execute(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
        .bind(&session_id)
        .bind(&user_id)
        .bind(&token_hash)
        .bind(&expires_at)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO login_logs (id, user_id, username_attempted, success, reason) VALUES (?, ?, ?, 1, 'INITIAL_OWNER_SETUP')"
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&user_id)
    .bind(&clean_username)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let user = load_authenticated_user(pool, &user_id).await?;
    Ok(AuthSessionResponse {
        token: raw_token,
        expires_at,
        user,
    })
}

pub async fn login_user(
    pool: &SqlitePool,
    username: &str,
    password: &str,
) -> Result<AuthSessionResponse, AppError> {
    let clean = username.trim().to_lowercase();
    let row: Option<(String, String, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT id, password_hash, is_active, failed_attempts, locked_until FROM users WHERE LOWER(username) = ?",
    )
    .bind(&clean)
    .fetch_optional(pool)
    .await?;

    let (user_id, password_hash, is_active, failed_attempts, locked_until) = match row {
        Some(r) => r,
        None => {
            return Err(AppError::PermissionDenied(
                "Identifiant ou mot de passe incorrect.".into(),
            ));
        }
    };

    if is_active != 1 {
        return Err(AppError::PermissionDenied("Compte désactivé.".into()));
    }

    if let Some(lu) = locked_until {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&lu) {
            if dt > chrono::Utc::now() {
                return Err(AppError::PermissionDenied(
                    "Compte temporairement verrouillé après échecs répétés.".into(),
                ));
            }
        }
    }

    if !verify_password(password, &password_hash) {
        let next = failed_attempts + 1;
        let lock = if next >= MAX_FAILED_ATTEMPTS {
            Some((chrono::Utc::now() + chrono::Duration::minutes(LOCK_MINUTES)).to_rfc3339())
        } else {
            None
        };
        sqlx::query("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
            .bind(next)
            .bind(&lock)
            .bind(&user_id)
            .execute(pool)
            .await?;

        return Err(AppError::PermissionDenied(
            "Identifiant ou mot de passe incorrect.".into(),
        ));
    }

    let raw_token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let token_hash = hash_token(&raw_token);
    let expires_at = (chrono::Utc::now() + chrono::Duration::hours(SESSION_HOURS)).to_rfc3339();

    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
    .bind(&user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&user_id)
        .bind(&token_hash)
        .bind(&expires_at)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    let user = load_authenticated_user(pool, &user_id).await?;
    Ok(AuthSessionResponse {
        token: raw_token,
        expires_at,
        user,
    })
}

async fn load_authenticated_user(
    pool: &SqlitePool,
    user_id: &str,
) -> Result<AuthenticatedUser, AppError> {
    let row: (String, Option<String>, String, String, String, String, String, Option<String>) =
        sqlx::query_as(
            "SELECT u.id, u.employee_id, u.username, COALESCE(e.full_name, u.username),
                    r.id, r.code, r.name, u.last_login_at
             FROM users u
             LEFT JOIN employees e ON e.id = u.employee_id
             JOIN roles r ON r.id = u.role_id
             WHERE u.id = ?",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await?;

    let perms: Vec<(String,)> = sqlx::query_as(
        "SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?",
    )
    .bind(&row.4)
    .fetch_all(pool)
    .await?;

    Ok(AuthenticatedUser {
        id: row.0,
        employee_id: row.1,
        username: row.2,
        full_name: row.3,
        role_id: row.4,
        role_code: row.5,
        role_name: row.6,
        permissions: perms.into_iter().map(|p| p.0).collect(),
        last_login_at: row.7,
    })
}

pub async fn fetch_business_settings(pool: &SqlitePool) -> Result<BusinessSettings, AppError> {
    let row = sqlx::query_as::<_, BusinessSettings>(
        "SELECT id, depot_name, owner_name, phone, address, logo_path, currency,
                receipt_header, receipt_footer, default_consignment_policy,
                allow_negative_stock, default_cash_float_xof, receipt_print_width,
                is_initialized, updated_at
         FROM business_settings LIMIT 1",
    )
    .fetch_one(pool)
    .await?;
    Ok(row)
}
