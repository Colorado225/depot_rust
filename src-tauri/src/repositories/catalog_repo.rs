//! LOT 10 — Tranche 2, Catalogue : port de `server/repositories/catalogRepo.ts`.
//!
//! Unicité SKU / codes-barres, existence des références, normalisation des
//! unités de vente et l'audit sont exécutés ici, dans le backend Rust. Les DTO
//! (`camelCase`, `units` imbriquées) restent identiques à ceux du pont HTTP.

use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{self, audit, attach, exists, exists_pool, find, like};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

const BOOL_UNITS: &[&str] = &["isBaseUnit", "isDefaultSaleUnit"];
const BOOL_PRODUCTS: &[&str] = &["isActive"];
const PACKAGING_KINDS: &[&str] = &["BOTTLE", "CRATE", "OTHER"];

struct ProductUnitInput {
    unit_id: String,
    conversion_to_base: i64,
    wholesale_price_xof: i64,
    retail_price_xof: i64,
    barcode: Option<String>,
    is_default_sale_unit: bool,
}

struct ProductInput {
    sku: String,
    barcode: Option<String>,
    name: String,
    category_id: Option<String>,
    brand_id: Option<String>,
    preferred_supplier_id: Option<String>,
    format_label: Option<String>,
    base_unit_id: String,
    bottle_packaging_type_id: Option<String>,
    crate_packaging_type_id: Option<String>,
    purchase_price_xof: i64,
    wholesale_price_xof: i64,
    retail_price_xof: i64,
    alert_threshold_base: i64,
    units: Vec<ProductUnitInput>,
}

pub async fn list_categories(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT c.id, c.name, c.description, c.created_at,
                (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS product_count
         FROM categories c ORDER BY c.name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

pub async fn create_category(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let name = json::text_field(input, "name", 2, 80, "Nom de catégorie")?;
    let description = json::optional_text(input, "description", 240, "Description")?;
    let duplicate: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM categories WHERE LOWER(name) = LOWER(?)",
    )
    .bind(&name)
    .fetch_optional(pool)
    .await?;
    if duplicate.is_some() {
        return Err(common::conflict(format!("La catégorie « {name} » existe déjà.")));
    }

    let id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query("INSERT INTO categories (id, name, description) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(&name)
            .bind(&description)
            .execute(&mut *tx)
            .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "CATEGORY_CREATED",
            "categories",
            &id,
            &json!({ "name": name }),
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
    find_or_fail(&list_categories(pool).await?, "id", &id)
}

pub async fn list_brands(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT b.id, b.name, b.created_at,
                (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id AND p.is_active = 1) AS product_count
         FROM brands b ORDER BY b.name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

pub async fn create_brand(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let name = json::text_field(input, "name", 2, 80, "Nom de marque")?;
    let duplicate: Option<(String,)> =
        sqlx::query_as("SELECT id FROM brands WHERE LOWER(name) = LOWER(?)")
            .bind(&name)
            .fetch_optional(pool)
            .await?;
    if duplicate.is_some() {
        return Err(common::conflict(format!("La marque « {name} » existe déjà.")));
    }

    let id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query("INSERT INTO brands (id, name) VALUES (?, ?)")
            .bind(&id)
            .bind(&name)
            .execute(&mut *tx)
            .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "BRAND_CREATED",
            "brands",
            &id,
            &json!({ "name": name }),
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
    find_or_fail(&list_brands(pool).await?, "id", &id)
}

pub async fn list_units(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT id, code, name, is_base_unit FROM units ORDER BY is_base_unit DESC, name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, BOOL_UNITS))
}

pub async fn list_packaging(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT id, code, name, kind, deposit_amount_xof, created_at
         FROM packaging_types ORDER BY kind ASC, name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

fn validate_packaging(input: &Json, with_code: bool) -> Result<(Option<String>, String, String, i64), AppError> {
    let code = if with_code {
        let code = json::text_field(input, "code", 2, 30, "Code emballage")?;
        if !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(common::validation(
                "Code emballage : lettres, chiffres, _ ou - uniquement.",
            ));
        }
        Some(code.to_uppercase())
    } else {
        None
    };
    let name = json::text_field(input, "name", 2, 100, "Désignation")?;
    let kind = json::enum_field(input, "kind", PACKAGING_KINDS)?;
    let deposit = json::non_negative_i64(input, "depositAmountXof", "Montant de consigne")?;
    Ok((code, name, kind, deposit))
}

pub async fn create_packaging(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let (code, name, kind, deposit) = validate_packaging(input, true)?;
    let code = code.unwrap_or_default();
    let duplicate: Option<(String,)> =
        sqlx::query_as("SELECT id FROM packaging_types WHERE UPPER(code) = ?")
            .bind(&code)
            .fetch_optional(pool)
            .await?;
    if duplicate.is_some() {
        return Err(common::conflict(format!(
            "Le code emballage « {code} » existe déjà."
        )));
    }

    let id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO packaging_types (id, code, name, kind, deposit_amount_xof)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&code)
        .bind(&name)
        .bind(&kind)
        .bind(deposit)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "PACKAGING_TYPE_CREATED",
            "packaging_types",
            &id,
            &json!({ "code": code, "depositAmountXof": deposit }),
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
    find_or_fail(&list_packaging(pool).await?, "id", &id)
}

