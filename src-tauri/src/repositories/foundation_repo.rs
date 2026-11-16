//! LOT 10 — Dépôt SQLx de la tranche 1 (fondations, auth/RBAC, paramètres).
//!
//! Port des dépôts `systemRepo.ts`, `settingsRepo.ts` et des méthodes de
//! `authRepo.ts` du backend Node. Toutes les validations métier sont exécutées
//! ici, côté backend Rust, jamais dans la webview. Les DTO renvoyés sont en
//! `camelCase` pour rester strictement compatibles avec le frontend existant.

use crate::domain::money::XofAmount;
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::auth_repo::{
    fetch_business_settings, get_bootstrap_status, initialize_depot_and_owner, login_user,
    InitializeDepotInput,
};
use crate::security::password::{hash_password, verify_password};
use serde_json::json;
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::time::Instant;

const BOOL_COLUMNS: &[&str] = &[
    "needsSetup", "isActive", "success", "offlineAllowed", "isInitialized",
    "allowNegativeStock", "foreignKeysEnabled", "offlineReady", "passed", "allPassed",
];

fn validation(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn valid_username(value: &str) -> bool {
    let len = value.chars().count();
    len >= 3
        && len <= 50
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_password(value: &str) -> bool {
    let len = value.chars().count();
    (8..=128).contains(&len)
}

fn valid_xof(value: i64, label: &str) -> Result<i64, AppError> {
    XofAmount::non_negative(value).map(|v| v.raw()).map_err(|_| {
        validation(format!("{label} doit être un entier FCFA positif ou nul"))
    })
}

async fn audit(
    executor: &mut sqlx::SqliteConnection,
    actor: Option<&str>,
    action: &str,
    entity: &str,
    entity_id: &str,
    payload: &Json,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(json::new_id())
    .bind(actor)
    .bind(action)
    .bind(entity)
    .bind(entity_id)
    .bind(payload.to_string())
    .execute(executor)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// LOT 0 — Système
// ---------------------------------------------------------------------------

pub async fn health(pool: &SqlitePool, db_path: &Path) -> Result<Json, AppError> {
    let sqlite_version: (String,) = sqlx::query_as("SELECT sqlite_version();")
        .fetch_one(pool)
        .await?;
    let journal_mode: (String,) = sqlx::query_as("PRAGMA journal_mode;")
        .fetch_one(pool)
        .await?;
    let fk: (i64,) = sqlx::query_as("PRAGMA foreign_keys;").fetch_one(pool).await?;
    let migrations: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_migrations;")
        .fetch_one(pool)
        .await?;
    let tables: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
    )
    .fetch_one(pool)
    .await?;
    let lot: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM system_meta WHERE key = 'app.lot_current';",
    )
    .fetch_optional(pool)
    .await?;
    let db_size_bytes = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);

    Ok(json!({
        "appName": "DepotPro CI",
        "version": env!("CARGO_PKG_VERSION"),
        "runtime": "TAURI_RUST_SQLX",
        "sqliteVersion": sqlite_version.0,
        "journalMode": journal_mode.0.to_uppercase(),
        "foreignKeysEnabled": fk.0 == 1,
        "dbPath": db_path.to_string_lossy().to_string(),
        "dbSizeBytes": db_size_bytes,
        "appliedMigrationsCount": migrations.0,
        "tablesCount": tables.0,
        "currentLot": lot.map(|l| l.0).unwrap_or_else(|| "LOT_0".to_string()),
        "offlineReady": true,
        "checkedAt": json::now_iso(),
    }))
}

