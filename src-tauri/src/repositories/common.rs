//! LOT 10 — Socle commun des dépôts des tranches 2-4.
//!
//! Centralise l'audit, les messages d'erreur métier, les contrôles d'existence,
//! la génération des numéros de documents et l'assemblage des DTO imbriqués.
//! Aucune logique ici n'est exécutée dans la webview : tout passe par les
//! commandes Tauri → services de domaine Rust → dépôts SQLx → SQLite.

use crate::domain::money::XofAmount;
use crate::error::AppError;
use crate::json::{self, Json};
use serde_json::Value;
use sqlx::sqlite::SqliteConnection;
use sqlx::SqlitePool;

pub fn validation(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

pub fn conflict(message: impl Into<String>) -> AppError {
    AppError::Conflict(message.into())
}

pub fn not_found(message: impl Into<String>) -> AppError {
    AppError::NotFound(message.into())
}

pub fn insufficient_stock(message: impl Into<String>) -> AppError {
    AppError::InsufficientStock(message.into())
}

pub fn xof(value: i64, label: &str) -> Result<i64, AppError> {
    XofAmount::non_negative(value)
        .map(XofAmount::raw)
        .map_err(|_| validation(format!("{label} doit être un entier FCFA positif ou nul")))
}

pub fn add_xof(left: i64, right: i64, label: &str) -> Result<i64, AppError> {
    XofAmount::new(left)
        .checked_add(XofAmount::new(right))
        .map(XofAmount::raw)
        .map_err(|_| validation(format!("Dépassement arithmétique XOF ({label})")))
}

pub fn mul_xof(unit_price_xof: i64, qty: i64, label: &str) -> Result<i64, AppError> {
    let price = xof(unit_price_xof, label)?;
    if qty < 0 {
        return Err(validation(format!("Quantité invalide ({label}) : {qty}")));
    }
    XofAmount::new(price)
        .checked_mul_qty(qty)
        .map(XofAmount::raw)
        .map_err(|_| validation(format!("Dépassement arithmétique XOF ({label})")))
}

pub fn mul_qty(a: i64, b: i64, label: &str) -> Result<i64, AppError> {
    if a < 0 || b < 0 {
        return Err(validation(format!("Quantité invalide ({label})")));
    }
    a.checked_mul(b)
        .ok_or_else(|| validation(format!("Dépassement arithmétique ({label})")))
}

/// `%terme%` en minuscules pour les filtres `LIKE` insensibles à la casse.
pub fn like(input: &Json, key: &str) -> Option<String> {
    json::opt_str(input, key).map(|value| format!("%{}%", value.to_lowercase()))
}

/// Retrouve un DTO par clé dans un tableau JSON (après insertion/maj).
pub fn find<'a>(rows: &'a Json, key: &str, value: &str) -> Option<&'a Json> {
    rows.as_array()?
        .iter()
        .find(|item| item.get(key).and_then(Value::as_str) == Some(value))
}

/// Attache un tableau d'enfants (`units`, `items`) à un DTO parent.
pub fn attach(parent: Json, key: &str, children: Json) -> Json {
    match parent {
        Value::Object(mut map) => {
            map.insert(key.to_string(), children);
            Value::Object(map)
        }
        other => other,
    }
}

/// `BC-123456-AB12`, `REC-…`, `PAY-FRN-…`, `RET-FRN-…` : même forme que
/// `generateDocNumber()` de `purchaseRepo.ts` (6 chiffres + 4 hex majuscules).
pub fn doc_number(prefix: &str) -> String {
    let millis = chrono::Utc::now().timestamp_millis().rem_euclid(1_000_000);
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let rand = uuid.get(..4).unwrap_or("0000").to_uppercase();
    format!("{prefix}-{millis:06}-{rand}")
}

/// Horodatage SQLite identique au backend Node (`strftime` dans les requêtes).
pub const SQL_NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

pub async fn audit(
    tx: &mut SqliteConnection,
    actor_user_id: &str,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: &Json,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(json::new_id())
    .bind(actor_user_id)
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(payload.to_string())
    .execute(tx)
    .await?;
    Ok(())
}

/// Vérifie l'existence d'une entité référencée (un seul paramètre `?`).
pub async fn exists(
    tx: &mut SqliteConnection,
    sql: &str,
    id: &str,
) -> Result<bool, AppError> {
    let row: Option<(String,)> = sqlx::query_as(sql).bind(id).fetch_optional(tx).await?;
    Ok(row.is_some())
}