pub async fn update_packaging(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let id = json::id_field(input)?;
    let (_, name, kind, deposit) = validate_packaging(input, false)?;
    let mut tx = pool.begin().await?;
    if !exists(&mut *tx, "SELECT id FROM packaging_types WHERE id = ?", &id).await? {
        let _ = tx.rollback().await;
        return Err(common::not_found("Type d’emballage introuvable."));
    }
    let result = async {
        sqlx::query(
            "UPDATE packaging_types
             SET name = ?, kind = ?, deposit_amount_xof = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?",
        )
        .bind(&name)
        .bind(&kind)
        .bind(deposit)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "PACKAGING_TYPE_UPDATED",
            "packaging_types",
            &id,
            &json!({ "name": name, "depositAmountXof": deposit }),
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
    find_or_fail(&list_packaging(pool).await?, "id", &id)
}

/// Liste les produits avec filtres, puis attache les conditionnements par produit.
pub async fn list_products(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_products_query(
        pool,
        like(input, "search"),
        json::opt_str(input, "categoryId"),
        json::opt_str(input, "brandId"),
        json::opt_bool(input, "includeInactive").unwrap_or(false),
    )
    .await
}

async fn list_products_query(
    pool: &SqlitePool,
    search: Option<String>,
    category_id: Option<String>,
    brand_id: Option<String>,
    include_inactive: bool,
) -> Result<Json, AppError> {
    let active_filter: Option<i64> = if include_inactive { None } else { Some(1) };
    let rows = sqlx::query(
        "SELECT p.id, p.sku, p.barcode, p.name,
                p.category_id, c.name AS category_name,
                p.brand_id, b.name AS brand_name,
                p.preferred_supplier_id, sp.name AS preferred_supplier_name,
                p.format_label, p.base_unit_id, u.name AS base_unit_name,
                p.bottle_packaging_type_id, bp.name AS bottle_packaging_name,
                COALESCE(bp.deposit_amount_xof, 0) AS bottle_deposit_xof,
                p.crate_packaging_type_id, cp.name AS crate_packaging_name,
                COALESCE(cp.deposit_amount_xof, 0) AS crate_deposit_xof,
                p.purchase_price_xof, p.weighted_avg_cost_xof,
                p.wholesale_price_xof, p.retail_price_xof, p.alert_threshold_base,
                COALESCE(sb.quantity_base, 0) AS stock_quantity_base,
                p.is_active, p.created_at, p.updated_at
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN suppliers sp ON sp.id = p.preferred_supplier_id
         JOIN units u ON u.id = p.base_unit_id
         LEFT JOIN packaging_types bp ON bp.id = p.bottle_packaging_type_id
         LEFT JOIN packaging_types cp ON cp.id = p.crate_packaging_type_id
         LEFT JOIN stock_balances sb ON sb.product_id = p.id
         WHERE (? IS NULL OR p.is_active = 1)
           AND (? IS NULL OR p.category_id = ?)
           AND (? IS NULL OR p.brand_id = ?)
           AND (? IS NULL OR (
                LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ?
                OR LOWER(COALESCE(p.barcode, '')) LIKE ?
                OR EXISTS (SELECT 1 FROM product_units pu2
                           WHERE pu2.product_id = p.id
                             AND LOWER(COALESCE(pu2.barcode, '')) LIKE ?)))
         ORDER BY p.name ASC",
    )
    .bind(active_filter)
    .bind(category_id.clone())
    .bind(category_id)
    .bind(brand_id.clone())
    .bind(brand_id)
    .bind(search.clone())
    .bind(search.clone())
    .bind(search.clone())
    .bind(search.clone())
    .bind(search)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let product_id: String = row.try_get("id")?;
        let unit_rows = list_product_units(pool, &product_id).await?;
        out.push(attach(
            json::row_to_json(row, BOOL_PRODUCTS),
            "units",
            unit_rows,
        ));
    }
    Ok(Value::Array(out))
}