pub async fn migrations(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows: Vec<SqliteRow> = sqlx::query(
        "SELECT version, filename, description, checksum_sha256 AS checksumSha256,
                execution_ms AS executionMs, applied_at AS appliedAt
         FROM schema_migrations ORDER BY version ASC;",
    )
    .fetch_all(pool)
    .await?;

    let names: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC;",
    )
    .fetch_all(pool)
    .await?;

    let mut tables = Vec::with_capacity(names.len());
    for name in names {
        // Nom issu de sqlite_master (jamais d'une entrée utilisateur) ; les
        // guillemets internes sont doublés par sécurité.
        let quoted = name.replace('"', "\"\"");
        let sql = format!("SELECT COUNT(*) FROM \"{quoted}\";");
        let count: (i64,) = sqlx::query_as(&sql).fetch_one(pool).await?;
        tables.push(json!({ "name": name, "rowCount": count.0 }));
    }

    Ok(json!({ "migrations": json::rows_to_json(rows, BOOL_COLUMNS), "tables": tables }))
}

pub async fn decisions(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows: Vec<SqliteRow> = sqlx::query(
        "SELECT key, value, category, description, updated_at AS updatedAt
         FROM system_meta ORDER BY category ASC, key ASC;",
    )
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, BOOL_COLUMNS))
}

pub async fn license(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows: Vec<SqliteRow> = sqlx::query(
        "SELECT id, edition, status, license_key_masked AS licenseKeyMasked,
                installation_id AS installationId, depot_name_bound AS depotNameBound,
                activated_at AS activatedAt, expires_at AS expiresAt,
                offline_allowed AS offlineAllowed, updated_at AS updatedAt
         FROM license_state WHERE id = 'local-license';",
    )
    .fetch_all(pool)
    .await?;
    let value = json::rows_to_json(rows, BOOL_COLUMNS);
    value
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| AppError::NotFound("Licence locale introuvable".into()))
}

fn valid_license_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 14
        && key.starts_with("DPCI-")
        && bytes[9] == b'-'
        && bytes[5..9]
            .iter()
            .chain(bytes[10..14].iter())
            .all(|b| b.is_ascii_alphanumeric())
}

pub async fn activate_license(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let key = json::str_field(input, "licenseKey")?.to_uppercase();
    let depot = json::str_field(input, "depotNameBound")?;
    if !valid_license_key(&key) {
        return Err(validation("Format attendu : DPCI-XXXX-XXXX"));
    }
    if depot.chars().count() < 2 || depot.chars().count() > 120 {
        return Err(validation("Nom du dépôt requis (min. 2 caractères)"));
    }
    let masked = format!("DPCI-****-{}", &key[key.len() - 4..]);
    sqlx::query(
        "UPDATE license_state
         SET status = 'ACTIVE_OFFLINE', license_key_masked = ?, depot_name_bound = ?,
             activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 'local-license';",
    )
    .bind(masked)
    .bind(depot)
    .execute(pool)
    .await?;
    license(pool).await
}

pub async fn reset_trial_license(pool: &SqlitePool, actor_id: &str) -> Result<Json, AppError> {
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE license_state
             SET status = 'TRIAL_OFFLINE', license_key_masked = NULL,
                 depot_name_bound = NULL, activated_at = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = 'local-license';",
        )
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            Some(actor_id),
            "LICENSE_LOCAL_RESET_TRIAL",
            "license_state",
            "local-license",
            &json!({}),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    license(pool).await
}

pub async fn integrity_check(pool: &SqlitePool) -> Result<Json, AppError> {
    let started = Instant::now();
    let row: (String,) = sqlx::query_as("PRAGMA quick_check;").fetch_one(pool).await?;
    let ok = row.0.to_lowercase() == "ok";
    Ok(json!({
        "status": if ok { "OK" } else { "FAILED" },
        "rawResult": row.0,
        "checkedAt": json::now_iso(),
        "durationMs": started.elapsed().as_millis() as i64,
    }))
}

