//! LOT 10 — Tranche 2, Achats & réceptions : port de
//! `server/repositories/purchaseRepo.ts` (1 323 lignes TypeScript).
//!
//! Toutes les règles critiques sont exécutées ici : statut des bons, reliquats
//! de réception, CUMP entier FCFA, dette fournisseur recomputée, allocation
//! FIFO des règlements, contrôle du stock avant retour fournisseur, et
//! mouvements de caisse pour les paiements en espèces. Chaque flux est
//! atomique (transaction SQLx + rollback) et audité.

use crate::domain::cump::{base_unit_cost_xof, compute_weighted_avg_cost_xof};
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{
    self, add_xof, attach, audit, doc_number, find, like, mul_qty, mul_xof, not_found,
    conflict, validation,
};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnection;
use sqlx::{Row, SqlitePool};
use std::collections::{HashMap, HashSet};

const PAYMENT_METHODS: &[&str] = &[
    "CASH", "ORANGE_MONEY", "MTN_MOMO", "MOOV_MONEY", "WAVE", "BANK_TRANSFER",
];

struct OrderItemRow {
    id: String,
    product_id: String,
    product_name: String,
    ordered_qty: i64,
    received_qty: i64,
    conversion_to_base: i64,
    unit_cost_xof: i64,
}

struct ReceiptLine {
    id: String,
    purchase_item_id: String,
    product_id: String,
    received_qty: i64,
    base_qty: i64,
    unit_cost_xof: i64,
    base_unit_cost_xof: i64,
}

/// Dette fournisseur = somme des montants réceptionnés non réglés, hors annulés.
async fn recompute_supplier_balance_due(
    tx: &mut SqliteConnection,
    supplier_id: &str,
) -> Result<i64, AppError> {
    let due: (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(MAX(0, received_amount_xof - paid_amount_xof)), 0)
         FROM purchase_orders WHERE supplier_id = ? AND status != 'CANCELLED'",
    )
    .bind(supplier_id)
    .fetch_one(tx)
    .await?;
    let due_xof = due.0.max(0);
    sqlx::query(
        "UPDATE suppliers SET balance_due_xof = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             sync_version = sync_version + 1 WHERE id = ?",
    )
    .bind(due_xof)
    .bind(supplier_id)
    .execute(tx)
    .await?;
    Ok(due_xof)
}

// ---------------------------------------------------------------------------
// Bons de commande
// ---------------------------------------------------------------------------

async fn list_orders_query(
    pool: &SqlitePool,
    search: Option<String>,
    supplier_id: Option<String>,
    status: Option<String>,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT po.id, po.order_number, po.supplier_id, s.name AS supplier_name,
                po.status, po.total_amount_xof, po.received_amount_xof,
                po.paid_amount_xof, po.note, po.user_id,
                COALESCE(e.full_name, u.username) AS user_name,
                po.ordered_at, po.created_at, po.updated_at,
                (SELECT COUNT(*) FROM goods_receipts gr
                 WHERE gr.purchase_order_id = po.id) AS receipts_count
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
         JOIN users u ON u.id = po.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE (? IS NULL OR po.supplier_id = ?)
           AND (? IS NULL OR po.status = ?)
           AND (? IS NULL OR (LOWER(po.order_number) LIKE ? OR LOWER(s.name) LIKE ?
                              OR LOWER(COALESCE(po.note, '')) LIKE ?))
         ORDER BY po.created_at DESC, po.rowid DESC",
    )
    .bind(supplier_id.clone())
    .bind(supplier_id)
    .bind(status.clone())
    .bind(status)
    .bind(search.clone())
    .bind(search.clone())
    .bind(search.clone())
    .bind(search)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let order_id: String = row.try_get("id")?;
        let mut dto = json::row_to_json(row, &[]);
        let received = dto.get("receivedAmountXof").and_then(Value::as_i64).unwrap_or(0);
        let paid = dto.get("paidAmountXof").and_then(Value::as_i64).unwrap_or(0);
        let total = dto.get("totalAmountXof").and_then(Value::as_i64).unwrap_or(0);
        dto = attach(dto, "remainingToPayOnReceivedXof", json!((received - paid).max(0)));
        dto = attach(dto, "remainingToPayOnOrderXof", json!((total - paid).max(0)));
        let items = sqlx::query(
            "SELECT pi.id, pi.purchase_order_id, pi.product_id, p.sku AS product_sku,
                    p.name AS product_name, pi.unit_id, un.name AS unit_name,
                    bu.name AS base_unit_name, pi.ordered_qty, pi.received_qty,
                    (pi.ordered_qty - pi.received_qty) AS remaining_qty,
                    pi.conversion_to_base, pi.unit_cost_xof, pi.line_total_xof
             FROM purchase_items pi
             JOIN products p ON p.id = pi.product_id
             JOIN units un ON un.id = pi.unit_id
             JOIN units bu ON bu.id = p.base_unit_id
             WHERE pi.purchase_order_id = ? ORDER BY p.name ASC",
        )
        .bind(&order_id)
        .fetch_all(pool)
        .await?;
        dto = attach(dto, "items", json::rows_to_json(items, &[]));
        out.push(dto);
    }
    Ok(Value::Array(out))
}