async fn list_product_units(pool: &SqlitePool, product_id: &str) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT pu.id, pu.product_id, pu.unit_id, u.code AS unit_code, u.name AS unit_name,
                pu.conversion_to_base, pu.wholesale_price_xof, pu.retail_price_xof,
                pu.barcode, pu.is_default_sale_unit
         FROM product_units pu JOIN units u ON u.id = pu.unit_id
         WHERE pu.product_id = ? ORDER BY pu.conversion_to_base ASC",
    )
    .bind(product_id)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, BOOL_UNITS))
}

async fn get_product(pool: &SqlitePool, product_id: &str) -> Result<Json, AppError> {
    let rows = list_products_query(pool, None, None, None, true).await?;
    find(&rows, "id", product_id)
        .cloned()
        .ok_or_else(|| common::not_found("Produit introuvable."))
}

async fn assert_barcode_available(
    pool: &SqlitePool,
    barcode: &str,
    current_product_id: Option<&str>,
) -> Result<(), AppError> {
    let current = current_product_id.unwrap_or("");
    let product: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM products WHERE barcode = ? AND id != COALESCE(?, '')",
    )
    .bind(barcode)
    .bind(current)
    .fetch_optional(pool)
    .await?;
    if product.is_some() {
        return Err(common::conflict(format!(
            "Le code-barres « {barcode} » est déjà attribué à un autre produit."
        )));
    }
    let unit: Option<(String,)> = sqlx::query_as(
        "SELECT product_id FROM product_units WHERE barcode = ? AND product_id != COALESCE(?, '')",
    )
    .bind(barcode)
    .bind(current)
    .fetch_optional(pool)
    .await?;
    if unit.is_some() {
        return Err(common::conflict(format!(
            "Le code-barres « {barcode} » est déjà attribué au conditionnement d'un autre produit."
        )));
    }
    Ok(())
}

