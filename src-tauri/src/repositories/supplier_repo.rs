//! LOT 10 — Tranche 2, Fournisseurs : port de `server/repositories/supplierRepo.ts`.
//!
//! Unicité du nom (insensible à la casse), délai de paiement 0..365,
//! archivage réversible et audit sont appliqués dans le backend Rust.

use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{self, audit, exists, find, like, not_found, conflict};
use serde_json::json;
use sqlx::SqlitePool;

const SUPPLIER_TYPES: &[&str] = &["BRASSERIE", "DISTRIBUTEUR", "IMPORTATEUR", "AUTRE"];
const BOOL_SUPPLIERS: &[&str] = &["isActive"];

struct SupplierInput {
    name: String,
    supplier_type: String,
    phone: Option<String>,
    email: Option<String>,
    address: Option<String>,
    tax_id: Option<String>,
    payment_terms_days: i64,
    notes: Option<String>,
}

fn validate_supplier(input: &Json) -> Result<SupplierInput, AppError> {
    let payment_terms_days = json::non_negative_i64(input, "paymentTermsDays", "Délai de paiement")?;
    if payment_terms_days > 365 {
        return Err(common::validation(
            "Le délai de paiement ne peut pas dépasser 365 jours.",
        ));
    }
    Ok(SupplierInput {
        name: json::text_field(input, "name", 2, 120, "Nom du fournisseur")?,
        supplier_type: json::enum_field(input, "supplierType", SUPPLIER_TYPES)?,
        phone: json::optional_text(input, "phone", 40, "Téléphone")?,
        email: json::optional_text(input, "email", 120, "E-mail")?,
        address: json::optional_text(input, "address", 240, "Adresse")?,
        tax_id: json::optional_text(input, "taxId", 60, "Identifiant fiscal")?,
        payment_terms_days,
        notes: json::optional_text(input, "notes", 400, "Notes")?,
    })
}

async fn list_suppliers_query(
    pool: &SqlitePool,
    search: Option<String>,
    include_inactive: bool,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT s.id, s.name, s.supplier_type, s.phone, s.email, s.address,
                s.tax_id, s.payment_terms_days, s.notes, s.balance_due_xof,
                (SELECT COUNT(*) FROM products p
                 WHERE p.preferred_supplier_id = s.id AND p.is_active = 1) AS linked_products_count,
                s.is_active, s.created_at, s.updated_at
         FROM suppliers s
         WHERE (? IS NULL OR s.is_active = 1)
           AND (? IS NULL OR (LOWER(s.name) LIKE ? OR LOWER(COALESCE(s.phone, '')) LIKE ?
                              OR LOWER(COALESCE(s.tax_id, '')) LIKE ?))
         ORDER BY s.name ASC",
    )
    .bind(if include_inactive { None } else { Some(1_i64) })
    .bind(search.clone())
    .bind(search.clone())
    .bind(search.clone())
    .bind(search)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, BOOL_SUPPLIERS))
}

pub async fn list_suppliers(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_suppliers_query(
        pool,
        like(input, "search"),
        json::opt_bool(input, "includeInactive").unwrap_or(false),
    )
    .await
}

async fn get_supplier(pool: &SqlitePool, supplier_id: &str) -> Result<Json, AppError> {
    let rows = list_suppliers_query(pool, None, true).await?;
    find(&rows, "id", supplier_id)
        .cloned()
        .ok_or_else(|| not_found("Fournisseur introuvable."))
}

pub async fn create_supplier(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let supplier = validate_supplier(input)?;
    let duplicate: Option<(String,)> =
        sqlx::query_as("SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)")
            .bind(&supplier.name)
            .fetch_optional(pool)
            .await?;
    if duplicate.is_some() {
        return Err(conflict(format!(
            "Un fournisseur nommé « {} » existe déjà.",
            supplier.name
        )));
    }
    let id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO suppliers (
               id, name, supplier_type, phone, email, address, tax_id,
               payment_terms_days, notes, balance_due_xof, is_active
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)",
        )
        .bind(&id)
        .bind(&supplier.name)
        .bind(&supplier.supplier_type)
        .bind(&supplier.phone)
        .bind(&supplier.email)
        .bind(&supplier.address)
        .bind(&supplier.tax_id)
        .bind(supplier.payment_terms_days)
        .bind(&supplier.notes)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "SUPPLIER_CREATED",
            "suppliers",
            &id,
            &json!({ "name": supplier.name, "supplierType": supplier.supplier_type }),
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
    get_supplier(pool, &id).await
}

pub async fn update_supplier(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let id = json::id_field(input)?;
    let supplier = validate_supplier(input)?;
    let duplicate: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND id != ?",
    )
    .bind(&supplier.name)
    .bind(&id)
    .fetch_optional(pool)
    .await?;
    if duplicate.is_some() {
        return Err(conflict(format!(
            "Un autre fournisseur porte déjà le nom « {} ».",
            supplier.name
        )));
    }
    let mut tx = pool.begin().await?;
    if !exists(&mut *tx, "SELECT id FROM suppliers WHERE id = ?", &id).await? {
        let _ = tx.rollback().await;
        return Err(not_found("Fournisseur introuvable."));
    }
    let result = async {
        sqlx::query(
            "UPDATE suppliers
             SET name = ?, supplier_type = ?, phone = ?, email = ?, address = ?,
                 tax_id = ?, payment_terms_days = ?, notes = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?",
        )
        .bind(&supplier.name)
        .bind(&supplier.supplier_type)
        .bind(&supplier.phone)
        .bind(&supplier.email)
        .bind(&supplier.address)
        .bind(&supplier.tax_id)
        .bind(supplier.payment_terms_days)
        .bind(&supplier.notes)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "SUPPLIER_UPDATED",
            "suppliers",
            &id,
            &json!({ "name": supplier.name }),
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
    get_supplier(pool, &id).await
}

pub async fn toggle_supplier_active(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let id = json::id_field(input)?;
    let is_active = json::bool_field(input, "isActive")
        .map_err(|_| common::validation("Statut invalide (isActive attendu)"))?;
    let mut tx = pool.begin().await?;
    if !exists(&mut *tx, "SELECT id FROM suppliers WHERE id = ?", &id).await? {
        let _ = tx.rollback().await;
        return Err(not_found("Fournisseur introuvable."));
    }
    let result = async {
        sqlx::query(
            "UPDATE suppliers SET is_active = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?",
        )
        .bind(if is_active { 1_i64 } else { 0_i64 })
        .bind(&id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            if is_active { "SUPPLIER_RESTORED" } else { "SUPPLIER_ARCHIVED" },
            "suppliers",
            &id,
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
    get_supplier(pool, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_fournisseur() {
        let ok = serde_json::json!({
            "name": "Brasserie CI", "supplierType": "BRASSERIE",
            "paymentTermsDays": 30, "phone": null
        });
        let parsed = validate_supplier(&ok).unwrap();
        assert_eq!(parsed.name, "Brasserie CI");
        assert_eq!(parsed.payment_terms_days, 30);
        assert_eq!(parsed.phone, None);
        assert!(validate_supplier(&serde_json::json!({
            "name": "X", "supplierType": "INCONNU", "paymentTermsDays": 0
        }))
        .is_err());
        assert!(validate_supplier(&serde_json::json!({
            "name": "Brasserie CI", "supplierType": "AUTRE", "paymentTermsDays": 366
        }))
        .is_err());
    }
}