pub async fn list_orders(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_orders_query(
        pool,
        like(input, "search"),
        json::opt_str(input, "supplierId"),
        json::opt_str(input, "status"),
    )
    .await
}

async fn get_order(pool: &SqlitePool, order_id: &str) -> Result<Json, AppError> {
    let rows = list_orders_query(pool, None, None, None).await?;
    find(&rows, "id", order_id)
        .cloned()
        .ok_or_else(|| not_found("Bon d'achat introuvable."))
}

struct PreparedOrderItem {
    id: String,
    product_id: String,
    unit_id: String,
    ordered_qty: i64,
    conversion_to_base: i64,
    unit_cost_xof: i64,
    line_total_xof: i64,
}

pub async fn create_order(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let supplier_id = json::text_field(input, "supplierId", 1, 80, "Fournisseur")?;
    let note = json::optional_text(input, "note", 300, "Note")?;
    let validate_immediately = json::opt_bool(input, "validateImmediately").unwrap_or(false);
    let raw_items = json::array_field(input, "items", 1, "Lignes de commande")?;

    let supplier: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT id, name, is_active FROM suppliers WHERE id = ?",
    )
    .bind(&supplier_id)
    .fetch_optional(pool)
    .await?;
    let supplier = supplier.filter(|row| row.2 == 1).ok_or_else(|| {
        not_found("Fournisseur actif introuvable.")
    })?;

    let mut seen_pairs: HashSet<String> = HashSet::new();
    let mut prepared: Vec<PreparedOrderItem> = Vec::with_capacity(raw_items.len());
    let mut total_amount_xof = 0_i64;

    for item in raw_items {
        let product_id = json::text_field(&item, "productId", 1, 80, "Produit")?;
        let unit_id = json::text_field(&item, "unitId", 1, 80, "Unité")?;
        let pair_key = format!("{product_id}::{unit_id}");
        if !seen_pairs.insert(pair_key) {
            return Err(validation(
                "Un même produit avec la même unité ne peut pas apparaître deux fois sur la commande.",
            ));
        }
        let ordered_qty = json::positive_i64(&item, "orderedQty", "Quantité commandée")?;
        let unit_cost_xof = json::non_negative_i64(&item, "unitCostXof", "Coût d'achat unitaire")?;

        let product: Option<(String, String, i64)> = sqlx::query_as(
            "SELECT id, name, is_active FROM products WHERE id = ?",
        )
        .bind(&product_id)
        .fetch_optional(pool)
        .await?;
        let product = product.filter(|row| row.2 == 1).ok_or_else(|| {
            not_found("Produit actif introuvable dans la commande.")
        })?;

        let conversion: Option<(i64,)> = sqlx::query_as(
            "SELECT conversion_to_base FROM product_units WHERE product_id = ? AND unit_id = ?",
        )
        .bind(&product_id)
        .bind(&unit_id)
        .fetch_optional(pool)
        .await?;
        let conversion_to_base = conversion.map(|row| row.0).ok_or_else(|| {
            validation(format!(
                "L'unité sélectionnée n'est pas configurée pour « {} ».",
                product.1
            ))
        })?;

        let line_total_xof = mul_xof(unit_cost_xof, ordered_qty, "Ligne de commande")?;
        total_amount_xof = add_xof(total_amount_xof, line_total_xof, "Montant total commande")?;
        prepared.push(PreparedOrderItem {
            id: json::new_id(),
            product_id,
            unit_id,
            ordered_qty,
            conversion_to_base,
            unit_cost_xof,
            line_total_xof,
        });
    }

    let order_id = json::new_id();
    let order_number = doc_number("BC");
    let status = if validate_immediately { "VALIDATED" } else { "DRAFT" };
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO purchase_orders (
               id, order_number, supplier_id, status, total_amount_xof,
               received_amount_xof, paid_amount_xof, note, user_id
             ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)",
        )
        .bind(&order_id)
        .bind(&order_number)
        .bind(&supplier.0)
        .bind(status)
        .bind(total_amount_xof)
        .bind(&note)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;
        for line in &prepared {
            sqlx::query(
                "INSERT INTO purchase_items (
                   id, purchase_order_id, product_id, unit_id, ordered_qty, received_qty,
                   conversion_to_base, unit_cost_xof, line_total_xof
                 ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
            )
            .bind(&line.id)
            .bind(&order_id)
            .bind(&line.product_id)
            .bind(&line.unit_id)
            .bind(line.ordered_qty)
            .bind(line.conversion_to_base)
            .bind(line.unit_cost_xof)
            .bind(line.line_total_xof)
            .execute(&mut *tx)
            .await?;
        }
        audit(
            &mut *tx,
            actor_user_id,
            "PURCHASE_ORDER_CREATED",
            "purchase_orders",
            &order_id,
            &json!({
                "orderNumber": order_number, "supplierId": supplier.0,
                "status": status, "totalAmountXof": total_amount_xof
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
    get_order(pool, &order_id).await
}

pub async fn validate_order(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let order_id = json::id_field(input)?;
    let order: Option<(String, String, String)> = sqlx::query_as(
        "SELECT id, order_number, status FROM purchase_orders WHERE id = ?",
    )
    .bind(&order_id)
    .fetch_optional(pool)
    .await?;
    let order = order.ok_or_else(|| not_found("Bon d'achat introuvable."))?;
    if order.2 != "DRAFT" {
        return Err(conflict(format!(
            "Seul un brouillon peut être validé (statut actuel : {}).",
            order.2
        )));
    }
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE purchase_orders SET status = 'VALIDATED',
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?",
        )
        .bind(&order_id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "PURCHASE_ORDER_VALIDATED",
            "purchase_orders",
            &order_id,
            &json!({ "orderNumber": order.1 }),
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
    get_order(pool, &order_id).await
}

pub async fn cancel_order(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let order_id = json::id_field(input)?;
    let reason = json::optional_text(input, "reason", 240, "Motif")?;
    let order: Option<(String, String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, order_number, supplier_id, status, received_amount_xof, paid_amount_xof
         FROM purchase_orders WHERE id = ?",
    )
    .bind(&order_id)
    .fetch_optional(pool)
    .await?;
    let order = order.ok_or_else(|| not_found("Bon d'achat introuvable."))?;
    if order.3 == "CANCELLED" {
        return Err(conflict("Cette commande est déjà annulée."));
    }
    if order.4 > 0 || order.5 > 0 {
        return Err(conflict(
            "Impossible d'annuler une commande ayant déjà fait l'objet d'une réception ou d'un règlement.",
        ));
    }

    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE purchase_orders SET status = 'CANCELLED',
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?",
        )
        .bind(&order_id)
        .execute(&mut *tx)
        .await?;
        recompute_supplier_balance_due(&mut *tx, &order.2).await?;
        audit(
            &mut *tx,
            actor_user_id,
            "PURCHASE_ORDER_CANCELLED",
            "purchase_orders",
            &order_id,
            &json!({ "orderNumber": order.1, "reason": reason }),
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
    get_order(pool, &order_id).await
}

// ---------------------------------------------------------------------------
// Réceptions (stock + CUMP + dette fournisseur)
// ---------------------------------------------------------------------------

pub async fn receive_order(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let order_id = json::id_field(input)?;
    let note = json::optional_text(input, "note", 300, "Note")?;
    let supplier_invoice_ref = json::optional_text(input, "supplierInvoiceRef", 80, "Référence facture")?;
    let raw_items = json::array_field(input, "items", 1, "Lignes de réception")?;

    let mut active_lines: Vec<(String, i64)> = Vec::new();
    for item in raw_items {
        let purchase_item_id = json::text_field(&item, "purchaseItemId", 1, 80, "Ligne de commande")?;
        let received_qty = json::non_negative_i64(&item, "receivedQty", "Quantité reçue")?;
        if received_qty > 0 {
            active_lines.push((purchase_item_id, received_qty));
        }
    }
    if active_lines.is_empty() {
        return Err(validation("Saisissez au moins une quantité reçue strictement positive."));
    }

    let receipt_id = json::new_id();
    let receipt_number = doc_number("REC");
    let mut tx = pool.begin().await?;
    let result = async {
        let order: Option<(String, String, String, String, i64)> = sqlx::query_as(
            "SELECT id, order_number, supplier_id, status, received_amount_xof
             FROM purchase_orders WHERE id = ?",
        )
        .bind(&order_id)
        .fetch_optional(&mut *tx)
        .await?;
        let order = order.ok_or_else(|| not_found("Bon d'achat introuvable."))?;
        if order.3 != "VALIDATED" && order.3 != "PARTIAL_RECEIVED" {
            return Err(conflict(format!(
                "Cette commande ne peut pas être réceptionnée (statut actuel : {}).",
                order.3
            )));
        }

        let item_rows: Vec<(String, String, String, i64, i64, i64, i64)> = sqlx::query_as(
            "SELECT pi.id, pi.product_id, p.name, pi.ordered_qty, pi.received_qty,
                    pi.conversion_to_base, pi.unit_cost_xof
             FROM purchase_items pi JOIN products p ON p.id = pi.product_id
             WHERE pi.purchase_order_id = ?",
        )
        .bind(&order_id)
        .fetch_all(&mut *tx)
        .await?;
        let mut item_by_id: HashMap<String, OrderItemRow> = HashMap::new();
        for row in item_rows {
            item_by_id.insert(
                row.0.clone(),
                OrderItemRow {
                    id: row.0,
                    product_id: row.1,
                    product_name: row.2,
                    ordered_qty: row.3,
                    received_qty: row.4,
                    conversion_to_base: row.5,
                    unit_cost_xof: row.6,
                },
            );
        }

        let mut seen_line_ids: HashSet<String> = HashSet::new();
        let mut total_received_xof = 0_i64;
        let mut receipt_lines: Vec<ReceiptLine> = Vec::new();
        for (purchase_item_id, received_qty) in &active_lines {
            if !seen_line_ids.insert(purchase_item_id.clone()) {
                return Err(validation("Ligne dupliquée dans le bon de réception."));
            }
            let po_item = item_by_id.get(purchase_item_id).ok_or_else(|| {
                not_found(format!("Ligne de commande introuvable ({purchase_item_id})."))
            })?;
            let remaining = po_item.ordered_qty - po_item.received_qty;
            if *received_qty > remaining {
                return Err(validation(format!(
                    "Quantité reçue ({received_qty}) supérieure au reliquat ({remaining}) pour « {} ».",
                    po_item.product_name
                )));
            }
            let base_qty = mul_qty(*received_qty, po_item.conversion_to_base, "Quantité reçue")?;
            let line_received_xof = mul_xof(po_item.unit_cost_xof, *received_qty, "Réception")?;
            total_received_xof = add_xof(total_received_xof, line_received_xof, "Total réceptionné")?;
            let base_unit_cost = base_unit_cost_xof(po_item.unit_cost_xof, po_item.conversion_to_base)?;
            receipt_lines.push(ReceiptLine {
                id: json::new_id(),
                purchase_item_id: po_item.id.clone(),
                product_id: po_item.product_id.clone(),
                received_qty: *received_qty,
                base_qty,
                unit_cost_xof: po_item.unit_cost_xof,
                base_unit_cost_xof: base_unit_cost,
            });
        }

        sqlx::query(
            "INSERT INTO goods_receipts (
               id, receipt_number, purchase_order_id, supplier_id, total_received_xof,
               user_id, note, supplier_invoice_ref
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&receipt_id)
        .bind(&receipt_number)
        .bind(&order_id)
        .bind(&order.2)
        .bind(total_received_xof)
        .bind(actor_user_id)
        .bind(&note)
        .bind(&supplier_invoice_ref)
        .execute(&mut *tx)
        .await?;

        for line in &receipt_lines {
            sqlx::query(
                "INSERT INTO goods_receipt_items (
                   id, goods_receipt_id, purchase_item_id, product_id,
                   received_qty, base_qty, unit_cost_xof
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&line.id)
            .bind(&receipt_id)
            .bind(&line.purchase_item_id)
            .bind(&line.product_id)
            .bind(line.received_qty)
            .bind(line.base_qty)
            .bind(line.unit_cost_xof)
            .execute(&mut *tx)
            .await?;

            sqlx::query("UPDATE purchase_items SET received_qty = received_qty + ? WHERE id = ?")
                .bind(line.received_qty)
                .bind(&line.purchase_item_id)
                .execute(&mut *tx)
                .await?;

            let stock: Option<(i64, i64, i64)> = sqlx::query_as(
                "SELECT p.weighted_avg_cost_xof, COALESCE(sb.quantity_base, 0),
                        COALESCE(sb.damaged_quantity_base, 0)
                 FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id
                 WHERE p.id = ?",
            )
            .bind(&line.product_id)
            .fetch_optional(&mut *tx)
            .await?;
            let (current_cump, quantity_base, damaged_quantity_base) =
                stock.ok_or_else(|| not_found("Produit introuvable lors de la réception."))?;
            let next_qty_base = quantity_base
                .checked_add(line.base_qty)
                .ok_or_else(|| validation("Dépassement arithmétique (stock réceptionné)"))?;
            let next_cump_xof = compute_weighted_avg_cost_xof(
                quantity_base,
                current_cump,
                line.base_qty,
                line.base_unit_cost_xof,
            )?;

            sqlx::query(
                "INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
                 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                 ON CONFLICT(product_id) DO UPDATE SET
                   quantity_base = excluded.quantity_base,
                   updated_at = excluded.updated_at",
            )
            .bind(&line.product_id)
            .bind(next_qty_base)
            .bind(damaged_quantity_base)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "UPDATE products SET weighted_avg_cost_xof = ?, purchase_price_xof = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     sync_version = sync_version + 1 WHERE id = ?",
            )
            .bind(next_cump_xof)
            .bind(line.base_unit_cost_xof)
            .bind(&line.product_id)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO product_suppliers (
                   id, product_id, supplier_id, last_unit_cost_xof, is_preferred
                 ) VALUES (?, ?, ?, ?, 0)
                 ON CONFLICT(product_id, supplier_id) DO UPDATE SET
                   last_unit_cost_xof = excluded.last_unit_cost_xof",
            )
            .bind(json::new_id())
            .bind(&line.product_id)
            .bind(&order.2)
            .bind(line.base_unit_cost_xof)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO stock_movements (
                   id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
                   balance_after_base, reference_type, reference_id, note, user_id
                 ) VALUES (?, ?, 'PURCHASE_RECEIPT', ?, ?, ?, 'GOODS_RECEIPT', ?, ?, ?)",
            )
            .bind(json::new_id())
            .bind(&line.product_id)
            .bind(line.base_qty)
            .bind(line.base_unit_cost_xof)
            .bind(next_qty_base)
            .bind(&receipt_id)
            .bind(format!("Réception {} (BC {})", receipt_number, order.1))
            .bind(actor_user_id)
            .execute(&mut *tx)
            .await?;
        }

        let remaining_agg: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(ordered_qty - received_qty), 0)
             FROM purchase_items WHERE purchase_order_id = ?",
        )
        .bind(&order_id)
        .fetch_one(&mut *tx)
        .await?;
        let next_status = if remaining_agg.0 == 0 { "RECEIVED" } else { "PARTIAL_RECEIVED" };
        sqlx::query(
            "UPDATE purchase_orders SET status = ?,
                 received_amount_xof = received_amount_xof + ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?",
        )
        .bind(next_status)
        .bind(total_received_xof)
        .bind(&order_id)
        .execute(&mut *tx)
        .await?;
        recompute_supplier_balance_due(&mut *tx, &order.2).await?;
        audit(
            &mut *tx,
            actor_user_id,
            "GOODS_RECEIPT_VALIDATED",
            "goods_receipts",
            &receipt_id,
            &json!({
                "receiptNumber": receipt_number, "purchaseOrderId": order_id,
                "orderNumber": order.1, "totalReceivedXof": total_received_xof,
                "nextStatus": next_status
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
    let rows = list_receipts_query(pool, Some(order_id.clone()), None).await?;
    find(&rows, "id", &receipt_id)
        .cloned()
        .ok_or_else(|| conflict("Réception enregistrée mais introuvable à la relecture."))
}

async fn list_receipts_query(
    pool: &SqlitePool,
    purchase_order_id: Option<String>,
    supplier_id: Option<String>,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT gr.id, gr.receipt_number, gr.purchase_order_id, po.order_number,
                gr.supplier_id, s.name AS supplier_name, gr.supplier_invoice_ref,
                gr.total_received_xof, gr.user_id,
                COALESCE(e.full_name, u.username) AS user_name, gr.received_at, gr.note
         FROM goods_receipts gr
         JOIN purchase_orders po ON po.id = gr.purchase_order_id
         JOIN suppliers s ON s.id = gr.supplier_id
         JOIN users u ON u.id = gr.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE (? IS NULL OR gr.purchase_order_id = ?)
           AND (? IS NULL OR gr.supplier_id = ?)
         ORDER BY gr.received_at DESC, gr.rowid DESC",
    )
    .bind(purchase_order_id.clone())
    .bind(purchase_order_id)
    .bind(supplier_id.clone())
    .bind(supplier_id)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let receipt_id: String = row.try_get("id")?;
        let items = sqlx::query(
            "SELECT gri.id, gri.goods_receipt_id, gri.purchase_item_id, gri.product_id,
                    p.sku AS product_sku, p.name AS product_name, gri.received_qty,
                    gri.base_qty, gri.unit_cost_xof
             FROM goods_receipt_items gri JOIN products p ON p.id = gri.product_id
             WHERE gri.goods_receipt_id = ?",
        )
        .bind(&receipt_id)
        .fetch_all(pool)
        .await?;
        out.push(attach(
            json::row_to_json(row, &[]),
            "items",
            json::rows_to_json(items, &[]),
        ));
    }
    Ok(Value::Array(out))
}