/// Port de `validateProductInput()` : toutes les règles métier sont ici.
async fn validate_product(
    pool: &SqlitePool,
    input: &Json,
    current_product_id: Option<&str>,
) -> Result<ProductInput, AppError> {
    let sku = json::text_field(input, "sku", 2, 64, "Référence SKU")?.to_uppercase();
    let name = json::text_field(input, "name", 2, 160, "Désignation du produit")?;
    let barcode = json::optional_text(input, "barcode", 64, "Code-barres produit")?;
    let format_label = json::optional_text(input, "formatLabel", 60, "Format")?;
    let base_unit_id = json::text_field(input, "baseUnitId", 1, 80, "Unité de base")?;

    let purchase_price_xof = json::non_negative_i64(input, "purchasePriceXof", "Prix d'achat")?;
    let wholesale_price_xof = json::non_negative_i64(input, "wholesalePriceXof", "Prix de gros")?;
    let retail_price_xof = json::non_negative_i64(input, "retailPriceXof", "Prix de détail")?;
    let alert_threshold_base = json::non_negative_i64(input, "alertThresholdBase", "Seuil d'alerte")?;

    let current = current_product_id.unwrap_or("");
    let sku_row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM products WHERE UPPER(sku) = ? AND id != COALESCE(?, '')",
    )
    .bind(&sku)
    .bind(current)
    .fetch_optional(pool)
    .await?;
    if sku_row.is_some() {
        return Err(common::conflict(format!(
            "La référence SKU « {sku} » est déjà utilisée."
        )));
    }

    let category_id = json::opt_str(input, "categoryId");
    let brand_id = json::opt_str(input, "brandId");
    let preferred_supplier_id = json::opt_str(input, "preferredSupplierId");
    let bottle_packaging_type_id = json::opt_str(input, "bottlePackagingTypeId");
    let crate_packaging_type_id = json::opt_str(input, "cratePackagingTypeId");

    let references: [(&str, Option<&str>, &str); 6] = [
        ("SELECT id FROM units WHERE id = ?", Some(base_unit_id.as_str()), "Unité de base introuvable."),
        ("SELECT id FROM categories WHERE id = ?", category_id.as_deref(), "Catégorie introuvable."),
        ("SELECT id FROM brands WHERE id = ?", brand_id.as_deref(), "Marque introuvable."),
        ("SELECT id FROM suppliers WHERE id = ?", preferred_supplier_id.as_deref(), "Fournisseur principal introuvable."),
        ("SELECT id FROM packaging_types WHERE id = ?", bottle_packaging_type_id.as_deref(), "Emballage bouteille introuvable."),
        ("SELECT id FROM packaging_types WHERE id = ?", crate_packaging_type_id.as_deref(), "Emballage casier introuvable."),
    ];
    for (sql, id, message) in references {
        if let Some(id) = id {
            if !exists_pool(pool, sql, id).await? {
                return Err(common::not_found(message));
            }
        }
    }

    if let Some(ref value) = barcode {
        assert_barcode_available(pool, value, current_product_id).await?;
    }
    let mut seen_barcodes: Vec<String> = barcode.clone().into_iter().collect();
    let mut seen_units: Vec<String> = Vec::new();
    let mut units: Vec<ProductUnitInput> = Vec::new();

    for unit in json::array_field(input, "units", 1, "Unités de vente")? {
        let unit_id = json::text_field(&unit, "unitId", 1, 80, "Unité de vente")?;
        if seen_units.contains(&unit_id) {
            return Err(common::validation(
                "Une même unité de vente ne peut pas être déclarée deux fois pour le même produit.",
            ));
        }
        seen_units.push(unit_id.clone());
        if !exists_pool(pool, "SELECT id FROM units WHERE id = ?", &unit_id).await? {
            return Err(common::not_found(format!(
                "Unité de vente introuvable ({unit_id})."
            )));
        }

        let conversion_to_base = json::positive_i64(&unit, "conversionToBase", "Facteur de conversion")?;
        if unit_id == base_unit_id && conversion_to_base != 1 {
            return Err(common::validation(
                "L'unité de base du produit doit obligatoirement avoir une conversion égale à 1.",
            ));
        }
        let wholesale = json::non_negative_i64(&unit, "wholesalePriceXof", "Prix de gros unité")?;
        let retail = json::non_negative_i64(&unit, "retailPriceXof", "Prix de détail unité")?;
        let unit_barcode = json::optional_text(&unit, "barcode", 64, "Code-barres unité")?;
        if let Some(ref value) = unit_barcode {
            if seen_barcodes.contains(value) {
                return Err(common::conflict(format!(
                    "Le code-barres « {value} » est dupliqué sur le même produit."
                )));
            }
            seen_barcodes.push(value.clone());
            assert_barcode_available(pool, value, current_product_id).await?;
        }
        units.push(ProductUnitInput {
            unit_id,
            conversion_to_base,
            wholesale_price_xof: wholesale,
            retail_price_xof: retail,
            barcode: unit_barcode,
            is_default_sale_unit: json::opt_bool(&unit, "isDefaultSaleUnit").unwrap_or(false),
        });
    }

    // Garantit la présence de l'unité de base (conversion = 1) et d'un défaut.
    if !seen_units.contains(&base_unit_id) {
        let any_default = units.iter().any(|u| u.is_default_sale_unit);
        units.insert(
            0,
            ProductUnitInput {
                unit_id: base_unit_id.clone(),
                conversion_to_base: 1,
                wholesale_price_xof: wholesale_price_xof,
                retail_price_xof: retail_price_xof,
                barcode: None,
                is_default_sale_unit: !any_default,
            },
        );
    } else if !units.iter().any(|u| u.is_default_sale_unit) {
        if let Some(first) = units.first_mut() {
            first.is_default_sale_unit = true;
        }
    }

    Ok(ProductInput {
        sku,
        barcode,
        name,
        category_id,
        brand_id,
        preferred_supplier_id,
        format_label,
        base_unit_id,
        bottle_packaging_type_id,
        crate_packaging_type_id,
        purchase_price_xof,
        wholesale_price_xof,
        retail_price_xof,
        alert_threshold_base,
        units,
    })
}