pub async fn exists_pool(pool: &SqlitePool, sql: &str, id: &str) -> Result<bool, AppError> {
    let row: Option<(String,)> = sqlx::query_as(sql).bind(id).fetch_optional(pool).await?;
    Ok(row.is_some())
}

/// Canaux de paiement autorisés (contrôle CHECK du schéma SQLite).
pub const PAYMENT_METHODS: &[&str] = &[
    "CASH", "ORANGE_MONEY", "MTN_MOMO", "MOOV_MONEY", "WAVE", "BANK_TRANSFER",
];

/// Valide une date de rapport au format `AAAA-MM-JJ` (port de `normalizeDate`).
pub fn normalize_date(input: &Json, key: &str) -> Result<Option<String>, AppError> {
    let Some(value) = json::opt_str(input, key) else {
        return Ok(None);
    };
    let bytes = value.as_bytes();
    let valid = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !valid {
        return Err(validation(format!(
            "Format de date invalide (attendu AAAA-MM-JJ) : {value}"
        )));
    }
    Ok(Some(value))
}

/// Taux de marge en dixièmes de pourcent, arrondi comme `Math.round` de
/// `reportsRepo.ts` : `floor((2*marge*1000 + CA) / (2*CA))`, sans flottant.
pub fn margin_rate_tenths(revenue_xof: i64, margin_xof: i64) -> i64 {
    if revenue_xof <= 0 {
        return 0;
    }
    let revenue = i128::from(revenue_xof);
    let scaled = i128::from(margin_xof) * 1000;
    let rounded = (2 * scaled + revenue).div_euclid(2 * revenue);
    i64::try_from(rounded).unwrap_or(0)
}

/// Borne une limite de liste (équivalent des `Math.min/Math.max` des dépôts TS).
pub fn bounded_limit(input: &Json, default: i64, max: i64) -> i64 {
    json::opt_i64(input, "limit").unwrap_or(default).clamp(1, max)
}

/// Lit un entier d'un DTO JSON (valeur calculée ou colonne convertie).
pub fn number(dto: &Json, key: &str) -> i64 {
    dto.get(key).and_then(serde_json::Value::as_i64).unwrap_or(0)
}

/// Lit une chaîne nullable d'un DTO JSON.
pub fn text(dto: &Json, key: &str) -> Option<String> {
    dto.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// Liste blanche de booléens convertis par `json::rows_to_json`.
pub const BOOL_TRUE: i64 = 1;
pub const BOOL_FALSE: i64 = 0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arithmetique_xof_entiere() {
        assert_eq!(mul_xof(9_600, 10, "Total").unwrap(), 96_000);
        assert!(mul_xof(-1, 10, "Total").is_err());
        assert!(add_xof(i64::MAX, 1, "Total").is_err());
    }

    #[test]
    fn numero_de_document_au_format_node() {
        let number = doc_number("BC");
        assert!(number.starts_with("BC-"));
        assert_eq!(number.len(), "BC-".len() + 6 + 1 + 4);
    }

    #[test]
    fn filtre_like_et_recherche_de_dto() {
        let input = serde_json::json!({ "search": "  CASIER " });
        assert_eq!(like(&input, "search").unwrap(), "%casier%");
        let rows = serde_json::json!([{ "id": "p1" }, { "id": "p2" }]);
        assert_eq!(find(&rows, "id", "p2").unwrap()["id"], "p2");
    }

    #[test]
    fn dates_de_rapport_et_taux_de_marge() {
        let ok = serde_json::json!({ "startDate": "2026-11-15" });
        assert_eq!(normalize_date(&ok, "startDate").unwrap().unwrap(), "2026-11-15");
        let bad = serde_json::json!({ "startDate": "15/11/2026" });
        assert!(normalize_date(&bad, "startDate").is_err());
        assert_eq!(margin_rate_tenths(1000, 250), 250);
        assert_eq!(margin_rate_tenths(0, 250), 0);
        // Arrondi de Math.round, y compris pour une marge négative.
        assert_eq!(margin_rate_tenths(2, -1), -500);
        assert_eq!(margin_rate_tenths(4, -1), -250);
    }

    #[test]
    fn limite_bornee_et_methodes_de_paiement() {
        assert_eq!(bounded_limit(&serde_json::json!({}), 150, 300), 150);
        assert_eq!(bounded_limit(&serde_json::json!({ "limit": 9999 }), 30, 200), 200);
        assert_eq!(PAYMENT_METHODS.len(), 6);
        assert!(PAYMENT_METHODS.contains(&"WAVE"));
    }
}