pub async fn list_receipts(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_receipts_query(
        pool,
        json::opt_str(input, "purchaseOrderId"),
        json::opt_str(input, "supplierId"),
    )
    .await
}

// ---------------------------------------------------------------------------
// Règlements fournisseurs
// ---------------------------------------------------------------------------

async fn list_payments_query(
    pool: &SqlitePool,
    supplier_id: Option<String>,
    purchase_order_id: Option<String>,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT p.id, p.payment_number, p.party_id AS supplier_id,
                s.name AS supplier_name, p.payment_method, p.amount_xof,
                p.external_reference, pa.target_id AS purchase_order_id,
                po.order_number, p.user_id,
                COALESCE(e.full_name, u.username) AS user_name, p.created_at
         FROM payments p
         JOIN suppliers s ON s.id = p.party_id
         JOIN users u ON u.id = p.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN payment_allocations pa
                ON pa.payment_id = p.id AND pa.target_type = 'PURCHASE_ORDER'
         LEFT JOIN purchase_orders po ON po.id = pa.target_id
         WHERE p.party_type = 'SUPPLIER'
           AND (? IS NULL OR p.party_id = ?)
           AND (? IS NULL OR pa.target_id = ?)
         ORDER BY p.created_at DESC, p.rowid DESC",
    )
    .bind(supplier_id.clone())
    .bind(supplier_id)
    .bind(purchase_order_id.clone())
    .bind(purchase_order_id)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