fn packaging_type_id(product: &ProductInput) -> Option<String> {
    product
        .crate_packaging_type_id
        .clone()
        .or_else(|| product.bottle_packaging_type_id.clone())
}

pub async fn create_product(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let product = validate_product(pool, input, None).await?;
    let product_id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO products (
               id, sku, barcode, name, category_id, brand_id, preferred_supplier_id, format_label,
               base_unit_id, packaging_type_id, bottle_packaging_type_id, crate_packaging_type_id,
               purchase_price_xof, weighted_avg_cost_xof, wholesale_price_xof, retail_price_xof,
               alert_threshold_base, is_active
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(&product_id)
        .bind(&product.sku)
        .bind(&product.barcode)
        .bind(&product.name)
        .bind(&product.category_id)
        .bind(&product.brand_id)
        .bind(&product.preferred_supplier_id)
        .bind(&product.format_label)
        .bind(&product.base_unit_id)
        .bind(packaging_type_id(&product))
        .bind(&product.bottle_packaging_type_id)
        .bind(&product.crate_packaging_type_id)
        .bind(product.purchase_price_xof)
        .bind(product.purchase_price_xof)
        .bind(product.wholesale_price_xof)
        .bind(product.retail_price_xof)
        .bind(product.alert_threshold_base)
        .execute(&mut *tx)
        .await?;

        for unit in &product.units {
            insert_product_unit(&mut *tx, &product_id, unit).await?;
        }

        sqlx::query(
            "INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base)
             VALUES (?, 0, 0)",
        )
        .bind(&product_id)
        .execute(&mut *tx)
        .await?;

        audit(
            &mut *tx,
            actor_user_id,
            "PRODUCT_CREATED",
            "products",
            &product_id,
            &json!({ "sku": product.sku, "name": product.name, "unitsCount": product.units.len() }),
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
    get_product(pool, &product_id).await
}

async fn insert_product_unit(
    tx: &mut sqlx::sqlite::SqliteConnection,
    product_id: &str,
    unit: &ProductUnitInput,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO product_units (
           id, product_id, unit_id, conversion_to_base, wholesale_price_xof,
           retail_price_xof, barcode, is_default_sale_unit
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(json::new_id())
    .bind(product_id)
    .bind(&unit.unit_id)
    .bind(unit.conversion_to_base)
    .bind(unit.wholesale_price_xof)
    .bind(unit.retail_price_xof)
    .bind(&unit.barcode)
    .bind(if unit.is_default_sale_unit { 1_i64 } else { 0_i64 })
    .execute(tx)
    .await?;
    Ok(())
}

pub async fn update_product(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let product_id = json::id_field(input)?;
    if !exists_pool(pool, "SELECT id FROM products WHERE id = ?", &product_id).await? {
        return Err(common::not_found("Produit introuvable."));
    }
    let product = validate_product(pool, input, Some(&product_id)).await?;
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE products
             SET sku = ?, barcode = ?, name = ?, category_id = ?, brand_id = ?,
                 preferred_supplier_id = ?, format_label = ?, base_unit_id = ?,
                 packaging_type_id = ?, bottle_packaging_type_id = ?, crate_packaging_type_id = ?,
                 purchase_price_xof = ?, wholesale_price_xof = ?, retail_price_xof = ?,
                 alert_threshold_base = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?",
        )
        .bind(&product.sku)
        .bind(&product.barcode)
        .bind(&product.name)
        .bind(&product.category_id)
        .bind(&product.brand_id)
        .bind(&product.preferred_supplier_id)
        .bind(&product.format_label)
        .bind(&product.base_unit_id)
        .bind(packaging_type_id(&product))
        .bind(&product.bottle_packaging_type_id)
        .bind(&product.crate_packaging_type_id)
        .bind(product.purchase_price_xof)
        .bind(product.wholesale_price_xof)
        .bind(product.retail_price_xof)
        .bind(product.alert_threshold_base)
        .bind(&product_id)
        .execute(&mut *tx)
        .await?;

        // Mise à jour sûre des conditionnements : on conserve les identifiants
        // existants pour ne pas casser les références (commandes, ventes…).
        let existing: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, unit_id FROM product_units WHERE product_id = ?",
        )
        .bind(&product_id)
        .fetch_all(&mut *tx)
        .await?;
        for (row_id, unit_id) in &existing {
            if !product.units.iter().any(|u| &u.unit_id == unit_id) {
                sqlx::query("DELETE FROM product_units WHERE id = ?")
                    .bind(row_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        for unit in &product.units {
            let existing_id = existing
                .iter()
                .find(|(_, unit_id)| unit_id == &unit.unit_id)
                .map(|(id, _)| id.clone());
            match existing_id {
                Some(id) => {
                    sqlx::query(
                        "UPDATE product_units
                         SET conversion_to_base = ?, wholesale_price_xof = ?, retail_price_xof = ?,
                             barcode = ?, is_default_sale_unit = ?
                         WHERE id = ?",
                    )
                    .bind(unit.conversion_to_base)
                    .bind(unit.wholesale_price_xof)
                    .bind(unit.retail_price_xof)
                    .bind(&unit.barcode)
                    .bind(if unit.is_default_sale_unit { 1_i64 } else { 0_i64 })
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                }
                None => insert_product_unit(&mut *tx, &product_id, unit).await?,
            }
        }

        audit(
            &mut *tx,
            actor_user_id,
            "PRODUCT_UPDATED",
            "products",
            &product_id,
            &json!({ "sku": product.sku, "name": product.name }),
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
    get_product(pool, &product_id).await
}

pub async fn toggle_product_active(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let product_id = json::id_field(input)?;
    let is_active = json::bool_field(input, "isActive")
        .map_err(|_| common::validation("Statut invalide (isActive attendu)"))?;
    let mut tx = pool.begin().await?;
    if !exists(&mut *tx, "SELECT id FROM products WHERE id = ?", &product_id).await? {
        let _ = tx.rollback().await;
        return Err(common::not_found("Produit introuvable."));
    }
    let result = async {
        sqlx::query(
            "UPDATE products SET is_active = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?",
        )
        .bind(if is_active { 1_i64 } else { 0_i64 })
        .bind(&product_id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            if is_active { "PRODUCT_RESTORED" } else { "PRODUCT_ARCHIVED" },
            "products",
            &product_id,
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
    get_product(pool, &product_id).await
}

fn find_or_fail(rows: &Json, key: &str, id: &str) -> Result<Json, AppError> {
    find(rows, key, id)
        .cloned()
        .ok_or_else(|| common::conflict("Entité créée mais introuvable lors de la relecture."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_emballage_identique_au_schema_zod() {
        let ok = serde_json::json!({
            "code": "casier_24", "name": "Casier 24", "kind": "CRATE",
            "depositAmountXof": 1500
        });
        let (code, name, kind, deposit) = validate_packaging(&ok, true).unwrap();
        assert_eq!(code.unwrap(), "CASIER_24");
        assert_eq!(name, "Casier 24");
        assert_eq!(kind, "CRATE");
        assert_eq!(deposit, 1500);

        let bad_code = serde_json::json!({
            "code": "casier 24", "name": "Casier", "kind": "CRATE", "depositAmountXof": 0
        });
        assert!(validate_packaging(&bad_code, true).is_err());
        let bad_kind = serde_json::json!({
            "code": "C24", "name": "Casier", "kind": "INCONNU", "depositAmountXof": 0
        });
        assert!(validate_packaging(&bad_kind, true).is_err());
        let negatif = serde_json::json!({
            "code": "C24", "name": "Casier", "kind": "CRATE", "depositAmountXof": -1
        });
        assert!(validate_packaging(&negatif, true).is_err());
    }
}
