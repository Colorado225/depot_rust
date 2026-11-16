//! LOT 10 — Tranche 2, Stocks : port de `server/repositories/stockRepo.ts`.
//!
//! Règles métier exécutées CÔTÉ RUST : conversion des conditionnements,
//! interdiction des stocks négatifs par défaut (`allow_negative_stock`),
//! CUMP entier FCFA, casse tracée séparément, inventaire atomique avec
//! écriture du journal `stock_movements` et audit.

use crate::domain::cump::{base_unit_cost_xof, compute_weighted_avg_cost_xof};
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{self, attach, audit, find, like, mul_qty, mul_xof, not_found, validation};
use serde_json::{json, Value};
use sqlx::SqlitePool;

const MOVEMENT_TYPES: &[&str] = &["INITIAL", "MANUAL_IN", "MANUAL_OUT", "BREAKAGE", "LOSS"];

pub async fn list_balances(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let search = like(input, "search");
    let only_low_stock = json::opt_bool(input, "onlyLowStock").unwrap_or(false);
    let rows = sqlx::query(
        "SELECT p.id AS product_id, p.sku, p.name, c.name AS category_name,
                p.base_unit_id, u.name AS base_unit_name,
                COALESCE(sb.quantity_base, 0) AS quantity_base,
                COALESCE(sb.damaged_quantity_base, 0) AS damaged_quantity_base,
                p.alert_threshold_base, p.weighted_avg_cost_xof,
                COALESCE(sb.updated_at, p.updated_at) AS updated_at
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         JOIN units u ON u.id = p.base_unit_id
         LEFT JOIN stock_balances sb ON sb.product_id = p.id
         WHERE p.is_active = 1
           AND (? IS NULL OR (LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ?
                              OR LOWER(COALESCE(p.barcode, '')) LIKE ?))
           AND (? IS NULL OR COALESCE(sb.quantity_base, 0) <= p.alert_threshold_base)
         ORDER BY p.name ASC",
    )
    .bind(search.clone())
    .bind(search.clone())
    .bind(search.clone())
    .bind(search)
    .bind(if only_low_stock { Some(1_i64) } else { None::<i64> })
    .fetch_all(pool)
    .await?;

    // La valorisation reste en arithmétique XOF entière CONTRÔLÉE (pas une
    // multiplication SQL qui pourrait déborder en REAL) : cf. money.ts.
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let dto = json::row_to_json(row, &[]);
        let quantity = dto.get("quantityBase").and_then(Value::as_i64).unwrap_or(0);
        let threshold = dto.get("alertThresholdBase").and_then(Value::as_i64).unwrap_or(0);
        let cost = dto.get("weightedAvgCostXof").and_then(Value::as_i64).unwrap_or(0);
        let dto = attach(dto, "isLowStock", json!(quantity <= threshold));
        let dto = attach(dto, "totalValuationXof", json!(mul_xof(cost, quantity, "Valorisation")?));
        out.push(dto);
    }
    Ok(Value::Array(out))
}