pub async fn foundation_self_tests(pool: &SqlitePool) -> Result<Json, AppError> {
    let mut checks: Vec<Json> = Vec::new();

    let wal: (String,) = sqlx::query_as("PRAGMA journal_mode;").fetch_one(pool).await?;
    checks.push(json!({
        "id": "sqlite-wal",
        "label": "Journalisation SQLite WAL active",
        "passed": wal.0.to_lowercase() == "wal",
        "details": format!("PRAGMA journal_mode = {}", wal.0.to_uppercase()),
    }));

    let fk: (i64,) = sqlx::query_as("PRAGMA foreign_keys;").fetch_one(pool).await?;
    let mut tx = pool.begin().await?;
    let orphan_insert = sqlx::query(
        "INSERT INTO users (id, username, password_hash, role_id)
         VALUES ('selftest-fk', 'selftest_fk', 'hash', 'role-inexistant');",
    )
    .execute(&mut *tx)
    .await;
    let fk_rejected = orphan_insert.is_err();
    let _ = tx.rollback().await;
    checks.push(json!({
        "id": "sqlite-fk",
        "label": "Intégrité référentielle (Clés étrangères SQLite)",
        "passed": fk.0 == 1 && fk_rejected,
        "details": if fk_rejected {
            "PRAGMA foreign_keys = ON et insertion orpheline bloquée par SQLite"
        } else {
            "Échec de contrainte FK détecté"
        },
    }));

    let roles: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM roles;").fetch_one(pool).await?;
    let perms: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM permissions;")
        .fetch_one(pool)
        .await?;
    checks.push(json!({
        "id": "rbac-seed",
        "label": "Référentiel des 4 rôles et permissions initiales",
        "passed": roles.0 == 4 && perms.0 >= 14,
        "details": format!("{} rôles initiaux et {} permissions chargées en base", roles.0, perms.0),
    }));

    let total = XofAmount::non_negative(9_600)?
        .checked_mul_qty(10)?
        .checked_add(XofAmount::new(2_400))?
        .checked_sub(XofAmount::new(1_000))?;
    let float_rejected = json!(100.5).as_i64().is_none();
    checks.push(json!({
        "id": "xof-integer-math",
        "label": "Calculs financiers XOF strictement entiers",
        "passed": total.raw() == 97_400 && float_rejected,
        "details": format!("10 × 9 600 + 2 400 - 1 000 = {} FCFA ; décimal rejeté = {}", total.raw(), float_rejected),
    }));

    let probe_key = "selftest.rollback.probe";
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO system_meta (key, value, category) VALUES (?, 'TEMP', 'TEST');")
        .bind(probe_key)
        .execute(&mut *tx)
        .await?;
    let _ = tx.rollback().await;
    let residual: Option<(String,)> = sqlx::query_as("SELECT value FROM system_meta WHERE key = ?;")
        .bind(probe_key)
        .fetch_optional(pool)
        .await?;
    let rollback_ok = residual.is_none();
    checks.push(json!({
        "id": "sqlite-tx-rollback",
        "label": "Atomicité et rollback transactionnel SQLite",
        "passed": rollback_ok,
        "details": if rollback_ok {
            "Écriture annulée proprement via ROLLBACK sans résidu"
        } else {
            "Résidu détecté après ROLLBACK"
        },
    }));

    let all_passed = checks
        .iter()
        .all(|c| c.get("passed").and_then(Json::as_bool).unwrap_or(false));
    Ok(json!({ "allPassed": all_passed, "executedAt": json::now_iso(), "checks": checks }))
}

// ---------------------------------------------------------------------------
// LOT 1 — Authentification, RBAC, utilisateurs
// ---------------------------------------------------------------------------

pub async fn bootstrap(pool: &SqlitePool) -> Result<Json, AppError> {
    json::to_json(&get_bootstrap_status(pool).await?)
}