pub async fn list_payments(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_payments_query(
        pool,
        json::opt_str(input, "supplierId"),
        json::opt_str(input, "purchaseOrderId"),
    )
    .await
}

pub async fn record_payment(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let supplier_id = json::text_field(input, "supplierId", 1, 80, "Fournisseur")?;
    let purchase_order_id = json::opt_str(input, "purchaseOrderId");
    let payment_method = json::enum_field(input, "paymentMethod", PAYMENT_METHODS)?;
    let amount_xof = json::positive_i64(input, "amountXof", "Montant du règlement")?;
    let external_reference = json::optional_text(input, "externalReference", 100, "Référence externe")?;

    let supplier: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT id, name, balance_due_xof FROM suppliers WHERE id = ?",
    )
    .bind(&supplier_id)
    .fetch_optional(pool)
    .await?;
    let supplier = supplier.ok_or_else(|| not_found("Fournisseur introuvable."))?;

    let payment_id = json::new_id();
    let payment_number = doc_number("PAY-FRN");
    let mut tx = pool.begin().await?;
    let result = async {
        let open_session: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM cash_sessions WHERE status = 'OPEN'
             ORDER BY opened_at DESC LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let cash_session_id = if payment_method == "CASH" {
            open_session.as_ref().map(|row| row.0.clone())
        } else {
            None
        };

        sqlx::query(
            "INSERT INTO payments (
               id, payment_number, direction, party_type, party_id, payment_method,
               amount_xof, external_reference, cash_session_id, user_id
             ) VALUES (?, ?, 'OUTBOUND', 'SUPPLIER', ?, ?, ?, ?, ?, ?)",
        )
        .bind(&payment_id)
        .bind(&payment_number)
        .bind(&supplier.0)
        .bind(&payment_method)
        .bind(amount_xof)
        .bind(&external_reference)
        .bind(&cash_session_id)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;

        if let Some(po_id) = purchase_order_id.as_deref() {
            let po: Option<(String, String, String, String, i64, i64)> = sqlx::query_as(
                "SELECT id, order_number, supplier_id, status, total_amount_xof, paid_amount_xof
                 FROM purchase_orders WHERE id = ?",
            )
            .bind(po_id)
            .fetch_optional(&mut *tx)
            .await?;
            let po = po
                .filter(|row| row.2 == supplier.0)
                .ok_or_else(|| not_found("Commande fournisseur introuvable pour ce fournisseur."))?;
            if po.3 == "CANCELLED" || po.3 == "DRAFT" {
                return Err(conflict(
                    "Impossible d'enregistrer un règlement sur un brouillon ou une commande annulée.",
                ));
            }
            let remaining = po.4 - po.5;
            if amount_xof > remaining {
                return Err(validation(format!(
                    "Le règlement ({amount_xof} FCFA) dépasse le solde restant sur le bon {} ({remaining} FCFA).",
                    po.1
                )));
            }
            sqlx::query(
                "UPDATE purchase_orders SET paid_amount_xof = paid_amount_xof + ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     sync_version = sync_version + 1 WHERE id = ?",
            )
            .bind(amount_xof)
            .bind(&po.0)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
                 VALUES (?, ?, 'PURCHASE_ORDER', ?, ?)",
            )
            .bind(json::new_id())
            .bind(&payment_id)
            .bind(&po.0)
            .bind(amount_xof)
            .execute(&mut *tx)
            .await?;
        } else {
            // Répartition FIFO sur les commandes réceptionnées non soldées.
            let unpaid: Vec<(String, String, i64, i64)> = sqlx::query_as(
                "SELECT id, order_number, received_amount_xof, paid_amount_xof
                 FROM purchase_orders
                 WHERE supplier_id = ? AND status IN ('PARTIAL_RECEIVED', 'RECEIVED')
                   AND received_amount_xof > paid_amount_xof
                 ORDER BY created_at ASC",
            )
            .bind(&supplier.0)
            .fetch_all(&mut *tx)
            .await?;
            let mut total_due_received = 0_i64;
            for order in &unpaid {
                total_due_received = add_xof(
                    total_due_received,
                    order.2 - order.3,
                    "Dette réceptionnée",
                )?;
            }
            if amount_xof > total_due_received {
                return Err(validation(format!(
                    "Le montant ({amount_xof} FCFA) dépasse la dette réceptionnée due au fournisseur ({total_due_received} FCFA)."
                )));
            }
            let mut remaining_to_allocate = amount_xof;
            for order in &unpaid {
                if remaining_to_allocate <= 0 {
                    break;
                }
                let due_on_order = order.2 - order.3;
                let alloc = remaining_to_allocate.min(due_on_order);
                if alloc > 0 {
                    sqlx::query(
                        "UPDATE purchase_orders SET paid_amount_xof = paid_amount_xof + ?,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                             sync_version = sync_version + 1 WHERE id = ?",
                    )
                    .bind(alloc)
                    .bind(&order.0)
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query(
                        "INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
                         VALUES (?, ?, 'PURCHASE_ORDER', ?, ?)",
                    )
                    .bind(json::new_id())
                    .bind(&payment_id)
                    .bind(&order.0)
                    .bind(alloc)
                    .execute(&mut *tx)
                    .await?;
                    remaining_to_allocate -= alloc;
                }
            }
        }

        let new_balance_due = recompute_supplier_balance_due(&mut *tx, &supplier.0).await?;
        if payment_method == "CASH" {
            if let Some(session) = open_session.as_ref() {
                sqlx::query(
                    "INSERT INTO cash_movements (
                       id, cash_session_id, movement_type, amount_signed_xof,
                       reference_type, reference_id, description, user_id
                     ) VALUES (?, ?, 'SUPPLIER_PAYMENT', ?, 'PAYMENT', ?, ?, ?)",
                )
                .bind(json::new_id())
                .bind(&session.0)
                .bind(-amount_xof)
                .bind(&payment_id)
                .bind(format!("Règlement fournisseur {} ({payment_number})", supplier.1))
                .bind(actor_user_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        audit(
            &mut *tx,
            actor_user_id,
            "SUPPLIER_PAYMENT_RECORDED",
            "payments",
            &payment_id,
            &json!({
                "paymentNumber": payment_number, "supplierId": supplier.0,
                "amountXof": amount_xof, "paymentMethod": payment_method,
                "newBalanceDue": new_balance_due
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
    let rows = list_payments_query(pool, Some(supplier_id.clone()), None).await?;
    find(&rows, "id", &payment_id)
        .cloned()
        .ok_or_else(|| conflict("Règlement enregistré mais introuvable à la relecture."))
}

// ---------------------------------------------------------------------------
// Retours fournisseurs
// ---------------------------------------------------------------------------

pub async fn record_return(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let order_id = json::text_field(input, "purchaseOrderId", 1, 80, "Commande")?;
    let product_id = json::text_field(input, "productId", 1, 80, "Produit")?;
    let unit_id = json::text_field(input, "unitId", 1, 80, "Unité")?;
    let quantity = json::positive_i64(input, "quantity", "Quantité retournée")?;
    let note = json::optional_text(input, "note", 240, "Note")?;

    let return_id = json::new_id();
    let return_number = doc_number("RET-FRN");
    let mut tx = pool.begin().await?;
    let summary = async {
        let order: Option<(String, String, String, String, i64)> = sqlx::query_as(
            "SELECT id, order_number, supplier_id, status, received_amount_xof
             FROM purchase_orders WHERE id = ?",
        )
        .bind(&order_id)
        .fetch_optional(&mut *tx)
        .await?;
        let order = order.ok_or_else(|| not_found("Bon d'achat introuvable."))?;
        if order.3 != "PARTIAL_RECEIVED" && order.3 != "RECEIVED" {
            return Err(conflict(
                "Un retour fournisseur ne peut concerner qu'une commande déjà réceptionnée.",
            ));
        }

        let po_item: Option<(String, String, i64, i64, i64)> = sqlx::query_as(
            "SELECT id, unit_id, received_qty, conversion_to_base, unit_cost_xof
             FROM purchase_items
             WHERE purchase_order_id = ? AND product_id = ? AND unit_id = ?",
        )
        .bind(&order.0)
        .bind(&product_id)
        .bind(&unit_id)
        .fetch_optional(&mut *tx)
        .await?;
        let po_item = po_item
            .filter(|row| row.2 >= quantity)
            .ok_or_else(|| validation("Quantité retournée supérieure à la quantité reçue sur cette commande."))?;

        let base_qty_returned = mul_qty(quantity, po_item.3, "Quantité retournée")?;
        let total_return_xof = mul_xof(po_item.4, quantity, "Montant retourné")?;
        let base_unit_cost_xof = base_unit_cost_xof(po_item.4, po_item.3)?;

        let stock: Option<(String, i64, i64)> = sqlx::query_as(
            "SELECT p.name, p.weighted_avg_cost_xof, COALESCE(sb.quantity_base, 0)
             FROM products p LEFT JOIN stock_balances sb ON sb.product_id = p.id
             WHERE p.id = ?",
        )
        .bind(&product_id)
        .fetch_optional(&mut *tx)
        .await?;
        let stock = stock.ok_or_else(|| not_found("Produit introuvable lors du retour."))?;
        if stock.2 < base_qty_returned {
            return Err(common::insufficient_stock(format!(
                "Stock disponible insuffisant pour retourner {base_qty_returned} unités de « {} ».",
                stock.0
            )));
        }
        let next_qty_base = stock.2 - base_qty_returned;

        sqlx::query(
            "UPDATE stock_balances SET quantity_base = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE product_id = ?",
        )
        .bind(next_qty_base)
        .bind(&product_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO supplier_returns (
               id, return_number, purchase_order_id, supplier_id, total_return_xof, note, user_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&return_id)
        .bind(&return_number)
        .bind(&order.0)
        .bind(&order.2)
        .bind(total_return_xof)
        .bind(&note)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO supplier_return_items (
               id, supplier_return_id, product_id, unit_id, returned_qty,
               base_qty, unit_cost_xof, line_total_xof
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(json::new_id())
        .bind(&return_id)
        .bind(&product_id)
        .bind(&unit_id)
        .bind(quantity)
        .bind(base_qty_returned)
        .bind(po_item.4)
        .bind(total_return_xof)
        .execute(&mut *tx)
        .await?;

        let movement_note = note
            .clone()
            .unwrap_or_else(|| format!("Retour fournisseur {return_number} (BC {})", order.1));
        sqlx::query(
            "INSERT INTO stock_movements (
               id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
               balance_after_base, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, 'SUPPLIER_RETURN', ?, ?, ?, 'SUPPLIER_RETURN', ?, ?, ?)",
        )
        .bind(json::new_id())
        .bind(&product_id)
        .bind(-base_qty_returned)
        .bind(base_unit_cost_xof)
        .bind(next_qty_base)
        .bind(&return_id)
        .bind(movement_note)
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;

        // Le montant réceptionné exigible diminue sans jamais passer en négatif.
        sqlx::query(
            "UPDATE purchase_orders SET received_amount_xof = MAX(0, received_amount_xof - ?),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1 WHERE id = ?",
        )
        .bind(total_return_xof)
        .bind(&order.0)
        .execute(&mut *tx)
        .await?;
        recompute_supplier_balance_due(&mut *tx, &order.2).await?;

        audit(
            &mut *tx,
            actor_user_id,
            "SUPPLIER_RETURN_RECORDED",
            "supplier_returns",
            &return_id,
            &json!({
                "returnNumber": return_number, "purchaseOrderId": order.0,
                "baseQtyReturned": base_qty_returned, "totalReturnXof": total_return_xof
            }),
        )
        .await?;
        Ok::<Json, AppError>(json!({
            "returnNumber": return_number,
            "baseQtyReturned": base_qty_returned,
            "totalReturnXof": total_return_xof
        }))
    }
    .await;
    match summary {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn methodes_de_paiement_autorisees() {
        assert_eq!(PAYMENT_METHODS.len(), 6);
        assert!(PAYMENT_METHODS.contains(&"WAVE"));
        assert!(!PAYMENT_METHODS.contains(&"CHEQUE"));
    }

    #[test]
    fn numero_de_document_porte_le_prefixe_attendu() {
        assert!(doc_number("BC").starts_with("BC-"));
        assert!(doc_number("REC").starts_with("REC-"));
        assert!(doc_number("PAY-FRN").starts_with("PAY-FRN-"));
    }

    #[test]
    fn reliquat_non_negatif() {
        let dto = json!({ "receivedAmountXof": 100, "paidAmountXof": 140, "totalAmountXof": 200 });
        let received = dto["receivedAmountXof"].as_i64().unwrap();
        let paid = dto["paidAmountXof"].as_i64().unwrap();
        assert_eq!((received - paid).max(0), 0);
        assert_eq!((dto["totalAmountXof"].as_i64().unwrap() - paid).max(0), 60);
    }
}
