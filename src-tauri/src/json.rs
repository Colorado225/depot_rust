//! LOT 10 — Frontière JSON des commandes Tauri.
//!
//! L'interface React envoie des objets en `camelCase` (identiques aux corps
//! HTTP du backend Node). Les commandes Rust reçoivent donc une `Value` et
//! délèguent immédiatement à un service de domaine / dépôt SQLx : la validation
//! métier reste côté Rust. Les lignes SQLite sont converties en `camelCase` pour
//! que les DTO restent strictement compatibles avec le frontend existant.

use crate::error::AppError;
use serde_json::{Map, Value};
use sqlx::sqlite::SqliteRow;
use sqlx::{Column, Row, TypeInfo};

pub type Json = Value;

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn ok() -> Json {
    Value::Object(Map::from_iter([("ok".to_string(), Value::Bool(true))]))
}

fn required<T>(value: Option<T>, key: &str) -> Result<T, AppError> {
    value.ok_or_else(|| AppError::Validation(format!("Champ requis ou invalide : {key}")))
}

pub fn str_field(input: &Json, key: &str) -> Result<String, AppError> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    required(value, key)
}

pub fn opt_str(input: &Json, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

pub fn nullable_str(input: &Json, key: &str) -> Option<String> {
    opt_str(input, key)
}

pub fn i64_field(input: &Json, key: &str) -> Result<i64, AppError> {
    let value = input.get(key).and_then(Value::as_i64);
    required(value, key)
}

pub fn opt_i64(input: &Json, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

pub fn bool_field(input: &Json, key: &str) -> Result<bool, AppError> {
    let value = input.get(key).and_then(Value::as_bool);
    required(value, key)
}

pub fn opt_bool(input: &Json, key: &str) -> Option<bool> {
    input.get(key).and_then(Value::as_bool)
}

pub fn token(input: &Json) -> Result<String, AppError> {
    str_field(input, "token")
}

fn to_camel_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for ch in name.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn decode_cell(row: &SqliteRow, index: usize) -> Value {
    let type_name = row.columns()[index].type_info().name().to_uppercase();
    let decoded = match type_name.as_str() {
        "INTEGER" | "INT" | "INT8" | "BIGINT" | "BOOLEAN" => row
            .try_get::<Option<i64>, _>(index)
            .ok()
            .flatten()
            .map(Value::from),
        "REAL" | "FLOAT" | "DOUBLE" | "NUMERIC" => row
            .try_get::<Option<f64>, _>(index)
            .ok()
            .flatten()
            .and_then(|v| serde_json::Number::from_f64(v))
            .map(Value::Number),
        "TEXT" | "VARCHAR" | "CHAR" | "DATE" | "DATETIME" => row
            .try_get::<Option<String>, _>(index)
            .ok()
            .flatten()
            .map(Value::String),
        _ => None,
    };
    if let Some(value) = decoded {
        return value;
    }
    // Colonnes calculées (COUNT, PRAGMA, expressions) : type inconnu.
    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(index) {
        return Value::from(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(index) {
        return Value::String(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(index) {
        return serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null);
    }
    Value::Null
}

pub fn row_to_json(row: SqliteRow, bool_columns: &[&str]) -> Json {
    let mut map = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let key = to_camel_case(column.name());
        let mut value = decode_cell(&row, index);
        if bool_columns.contains(&key.as_str()) {
            value = match value {
                Value::Number(n) => Value::Bool(n.as_i64().unwrap_or(0) != 0),
                other => other,
            };
        }
        map.insert(key, value);
    }
    Value::Object(map)
}

pub fn rows_to_json(rows: Vec<SqliteRow>, bool_columns: &[&str]) -> Json {
    Value::Array(rows.into_iter().map(|r| row_to_json(r, bool_columns)).collect())
}

/// Convertit une structure `Serialize` en `Value` (DTO existants du LOT 0/1).
pub fn to_json<T: serde::Serialize>(value: &T) -> Result<Json, AppError> {
    serde_json::to_value(value).map_err(|e| AppError::Internal(format!("Sérialisation DTO : {e}")))
}

/// Tableau JSON obligatoire (`units`, `items`, `lines`…).
pub fn array_field(input: &Json, key: &str, min_len: usize, label: &str) -> Result<Vec<Json>, AppError> {
    let items = input
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Validation(format!("{label} : tableau requis")))?;
    if items.len() < min_len {
        return Err(AppError::Validation(format!(
            "{label} : au moins {min_len} élément(s) requis"
        )));
    }
    Ok(items.clone())
}

/// Chaîne obligatoire, trimmée, avec bornes de longueur (équivalent Zod).
pub fn text_field(
    input: &Json,
    key: &str,
    min_len: usize,
    max_len: usize,
    label: &str,
) -> Result<String, AppError> {
    let value = str_field(input, key).map_err(|_| {
        AppError::Validation(format!("{label} est obligatoire (champ « {key} »)"))
    })?;
    let len = value.chars().count();
    if len < min_len || len > max_len {
        return Err(AppError::Validation(format!(
            "{label} : longueur comprise entre {min_len} et {max_len} caractères"
        )));
    }
    Ok(value)
}

/// Chaîne facultative, trimmée et bornée ; `null` ou `""` deviennent `None`.
pub fn optional_text(input: &Json, key: &str, max_len: usize, label: &str) -> Result<Option<String>, AppError> {
    match opt_str(input, key) {
        None => Ok(None),
        Some(value) => {
            let len = value.chars().count();
            if len > max_len {
                return Err(AppError::Validation(format!(
                    "{label} : {max_len} caractères maximum"
                )));
            }
            Ok(Some(value))
        }
    }
}

/// Énumération obligatoire (statuts, méthodes de paiement, types de mouvement).
pub fn enum_field(input: &Json, key: &str, allowed: &[&str]) -> Result<String, AppError> {
    let value = str_field(input, key)?;
    if !allowed.contains(&value.as_str()) {
        return Err(AppError::Validation(format!(
            "Valeur invalide pour « {key} » : {value} (attendu : {})",
            allowed.join(", ")
        )));
    }
    Ok(value)
}

/// Entier obligatoire, positif ou nul, avec libellé métier.
pub fn non_negative_i64(input: &Json, key: &str, label: &str) -> Result<i64, AppError> {
    let value = i64_field(input, key).map_err(|_| {
        AppError::Validation(format!("{label} doit être un entier FCFA (champ « {key} »)"))
    })?;
    if value < 0 {
        return Err(AppError::Validation(format!("{label} ne peut pas être négatif")));
    }
    Ok(value)
}

/// Entier obligatoire strictement positif.
pub fn positive_i64(input: &Json, key: &str, label: &str) -> Result<i64, AppError> {
    let value = non_negative_i64(input, key, label)?;
    if value < 1 {
        return Err(AppError::Validation(format!("{label} doit être supérieur ou égal à 1")));
    }
    Ok(value)
}

/// Identifiant d'entité transmis dans l'URL par le client (`omitKeysFromBody`).
pub fn id_field(input: &Json) -> Result<String, AppError> {
    str_field(input, "id")
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn colonnes_snake_case_en_camel_case() {
        assert_eq!(to_camel_case("default_cash_float_xof"), "defaultCashFloatXof");
        assert_eq!(to_camel_case("id"), "id");
        assert_eq!(to_camel_case("alreadyCamel"), "alreadyCamel");
    }

    #[test]
    fn champs_obligatoires_rejettes_les_vides() {
        let input = serde_json::json!({ "username": "   ", "password": "Password2026!" });
        assert!(str_field(&input, "username").is_err());
        assert_eq!(str_field(&input, "password").unwrap(), "Password2026!");
    }

    #[test]
    fn validation_des_payloads_de_la_tranche_2() {
        let input = serde_json::json!({
            "name": "  Casier 24  ",
            "kind": "CRATE",
            "depositAmountXof": 1500,
            "units": [{ "unitId": "u1" }],
            "note": null
        });
        assert_eq!(text_field(&input, "name", 2, 120, "Désignation").unwrap(), "Casier 24");
        assert_eq!(enum_field(&input, "kind", &["BOTTLE", "CRATE", "OTHER"]).unwrap(), "CRATE");
        assert!(enum_field(&input, "kind", &["BOTTLE"]).is_err());
        assert_eq!(non_negative_i64(&input, "depositAmountXof", "Consigne").unwrap(), 1500);
        assert!(positive_i64(&input, "quantity", "Quantité").is_err());
        assert_eq!(array_field(&input, "units", 1, "Unités").unwrap().len(), 1);
        assert_eq!(optional_text(&input, "note", 240, "Note").unwrap(), None);
    }
}