pub async fn initialize_depot(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let dto: InitializeDepotInput = serde_json::from_value(input.clone())
        .map_err(|e| validation(format!("Données de configuration invalides : {e}")))?;
    if dto.depot_name.trim().chars().count() < 2 || dto.depot_name.chars().count() > 120 {
        return Err(validation("Nom du dépôt requis (min. 2 caractères)"));
    }
    if dto.owner_full_name.trim().chars().count() < 2 {
        return Err(validation("Nom du propriétaire requis"));
    }
    let username = dto.username.trim().to_lowercase();
    if !valid_username(&username) {
        return Err(validation("Identifiant min. 3 caractères (lettres, chiffres, ., _, -)"));
    }
    if !valid_password(&dto.password) {
        return Err(validation("Mot de passe min. 8 caractères"));
    }
    if let Some(float) = dto.default_cash_float_xof {
        valid_xof(float, "Fonds de caisse initial")?;
    }
    json::to_json(&initialize_depot_and_owner(pool, dto).await?)
}

pub async fn login(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let username = json::str_field(input, "username")?;
    let password = json::str_field(input, "password")?;
    json::to_json(&login_user(pool, &username, &password).await?)
}

pub async fn logout(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let Some(raw_token) = json::opt_str(input, "token") else {
        return Ok(json::ok());
    };
    let token_hash = {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(raw_token.as_bytes()))
    };
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT user_id FROM user_sessions WHERE token_hash = ?;")
            .bind(&token_hash)
            .fetch_optional(pool)
            .await?;

    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE token_hash = ? AND revoked_at IS NULL;",
    )
    .bind(&token_hash)
    .execute(&mut *tx)
    .await?;
    if let Some((user_id,)) = existing {
        audit(&mut *tx, Some(&user_id), "USER_LOGOUT", "users", &user_id, &json!({})).await?;
    }
    tx.commit().await?;
    Ok(json::ok())
}

pub async fn me(pool: &SqlitePool, raw_token: &str) -> Result<Json, AppError> {
    json::to_json(&crate::repositories::auth_repo::validate_session_token(pool, raw_token).await?)
}

/// LOT 11 — Changement de mot de passe AVEC révocation des autres sessions.
///
/// `keep_token` est le jeton de la session courante (prouvé par le mot de passe
/// actuel) : il reste valide, toutes les autres sessions de l'utilisateur sont
/// révoquées dans la même transaction. Parité stricte avec
/// `AuthRepository.changePassword` du backend Node.
pub async fn change_password(
    pool: &SqlitePool,
    actor_id: &str,
    keep_token: Option<&str>,
    input: &Json,
) -> Result<Json, AppError> {
    let current = json::str_field(input, "currentPassword")?;
    let next = json::str_field(input, "newPassword")?;
    if !valid_password(&next) {
        return Err(validation("Nouveau mot de passe min. 8 caractères"));
    }
    if current == next {
        return Err(validation("Le nouveau mot de passe doit être différent de l'ancien."));
    }
    let row: Option<(String,)> =
        sqlx::query_as("SELECT password_hash FROM users WHERE id = ?;")
            .bind(actor_id)
            .fetch_optional(pool)
            .await?;
    let (stored_hash,) = row.ok_or_else(|| AppError::NotFound("Utilisateur introuvable.".into()))?;
    if !verify_password(&current, &stored_hash) {
        return Err(AppError::PermissionDenied("Le mot de passe actuel est incorrect.".into()));
    }

    let next_hash = hash_password(&next)?;
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE users SET password_hash = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?;",
        )
        .bind(&next_hash)
        .bind(actor_id)
        .execute(&mut *tx)
        .await?;
        let keep_hash = match keep_token {
            Some(raw) => Some({
                use sha2::{Digest, Sha256};
                hex::encode(Sha256::digest(raw.as_bytes()))
            }),
            None => None,
        };
        let revoked = sqlx::query(
            "UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE user_id = ? AND revoked_at IS NULL
               AND (? IS NULL OR token_hash <> ?);",
        )
        .bind(actor_id)
        .bind(keep_hash.as_deref())
        .bind(keep_hash.as_deref())
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            Some(actor_id),
            "PASSWORD_CHANGED",
            "users",
            actor_id,
            &json!({ "revokedSessions": revoked.rows_affected() }),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    Ok(json::ok())
}