async fn list_movements_query(
    pool: &SqlitePool,
    product_id: Option<String>,
    movement_type: Option<String>,
    limit: i64,
) -> Result<Json, AppError> {
    let limit = limit.clamp(1, 300);
    let rows = sqlx::query(
        "SELECT sm.id, sm.product_id, p.sku AS product_sku, p.name AS product_name,
                u.name AS base_unit_name, sm.movement_type, sm.quantity_delta_base,
                sm.unit_cost_xof, sm.balance_after_base, sm.reference_type,
                sm.reference_id, sm.note, sm.user_id,
                COALESCE(e.full_name, usr.username) AS user_name, sm.created_at
         FROM stock_movements sm
         JOIN products p ON p.id = sm.product_id
         JOIN units u ON u.id = p.base_unit_id
         JOIN users usr ON usr.id = sm.user_id
         LEFT JOIN employees e ON e.id = usr.employee_id
         WHERE (? IS NULL OR sm.product_id = ?)
           AND (? IS NULL OR sm.movement_type = ?)
         ORDER BY sm.created_at DESC, sm.rowid DESC
         LIMIT ?",
    )
    .bind(product_id.clone())
    .bind(product_id)
    .bind(movement_type.clone())
    .bind(movement_type)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

pub async fn list_movements(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_movements_query(
        pool,
        json::opt_str(input, "productId"),
        json::opt_str(input, "movementType"),
        json::opt_i64(input, "limit").unwrap_or(100),
    )
    .await
}

pub async fn record_movement(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let product_id = json::text_field(input, "productId", 1, 80, "Produit")?;
    let unit_id = json::text_field(input, "unitId", 1, 80, "Unité")?;
    let quantity = json::positive_i64(input, "quantity", "Quantité")?;
    let movement_type = json::enum_field(input, "movementType", MOVEMENT_TYPES)?;
    let unit_cost_xof = match input.get("unitCostXof") {
        None => None,
        Some(_) => Some(json::non_negative_i64(input, "unitCostXof", "Coût unitaire")?),
    };
    let note = json::optional_text(input, "note", 240, "Note")?;

    let movement_id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        // Produit actif + solde courant (lecture dans la transaction).
        let product: Option<(String, String, i64, i64, i64, i64)> = sqlx::query_as(
            "SELECT p.id, p.name, p.weighted_avg_cost_xof, p.is_active,
                    COALESCE(sb.quantity_base, 0),
                    COALESCE(sb.damaged_quantity_base, 0)
             FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id
             WHERE p.id = ?",
        )
        .bind(&product_id)
        .fetch_optional(&mut *tx)
        .await?;
        let (id, product_name, current_cump, is_active, quantity_base, damaged_base) =
            product.ok_or_else(|| not_found("Produit actif introuvable."))?;
        if is_active != 1 {
            return Err(not_found("Produit actif introuvable."));
        }

        let conversion: Option<(i64,)> = sqlx::query_as(
            "SELECT conversion_to_base FROM product_units WHERE product_id = ? AND unit_id = ?",
        )
        .bind(&product_id)
        .bind(&unit_id)
        .fetch_optional(&mut *tx)
        .await?;
        let conversion = conversion
            .map(|row| row.0)
            .ok_or_else(|| validation("Cette unité n'est pas configurée pour ce produit."))?;

        let base_qty = mul_qty(quantity, conversion, "Quantité convertie")?;
        let is_incoming = movement_type == "INITIAL" || movement_type == "MANUAL_IN";
        let delta_base = if is_incoming { base_qty } else { -base_qty };
        let next_qty_base = quantity_base
            .checked_add(delta_base)
            .ok_or_else(|| validation("Dépassement arithmétique (quantité)"))?;

        let settings: Option<(i64,)> = sqlx::query_as(
            "SELECT allow_negative_stock FROM business_settings LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let allow_negative = settings.map(|row| row.0 == 1).unwrap_or(false);
        if !allow_negative && next_qty_base < 0 {
            return Err(common::insufficient_stock(format!(
                "Stock insuffisant pour « {product_name} » : disponible {quantity_base}, demandé {base_qty}."
            )));
        }

        let mut movement_unit_cost_xof = current_cump;
        let mut next_cump_xof = current_cump;
        if is_incoming {
            // Coût saisi pour l'unité choisie, ramené à l'unité de base.
            let provided = match unit_cost_xof {
                Some(cost) => cost,
                None => mul_xof(current_cump, conversion, "Coût unitaire implicite")?,
            };
            movement_unit_cost_xof = base_unit_cost_xof(provided, conversion)?;
            next_cump_xof = compute_weighted_avg_cost_xof(
                quantity_base,
                current_cump,
                base_qty,
                movement_unit_cost_xof,
            )?;
        }

        // Les marchandises cassées ne sont plus revendables.
        let next_damaged_base = if movement_type == "BREAKAGE" {
            damaged_base
                .checked_add(base_qty)
                .ok_or_else(|| validation("Dépassement arithmétique (casse)"))?
        } else {
            damaged_base
        };

        sqlx::query(
            "INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
             VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(product_id) DO UPDATE SET
               quantity_base = excluded.quantity_base,
               damaged_quantity_base = excluded.damaged_quantity_base,
               updated_at = excluded.updated_at",
        )
        .bind(&id)
        .bind(next_qty_base)
        .bind(next_damaged_base)
        .execute(&mut *tx)
        .await?;

        if is_incoming && next_cump_xof != current_cump {
            sqlx::query(
                "UPDATE products SET weighted_avg_cost_xof = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     sync_version = sync_version + 1 WHERE id = ?",
            )
            .bind(next_cump_xof)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            "INSERT INTO stock_movements (
               id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
               balance_after_base, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, ?, ?, ?, ?, 'MANUAL_STOCK', ?, ?, ?)",
        )
        .bind(&movement_id)
        .bind(&id)
        .bind(&movement_type)
        .bind(delta_base)
        .bind(movement_unit_cost_xof)
        .bind(next_qty_base)
        .bind(&movement_id)
        .bind(&note)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;

        audit(
            &mut *tx,
            actor_user_id,
            "STOCK_MOVEMENT_RECORDED",
            "stock_movements",
            &movement_id,
            &json!({
                "productId": id, "movementType": movement_type, "deltaBase": delta_base,
                "balanceAfterBase": next_qty_base, "newCumpXof": next_cump_xof
            }),
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
    let rows = list_movements_query(pool, Some(product_id), None, 20).await?;
    find(&rows, "id", &movement_id)
        .cloned()
        .ok_or_else(|| common::conflict("Mouvement enregistré mais introuvable à la relecture."))
}

pub async fn list_inventories(pool: &SqlitePool) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT si.id, si.inventory_number, si.status, si.note,
                (SELECT COUNT(*) FROM stock_inventory_lines sil WHERE sil.inventory_id = si.id) AS lines_count,
                COALESCE((SELECT SUM(sil.variance_base) FROM stock_inventory_lines sil
                          WHERE sil.inventory_id = si.id), 0) AS total_variance_base,
                COALESCE(ec.full_name, uc.username) AS created_by_name,
                COALESCE(ev.full_name, uv.username) AS validated_by_name,
                si.validated_at, si.created_at
         FROM stock_inventories si
         JOIN users uc ON uc.id = si.created_by_user_id
         LEFT JOIN employees ec ON ec.id = uc.employee_id
         LEFT JOIN users uv ON uv.id = si.validated_by_user_id
         LEFT JOIN employees ev ON ev.id = uv.employee_id
         ORDER BY si.created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

struct InventoryLine {
    product_id: String,
    counted_base: i64,
}

pub async fn validate_inventory(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let raw_lines = json::array_field(input, "lines", 1, "Lignes de comptage")?;
    let note = json::optional_text(input, "note", 240, "Note")?;
    let mut lines: Vec<InventoryLine> = Vec::with_capacity(raw_lines.len());
    let mut seen: Vec<String> = Vec::new();
    for line in raw_lines {
        let product_id = json::text_field(&line, "productId", 1, 80, "Produit compté")?;
        if seen.contains(&product_id) {
            return Err(validation("Produit en double dans le comptage inventaire."));
        }
        seen.push(product_id.clone());
        let counted_base = json::non_negative_i64(&line, "countedBase", "Quantité comptée")?;
        lines.push(InventoryLine { product_id, counted_base });
    }

    let inventory_id = json::new_id();
    let inv_number = format!(
        "INV-{:08}",
        chrono::Utc::now().timestamp_millis().rem_euclid(100_000_000)
    );
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO stock_inventories (
               id, inventory_number, status, note, created_by_user_id,
               validated_by_user_id, validated_at
             ) VALUES (?, ?, 'VALIDATED', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        )
        .bind(&inventory_id)
        .bind(&inv_number)
        .bind(&note)
        .bind(actor_user_id)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;

        for line in &lines {
            let product: Option<(String, i64, i64)> = sqlx::query_as(
                "SELECT p.id, p.weighted_avg_cost_xof, COALESCE(sb.quantity_base, 0)
                 FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id
                 WHERE p.id = ?",
            )
            .bind(&line.product_id)
            .fetch_optional(&mut *tx)
            .await?;
            let (id, unit_cost_xof, theoretical_base) = product.ok_or_else(|| {
                not_found(format!(
                    "Produit introuvable dans l'inventaire ({}).",
                    line.product_id
                ))
            })?;
            let variance_base = line
                .counted_base
                .checked_sub(theoretical_base)
                .ok_or_else(|| validation("Dépassement arithmétique (variance)"))?;

            sqlx::query(
                "INSERT INTO stock_inventory_lines (
                   id, inventory_id, product_id, theoretical_base, counted_base,
                   variance_base, unit_cost_xof
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(&inventory_id)
            .bind(&id)
            .bind(theoretical_base)
            .bind(line.counted_base)
            .bind(variance_base)
            .bind(unit_cost_xof)
            .execute(&mut *tx)
            .await?;

            if variance_base != 0 {
                sqlx::query(
                    "INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
                     VALUES (?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                     ON CONFLICT(product_id) DO UPDATE SET
                       quantity_base = excluded.quantity_base,
                       updated_at = excluded.updated_at",
                )
                .bind(&id)
                .bind(line.counted_base)
                .execute(&mut *tx)
                .await?;

                let movement_note = note
                    .clone()
                    .unwrap_or_else(|| format!("Inventaire {inv_number}"));
                sqlx::query(
                    "INSERT INTO stock_movements (
                       id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
                       balance_after_base, reference_type, reference_id, note, user_id
                     ) VALUES (?, ?, 'INVENTORY_ADJUSTMENT', ?, ?, ?, 'STOCK_INVENTORY', ?, ?, ?)",
                )
                .bind(json::new_id())
                .bind(&id)
                .bind(variance_base)
                .bind(unit_cost_xof)
                .bind(line.counted_base)
                .bind(&inventory_id)
                .bind(movement_note)
                .bind(actor_user_id)
                .execute(&mut *tx)
                .await?;
            }
        }

        audit(
            &mut *tx,
            actor_user_id,
            "INVENTORY_VALIDATED",
            "stock_inventories",
            &inventory_id,
            &json!({ "inventoryNumber": inv_number, "linesCount": lines.len() }),
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
    let rows = list_inventories(pool).await?;
    find(&rows, "id", &inventory_id)
        .cloned()
        .ok_or_else(|| common::conflict("Inventaire validé mais introuvable à la relecture."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_de_mouvements_manuels_autorises() {
        assert!(MOVEMENT_TYPES.contains(&"BREAKAGE"));
        assert!(!MOVEMENT_TYPES.contains(&"PURCHASE_RECEIPT"));
    }

    #[test]
    fn limite_du_journal_bornee() {
        let input = serde_json::json!({ "limit": 5000 });
        assert_eq!(json::opt_i64(&input, "limit").unwrap_or(100).clamp(1, 300), 300);
        let input = serde_json::json!({ "limit": 0 });
        assert_eq!(json::opt_i64(&input, "limit").unwrap_or(100).clamp(1, 300), 1);
    }

    #[test]
    fn filtre_like_reste_insensible_a_la_casse() {
        let input = serde_json::json!({ "search": " BIÈRE " });
        assert_eq!(like(&input, "search").unwrap(), "%bière%");
    }
}