const USER_SELECT: &str = "SELECT u.id, u.employee_id AS employeeId, u.username,
       COALESCE(e.full_name, u.username) AS fullName, e.phone, e.job_title AS jobTitle,
       r.id AS roleId, r.code AS roleCode, r.name AS roleName,
       u.is_active AS isActive, u.failed_attempts AS failedAttempts,
       u.locked_until AS lockedUntil, u.last_login_at AS lastLoginAt,
       u.created_at AS createdAt
FROM users u
LEFT JOIN employees e ON e.id = u.employee_id
JOIN roles r ON r.id = u.role_id";

async fn user_by_id(pool: &SqlitePool, user_id: &str) -> Result<Json, AppError> {
    let sql = format!("{USER_SELECT} WHERE u.id = ?;");
    let rows: Vec<SqliteRow> = sqlx::query(&sql).bind(user_id).fetch_all(pool).await?;
    let value = json::rows_to_json(rows, BOOL_COLUMNS);
    value
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| AppError::NotFound("Compte utilisateur introuvable.".into()))
}

pub async fn list_users(pool: &SqlitePool) -> Result<Json, AppError> {
    let sql = format!("{USER_SELECT} ORDER BY r.is_system DESC, u.created_at ASC;");
    let rows: Vec<SqliteRow> = sqlx::query(&sql).fetch_all(pool).await?;
    Ok(json::rows_to_json(rows, BOOL_COLUMNS))
}

pub async fn create_user(pool: &SqlitePool, actor_id: &str, input: &Json) -> Result<Json, AppError> {
    let full_name = json::str_field(input, "fullName")?;
    let username = json::str_field(input, "username")?.to_lowercase();
    let password = json::str_field(input, "password")?;
    let role_id = json::str_field(input, "roleId")?;
    let phone = json::opt_str(input, "phone");
    let job_title = json::opt_str(input, "jobTitle");

    if full_name.chars().count() < 2 || full_name.chars().count() > 120 {
        return Err(validation("Nom complet requis"));
    }
    if !valid_username(&username) {
        return Err(validation("Identifiant min. 3 caractères (lettres, chiffres, ., _, -)"));
    }
    if !valid_password(&password) {
        return Err(validation("Mot de passe min. 8 caractères"));
    }

    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE LOWER(username) = ?;")
            .bind(&username)
            .fetch_optional(pool)
            .await?;
    if existing.is_some() {
        return Err(AppError::Conflict(format!(
            "L'identifiant « {username} » est déjà utilisé."
        )));
    }
    let role: Option<(String,)> = sqlx::query_as("SELECT name FROM roles WHERE id = ?;")
        .bind(&role_id)
        .fetch_optional(pool)
        .await?;
    let (role_name,) = role.ok_or_else(|| AppError::NotFound("Rôle sélectionné introuvable.".into()))?;

    let employee_id = json::new_id();
    let user_id = json::new_id();
    let password_hash = hash_password(&password)?;
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO employees (id, full_name, phone, job_title, is_active)
             VALUES (?, ?, ?, ?, 1);",
        )
        .bind(&employee_id)
        .bind(&full_name)
        .bind(phone.as_deref())
        .bind(job_title.as_deref().unwrap_or(role_name.as_str()))
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO users (id, employee_id, username, password_hash, role_id, is_active)
             VALUES (?, ?, ?, ?, ?, 1);",
        )
        .bind(&user_id)
        .bind(&employee_id)
        .bind(&username)
        .bind(&password_hash)
        .bind(&role_id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            Some(actor_id),
            "USER_CREATED",
            "users",
            &user_id,
            &json!({ "username": username, "roleId": role_id }),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    user_by_id(pool, &user_id).await
}

async fn active_owner_count(pool: &mut sqlx::SqliteConnection) -> Result<i64, AppError> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.code = 'OWNER' AND u.is_active = 1;",
    )
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

pub async fn toggle_user_status(
    pool: &SqlitePool,
    actor_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let target_id = json::str_field(input, "userId")?;
    let is_active = json::bool_field(input, "isActive")?;
    if actor_id == target_id && !is_active {
        return Err(AppError::Conflict(
            "Vous ne pouvez pas désactiver votre propre compte en cours de session.".into(),
        ));
    }
    let target: Option<(String,)> = sqlx::query_as(
        "SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?;",
    )
    .bind(&target_id)
    .fetch_optional(pool)
    .await?;
    let (role_code,) =
        target.ok_or_else(|| AppError::NotFound("Compte utilisateur introuvable.".into()))?;

    let mut tx = pool.begin().await?;
    if role_code == "OWNER" && !is_active && active_owner_count(&mut *tx).await? <= 1 {
        let _ = tx.rollback().await;
        return Err(AppError::Conflict(
            "Impossible de désactiver le dernier compte Propriétaire actif.".into(),
        ));
    }
    let result = async {
        sqlx::query(
            "UPDATE users SET is_active = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?;",
        )
        .bind(if is_active { 1_i64 } else { 0_i64 })
        .bind(&target_id)
        .execute(&mut *tx)
        .await?;
        if !is_active {
            sqlx::query(
                "UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE user_id = ? AND revoked_at IS NULL;",
            )
            .bind(&target_id)
            .execute(&mut *tx)
            .await?;
        }
        let action = if is_active { "USER_ACTIVATED" } else { "USER_DEACTIVATED" };
        audit(
            &mut *tx,
            Some(actor_id),
            action,
            "users",
            &target_id,
            &json!({ "isActive": is_active }),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    user_by_id(pool, &target_id).await
}

pub async fn unlock_user(pool: &SqlitePool, actor_id: &str, input: &Json) -> Result<Json, AppError> {
    let target_id = json::str_field(input, "userId")?;
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE id = ?;")
        .bind(&target_id)
        .fetch_optional(pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound("Compte utilisateur introuvable.".into()));
    }
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE users SET failed_attempts = 0, locked_until = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?;",
        )
        .bind(&target_id)
        .execute(&mut *tx)
        .await?;
        audit(&mut *tx, Some(actor_id), "USER_UNLOCKED", "users", &target_id, &json!({})).await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    user_by_id(pool, &target_id).await
}

pub async fn update_user_role(
    pool: &SqlitePool,
    actor_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let target_id = json::str_field(input, "userId")?;
    let next_role_id = json::str_field(input, "roleId")?;
    let role: Option<(String,)> = sqlx::query_as("SELECT code FROM roles WHERE id = ?;")
        .bind(&next_role_id)
        .fetch_optional(pool)
        .await?;
    let (next_role_code,) = role.ok_or_else(|| AppError::NotFound("Rôle introuvable.".into()))?;
    let target: Option<(String,)> = sqlx::query_as(
        "SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?;",
    )
    .bind(&target_id)
    .fetch_optional(pool)
    .await?;
    let (current_role_code,) =
        target.ok_or_else(|| AppError::NotFound("Compte utilisateur introuvable.".into()))?;

    let mut tx = pool.begin().await?;
    if current_role_code == "OWNER"
        && next_role_code != "OWNER"
        && active_owner_count(&mut *tx).await? <= 1
    {
        let _ = tx.rollback().await;
        return Err(AppError::Conflict(
            "Impossible de rétrograder le dernier Propriétaire actif.".into(),
        ));
    }
    let result = async {
        sqlx::query(
            "UPDATE users SET role_id = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?;",
        )
        .bind(&next_role_id)
        .bind(&target_id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            Some(actor_id),
            "USER_ROLE_UPDATED",
            "users",
            &target_id,
            &json!({ "nextRoleId": next_role_id }),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    user_by_id(pool, &target_id).await
}

pub async fn list_roles(pool: &SqlitePool) -> Result<Json, AppError> {
    let role_rows: Vec<SqliteRow> =
        sqlx::query("SELECT id, code, name, description FROM roles ORDER BY is_system DESC, name ASC;")
            .fetch_all(pool)
            .await?;
    let mut roles = Vec::with_capacity(role_rows.len());
    for role in role_rows {
        let id: String = role.try_get("id")?;
        let perm_rows: Vec<SqliteRow> = sqlx::query(
            "SELECT p.id, p.code, p.module, p.description
             FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
             WHERE rp.role_id = ? ORDER BY p.module ASC, p.code ASC;",
        )
        .bind(&id)
        .fetch_all(pool)
        .await?;
        let mut value = json::row_to_json(role, BOOL_COLUMNS);
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "permissions".to_string(),
                json::rows_to_json(perm_rows, BOOL_COLUMNS),
            );
        }
        roles.push(value);
    }
    Ok(Json::Array(roles))
}

pub async fn list_login_logs(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let limit = json::opt_i64(input, "limit").unwrap_or(50).clamp(1, 200);
    let rows: Vec<SqliteRow> = sqlx::query(
        "SELECT id, user_id AS userId, username_attempted AS usernameAttempted,
                success, reason, created_at AS createdAt
         FROM login_logs ORDER BY created_at DESC LIMIT ?;",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, BOOL_COLUMNS))
}

// ---------------------------------------------------------------------------
// LOT 1 — Paramètres du dépôt
// ---------------------------------------------------------------------------

pub async fn settings_get(pool: &SqlitePool) -> Result<Json, AppError> {
    json::to_json(&fetch_business_settings(pool).await?)
}

pub async fn settings_update(
    pool: &SqlitePool,
    actor_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let depot_name = json::str_field(input, "depotName")?;
    let owner_name = json::str_field(input, "ownerName")?;
    if depot_name.chars().count() < 2 || depot_name.chars().count() > 120 {
        return Err(validation("Nom du dépôt requis"));
    }
    if owner_name.chars().count() < 2 || owner_name.chars().count() > 120 {
        return Err(validation("Nom du propriétaire requis"));
    }
    let policy = json::str_field(input, "defaultConsignmentPolicy")?;
    if !matches!(policy.as_str(), "SEPARATE_TRACKING" | "AUTO_INCLUDE_CRATES") {
        return Err(validation("Politique de consignes invalide"));
    }
    let width = json::str_field(input, "receiptPrintWidth")?;
    if !matches!(width.as_str(), "58mm" | "80mm") {
        return Err(validation("Largeur de ticket invalide"));
    }
    let allow_negative_stock = json::bool_field(input, "allowNegativeStock")?;
    let float_xof = valid_xof(json::i64_field(input, "defaultCashFloatXof")?, "Fonds de caisse initial")?;

    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM business_settings LIMIT 1;")
        .fetch_optional(pool)
        .await?;
    let (settings_id,) = existing.ok_or_else(|| {
        AppError::NotFound("Configuration introuvable. Veuillez initialiser le dépôt.".into())
    })?;

    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE business_settings
             SET depot_name = ?, owner_name = ?, phone = ?, address = ?, logo_path = ?,
                 receipt_header = ?, receipt_footer = ?, default_consignment_policy = ?,
                 allow_negative_stock = ?, default_cash_float_xof = ?,
                 receipt_print_width = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?;",
        )
        .bind(&depot_name)
        .bind(&owner_name)
        .bind(json::nullable_str(input, "phone"))
        .bind(json::nullable_str(input, "address"))
        .bind(json::nullable_str(input, "logoPath"))
        .bind(json::nullable_str(input, "receiptHeader"))
        .bind(json::nullable_str(input, "receiptFooter"))
        .bind(&policy)
        .bind(if allow_negative_stock { 1_i64 } else { 0_i64 })
        .bind(float_xof)
        .bind(&width)
        .bind(&settings_id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            Some(actor_id),
            "DEPOT_SETTINGS_UPDATED",
            "business_settings",
            &settings_id,
            &json!({ "depotName": depot_name, "allowNegativeStock": allow_negative_stock }),
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    match result {
        Ok(()) => tx.commit().await?,
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(err);
        }
    }
    settings_get(pool).await
}
