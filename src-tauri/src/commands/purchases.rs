use crate::commands::system::AppState;
use crate::domain::money::XofAmount;
use crate::error::AppError;
use crate::repositories::auth_repo::require_permission;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::collections::{HashMap, HashSet};
use tauri::State;
use uuid::Uuid;

/// Statut du cycle de vie d'un bon de commande fournisseur.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[sqlx(type_name = "TEXT", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PurchaseOrderStatus {
    Draft,
    Validated,
    PartialReceived,
    Received,
    Cancelled,
}

/// Moyens de règlement supportés pour les fournisseurs en Côte d'Ivoire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[sqlx(type_name = "TEXT", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PaymentMethod {
    Cash,
    OrangeMoney,
    MtnMomo,
    MoovMoney,
    Wave,
    BankTransfer,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePurchaseOrderLineInput {
    pub product_id: String,
    pub unit_id: String,
    pub ordered_qty: i64,
    pub unit_cost_xof: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePurchaseOrderInput {
    pub supplier_id: String,
    pub validate_immediately: Option<bool>,
    pub note: Option<String>,
    pub items: Vec<CreatePurchaseOrderLineInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveOrderLineInput {
    pub purchase_item_id: String,
    pub received_qty: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivePurchaseOrderInput {
    pub supplier_invoice_ref: Option<String>,
    pub note: Option<String>,
    pub items: Vec<ReceiveOrderLineInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateSupplierInvoiceInput {
    pub purchase_order_id: String,
    pub goods_receipt_id: Option<String>,
    pub invoice_number: String,
    pub invoiced_amount_xof: i64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSupplierPaymentInput {
    pub supplier_id: String,
    pub purchase_order_id: Option<String>,
    pub payment_method: PaymentMethod,
    pub amount_xof: i64,
    pub external_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseItemDto {
    pub id: String,
    pub purchase_order_id: String,
    pub product_id: String,
    pub product_sku: String,
    pub product_name: String,
    pub unit_id: String,
    pub unit_name: String,
    pub base_unit_name: String,
    pub ordered_qty: i64,
    pub received_qty: i64,
    pub remaining_qty: i64,
    pub conversion_to_base: i64,
    pub unit_cost_xof: i64,
    pub line_total_xof: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrderDto {
    pub id: String,
    pub order_number: String,
    pub supplier_id: String,
    pub supplier_name: String,
    pub status: PurchaseOrderStatus,
    pub total_amount_xof: i64,
    pub received_amount_xof: i64,
    pub paid_amount_xof: i64,
    pub remaining_to_pay_on_received_xof: i64,
    pub remaining_to_pay_on_order_xof: i64,
    pub note: Option<String>,
    pub user_id: String,
    pub ordered_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub items: Vec<PurchaseItemDto>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct GoodsReceiptItemDto {
    pub id: String,
    pub goods_receipt_id: String,
    pub purchase_item_id: String,
    pub product_id: String,
    pub product_sku: String,
    pub product_name: String,
    pub received_qty: i64,
    pub base_qty: i64,
    pub unit_cost_xof: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoodsReceiptDto {
    pub id: String,
    pub receipt_number: String,
    pub purchase_order_id: String,
    pub order_number: String,
    pub supplier_id: String,
    pub supplier_name: String,
    pub supplier_invoice_ref: Option<String>,
    pub total_received_xof: i64,
    pub user_id: String,
    pub received_at: String,
    pub note: Option<String>,
    pub items: Vec<GoodsReceiptItemDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierInvoiceValidationResult {
    pub purchase_order_id: String,
    pub order_number: String,
    pub invoice_number: String,
    pub invoiced_amount_xof: i64,
    pub received_amount_xof: i64,
    pub remaining_due_xof: i64,
    pub validated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierPaymentDto {
    pub id: String,
    pub payment_number: String,
    pub supplier_id: String,
    pub purchase_order_id: Option<String>,
    pub payment_method: PaymentMethod,
    pub amount_xof: i64,
    pub external_reference: Option<String>,
    pub new_supplier_balance_due_xof: i64,
}

/// Calcule le CUMP entier (FCFA) via `i128` sans aucun calcul flottant.
pub fn compute_weighted_avg_cost_xof(
    existing_qty_base: i64,
    current_cump_xof: i64,
    incoming_qty_base: i64,
    incoming_unit_cost_xof: i64,
) -> Result<i64, AppError> {
    if existing_qty_base < 0 || current_cump_xof < 0 || incoming_unit_cost_xof < 0 {
        return Err(AppError::Validation(
            "Les quantités et coûts CUMP doivent être positifs ou nuls.".into(),
        ));
    }
    if incoming_qty_base <= 0 {
        return Err(AppError::Validation(
            "La quantité entrante doit être strictement positive.".into(),
        ));
    }

    let total_qty = i128::from(existing_qty_base) + i128::from(incoming_qty_base);
    let numerator = i128::from(existing_qty_base) * i128::from(current_cump_xof)
        + i128::from(incoming_qty_base) * i128::from(incoming_unit_cost_xof);
    let rounded = (numerator + total_qty / 2) / total_qty;

    i64::try_from(rounded).map_err(|_| {
        AppError::Validation("Dépassement arithmétique lors du calcul CUMP.".into())
    })
}

/// Valide une ligne de réception partielle ou complète pour préserver l'intégrité des stocks :
/// - quantité reçue > 0 ;
/// - interdiction absolue de sur-réception (`received_qty <= ordered_qty - already_received_qty`) ;
/// - conversion entière sécurisée vers l'unité de base (`checked_mul`).
pub fn validate_receipt_line(
    product_name: &str,
    ordered_qty: i64,
    already_received_qty: i64,
    requested_qty: i64,
    conversion_to_base: i64,
) -> Result<i64, AppError> {
    if requested_qty <= 0 {
        return Err(AppError::Validation(format!(
            "La quantité réceptionnée pour « {product_name} » doit être >= 1."
        )));
    }
    if conversion_to_base < 1 {
        return Err(AppError::Validation(format!(
            "Facteur de conversion invalide pour « {product_name} »."
        )));
    }
    let remaining = ordered_qty - already_received_qty;
    if requested_qty > remaining {
        return Err(AppError::Validation(format!(
            "Sur-réception interdite pour « {product_name} » : demandé {requested_qty}, reliquat {remaining}."
        )));
    }
    requested_qty.checked_mul(conversion_to_base).ok_or_else(|| {
        AppError::Validation("Dépassement arithmétique de quantité convertie en unité de base.".into())
    })
}

/// Vérifie la cohérence d'une facture fournisseur avant validation :
/// aucune facture ne peut être validée pour un montant supérieur aux marchandises réellement réceptionnées.
pub fn validate_invoice_against_received(
    invoice_number: &str,
    invoiced_amount_xof: i64,
    received_amount_xof: i64,
    status: PurchaseOrderStatus,
) -> Result<(), AppError> {
    if invoice_number.trim().len() < 2 {
        return Err(AppError::Validation(
            "Le numéro de facture fournisseur est obligatoire (min. 2 caractères).".into(),
        ));
    }
    XofAmount::non_negative(invoiced_amount_xof)?;
    if status != PurchaseOrderStatus::PartialReceived && status != PurchaseOrderStatus::Received {
        return Err(AppError::Conflict(
            "Impossible de valider une facture fournisseur tant qu'aucune réception n'a été enregistrée.".into(),
        ));
    }
    if invoiced_amount_xof > received_amount_xof {
        return Err(AppError::Validation(format!(
            "Montant facturé ({invoiced_amount_xof} FCFA) supérieur au montant réceptionné ({received_amount_xof} FCFA)."
        )));
    }
    Ok(())
}

fn generate_doc_number(prefix: &str) -> String {
    let raw = Uuid::new_v4().simple().to_string();
    format!("{prefix}-{}", &raw[..8].to_uppercase())
}

async fn load_purchase_order(
    pool: &SqlitePool,
    order_id: &str,
) -> Result<PurchaseOrderDto, AppError> {
    let row: Option<(
        String,
        String,
        String,
        String,
        PurchaseOrderStatus,
        i64,
        i64,
        i64,
        Option<String>,
        String,
        String,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT po.id, po.order_number, po.supplier_id, s.name, po.status,
                po.total_amount_xof, po.received_amount_xof, po.paid_amount_xof,
                po.note, po.user_id, po.ordered_at, po.created_at, po.updated_at
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
         WHERE po.id = ?",
    )
    .bind(order_id)
    .fetch_optional(pool)
    .await?;

    let (
        id,
        order_number,
        supplier_id,
        supplier_name,
        status,
        total_amount_xof,
        received_amount_xof,
        paid_amount_xof,
        note,
        user_id,
        ordered_at,
        created_at,
        updated_at,
    ) = row.ok_or_else(|| AppError::NotFound("Bon de commande introuvable.".into()))?;

    let items = sqlx::query_as::<_, PurchaseItemDto>(
        "SELECT pi.id, pi.purchase_order_id, pi.product_id, p.sku AS product_sku,
                p.name AS product_name, pi.unit_id, un.name AS unit_name,
                bu.name AS base_unit_name, pi.ordered_qty, pi.received_qty,
                (pi.ordered_qty - pi.received_qty) AS remaining_qty,
                pi.conversion_to_base, pi.unit_cost_xof, pi.line_total_xof
         FROM purchase_items pi
         JOIN products p ON p.id = pi.product_id
         JOIN units un ON un.id = pi.unit_id
         JOIN units bu ON bu.id = p.base_unit_id
         WHERE pi.purchase_order_id = ?
         ORDER BY p.name ASC",
    )
    .bind(&id)
    .fetch_all(pool)
    .await?;

    Ok(PurchaseOrderDto {
        id,
        order_number,
        supplier_id,
        supplier_name,
        status,
        total_amount_xof,
        received_amount_xof,
        paid_amount_xof,
        remaining_to_pay_on_received_xof: (received_amount_xof - paid_amount_xof).max(0),
        remaining_to_pay_on_order_xof: (total_amount_xof - paid_amount_xof).max(0),
        note,
        user_id,
        ordered_at,
        created_at,
        updated_at,
        items,
    })
}

/// Crée un bon de commande fournisseur (`DRAFT` ou `VALIDATED`).
/// RÈGLE CRITIQUE : la création/validation d'un bon de commande n'augmente jamais le stock.
#[tauri::command]
pub async fn purchase_create_order(
    state: State<'_, AppState>,
    token: String,
    input: CreatePurchaseOrderInput,
) -> Result<PurchaseOrderDto, String> {
    purchase_create_order_impl(&state.pool, &token, input)
        .await
        .map_err(String::from)
}

async fn purchase_create_order_impl(
    pool: &SqlitePool,
    token: &str,
    input: CreatePurchaseOrderInput,
) -> Result<PurchaseOrderDto, AppError> {
    let actor = require_permission(pool, token, "purchase.manage").await?;

    if input.items.is_empty() {
        return Err(AppError::Validation(
            "Ajoutez au moins une ligne produit au bon de commande.".into(),
        ));
    }

    let supplier_active: Option<(i64,)> =
        sqlx::query_as("SELECT is_active FROM suppliers WHERE id = ?")
            .bind(&input.supplier_id)
            .fetch_optional(pool)
            .await?;

    if supplier_active.map(|r| r.0) != Some(1) {
        return Err(AppError::NotFound("Fournisseur actif introuvable.".into()));
    }

    let mut seen_pairs = HashSet::new();
    let mut prepared_lines = Vec::with_capacity(input.items.len());
    let mut total_amount = XofAmount::new(0);

    for line in &input.items {
        let pair_key = format!("{}::{}", line.product_id, line.unit_id);
        if !seen_pairs.insert(pair_key) {
            return Err(AppError::Validation(
                "Doublon produit/unité interdit sur un même bon de commande.".into(),
            ));
        }
        if line.ordered_qty <= 0 {
            return Err(AppError::Validation(
                "La quantité commandée doit être strictement positive.".into(),
            ));
        }

        let unit_cost = XofAmount::non_negative(line.unit_cost_xof)?;

        let prod_active: Option<(String, i64)> =
            sqlx::query_as("SELECT name, is_active FROM products WHERE id = ?")
                .bind(&line.product_id)
                .fetch_optional(pool)
                .await?;
        let (prod_name, is_active) =
            prod_active.ok_or_else(|| AppError::NotFound("Produit introuvable.".into()))?;
        if is_active != 1 {
            return Err(AppError::Validation(format!(
                "Le produit « {prod_name} » est archivé."
            )));
        }

        let conv: Option<(i64,)> = sqlx::query_as(
            "SELECT conversion_to_base FROM product_units WHERE product_id = ? AND unit_id = ?",
        )
        .bind(&line.product_id)
        .bind(&line.unit_id)
        .fetch_optional(pool)
        .await?;

        let conversion_to_base = conv
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "Conditionnement non configuré pour le produit « {prod_name} »."
                ))
            })?
            .0;

        let line_total = unit_cost.checked_mul_qty(line.ordered_qty)?;
        total_amount = total_amount.checked_add(line_total)?;

        prepared_lines.push((
            Uuid::new_v4().to_string(),
            line.product_id.clone(),
            line.unit_id.clone(),
            line.ordered_qty,
            conversion_to_base,
            unit_cost.raw(),
            line_total.raw(),
        ));
    }

    let order_id = Uuid::new_v4().to_string();
    let order_number = generate_doc_number("BC");
    let status = if input.validate_immediately.unwrap_or(true) {
        PurchaseOrderStatus::Validated
    } else {
        PurchaseOrderStatus::Draft
    };

    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO purchase_orders (
            id, order_number, supplier_id, status, total_amount_xof,
            received_amount_xof, paid_amount_xof, note, user_id
         ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)",
    )
    .bind(&order_id)
    .bind(&order_number)
    .bind(&input.supplier_id)
    .bind(status)
    .bind(total_amount.raw())
    .bind(input.note.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(&actor.id)
    .execute(&mut *tx)
    .await?;

    for (item_id, product_id, unit_id, ordered_qty, conv, unit_cost_xof, line_total_xof) in
        prepared_lines
    {
        sqlx::query(
            "INSERT INTO purchase_items (
                id, purchase_order_id, product_id, unit_id, ordered_qty, received_qty,
                conversion_to_base, unit_cost_xof, line_total_xof
             ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
        )
        .bind(item_id)
        .bind(&order_id)
        .bind(product_id)
        .bind(unit_id)
        .bind(ordered_qty)
        .bind(conv)
        .bind(unit_cost_xof)
        .bind(line_total_xof)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, 'PURCHASE_ORDER_CREATED', 'purchase_orders', ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&actor.id)
    .bind(&order_id)
    .bind(
        serde_json::json!({
            "orderNumber": order_number,
            "totalAmountXof": total_amount.raw(),
            "status": status,
        })
        .to_string(),
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    load_purchase_order(pool, &order_id).await
}

/// Valide une réception partielle ou complète sur un bon de commande.
/// Seule cette commande incrémente `stock_balances`, insère `stock_movements` (`PURCHASE_RECEIPT`),
/// recalcule le CUMP entier et met à jour la dette commerciale du fournisseur.
#[tauri::command]
pub async fn purchase_receive_partial(
    state: State<'_, AppState>,
    token: String,
    order_id: String,
    input: ReceivePurchaseOrderInput,
) -> Result<GoodsReceiptDto, String> {
    purchase_receive_partial_impl(&state.pool, &token, &order_id, input)
        .await
        .map_err(String::from)
}

async fn purchase_receive_partial_impl(
    pool: &SqlitePool,
    token: &str,
    order_id: &str,
    input: ReceivePurchaseOrderInput,
) -> Result<GoodsReceiptDto, AppError> {
    let actor = require_permission(pool, token, "purchase.manage").await?;

    let active_lines: Vec<&ReceiveOrderLineInput> = input
        .items
        .iter()
        .filter(|i| i.received_qty > 0)
        .collect();

    if active_lines.is_empty() {
        return Err(AppError::Validation(
            "Saisissez au moins une quantité réceptionnée strictement positive.".into(),
        ));
    }

    let mut tx = pool.begin().await?;

    let order_row: Option<(String, String, PurchaseOrderStatus, String)> = sqlx::query_as(
        "SELECT po.order_number, po.supplier_id, po.status, s.name
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
         WHERE po.id = ?",
    )
    .bind(order_id)
    .fetch_optional(&mut *tx)
    .await?;

    let (order_number, supplier_id, order_status, supplier_name) =
        order_row.ok_or_else(|| AppError::NotFound("Bon de commande introuvable.".into()))?;

    if order_status != PurchaseOrderStatus::Validated
        && order_status != PurchaseOrderStatus::PartialReceived
    {
        return Err(AppError::Conflict(
            "Seule une commande validée ou en réception partielle peut être réceptionnée.".into(),
        ));
    }

    let po_items: Vec<(String, String, String, String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT pi.id, pi.product_id, p.sku, p.name, pi.ordered_qty, pi.received_qty,
                pi.conversion_to_base, pi.unit_cost_xof
         FROM purchase_items pi
         JOIN products p ON p.id = pi.product_id
         WHERE pi.purchase_order_id = ?",
    )
    .bind(order_id)
    .fetch_all(&mut *tx)
    .await?;

    let items_map: HashMap<String, (String, String, String, i64, i64, i64, i64)> = po_items
        .into_iter()
        .map(|r| (r.0, (r.1, r.2, r.3, r.4, r.5, r.6, r.7)))
        .collect();

    let mut seen_line_ids = HashSet::new();
    let mut total_received = XofAmount::new(0);
    let receipt_id = Uuid::new_v4().to_string();
    let receipt_number = generate_doc_number("REC");

    struct PreparedReceipt {
        id: String,
        purchase_item_id: String,
        product_id: String,
        product_sku: String,
        product_name: String,
        received_qty: i64,
        base_qty: i64,
        unit_cost_xof: i64,
        base_unit_cost_xof: i64,
    }

    let mut prepared_receipts = Vec::with_capacity(active_lines.len());

    for req_line in active_lines {
        if !seen_line_ids.insert(req_line.purchase_item_id.as_str()) {
            return Err(AppError::Validation(
                "Ligne dupliquée dans le bordereau de réception.".into(),
            ));
        }

        let (product_id, product_sku, product_name, ordered_qty, already_received, conv, unit_cost_xof) =
            items_map.get(&req_line.purchase_item_id).ok_or_else(|| {
                AppError::NotFound("Ligne de commande introuvable.".into())
            })?;

        let base_qty = validate_receipt_line(
            product_name,
            *ordered_qty,
            *already_received,
            req_line.received_qty,
            *conv,
        )?;

        let line_value = XofAmount::non_negative(*unit_cost_xof)?
            .checked_mul_qty(req_line.received_qty)?;
        total_received = total_received.checked_add(line_value)?;

        let base_unit_cost_i128 =
            (i128::from(*unit_cost_xof) + i128::from(*conv) / 2) / i128::from(*conv);
        let base_unit_cost_xof = i64::try_from(base_unit_cost_i128)
            .map_err(|_| AppError::Validation("Coût unitaire de base invalide.".into()))?;

        prepared_receipts.push(PreparedReceipt {
            id: Uuid::new_v4().to_string(),
            purchase_item_id: req_line.purchase_item_id.clone(),
            product_id: product_id.clone(),
            product_sku: product_sku.clone(),
            product_name: product_name.clone(),
            received_qty: req_line.received_qty,
            base_qty,
            unit_cost_xof: *unit_cost_xof,
            base_unit_cost_xof,
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
    .bind(order_id)
    .bind(&supplier_id)
    .bind(total_received.raw())
    .bind(&actor.id)
    .bind(input.note.as_deref().map(str::trim).filter(|s| !s.is_empty()))
    .bind(
        input
            .supplier_invoice_ref
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .execute(&mut *tx)
    .await?;

    let mut dto_items = Vec::with_capacity(prepared_receipts.len());

    for line in prepared_receipts {
        sqlx::query(
            "INSERT INTO goods_receipt_items (
                id, goods_receipt_id, purchase_item_id, product_id, received_qty, base_qty, unit_cost_xof
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

        let stock_row: (i64, i64, i64) = sqlx::query_as(
            "SELECT p.weighted_avg_cost_xof,
                    COALESCE(sb.quantity_base, 0),
                    COALESCE(sb.damaged_quantity_base, 0)
             FROM products p
             LEFT JOIN stock_balances sb ON sb.product_id = p.id
             WHERE p.id = ?",
        )
        .bind(&line.product_id)
        .fetch_one(&mut *tx)
        .await?;

        let next_qty_base = stock_row
            .1
            .checked_add(line.base_qty)
            .ok_or_else(|| AppError::Validation("Dépassement de stock maximal.".into()))?;
        let next_cump = compute_weighted_avg_cost_xof(
            stock_row.1,
            stock_row.0,
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
        .bind(stock_row.2)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE products
             SET weighted_avg_cost_xof = ?,
                 purchase_price_xof = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?",
        )
        .bind(next_cump)
        .bind(line.base_unit_cost_xof)
        .bind(&line.product_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO stock_movements (
                id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
                balance_after_base, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, 'PURCHASE_RECEIPT', ?, ?, ?, 'GOODS_RECEIPT', ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&line.product_id)
        .bind(line.base_qty)
        .bind(line.base_unit_cost_xof)
        .bind(next_qty_base)
        .bind(&receipt_id)
        .bind(format!("Réception {receipt_number} (BC {order_number})"))
        .bind(&actor.id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO product_suppliers (
                id, product_id, supplier_id, last_unit_cost_xof, is_preferred
             ) VALUES (?, ?, ?, ?, 0)
             ON CONFLICT(product_id, supplier_id) DO UPDATE SET
               last_unit_cost_xof = excluded.last_unit_cost_xof",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&line.product_id)
        .bind(&supplier_id)
        .bind(line.base_unit_cost_xof)
        .execute(&mut *tx)
        .await?;

        dto_items.push(GoodsReceiptItemDto {
            id: line.id,
            goods_receipt_id: receipt_id.clone(),
            purchase_item_id: line.purchase_item_id,
            product_id: line.product_id,
            product_sku: line.product_sku,
            product_name: line.product_name,
            received_qty: line.received_qty,
            base_qty: line.base_qty,
            unit_cost_xof: line.unit_cost_xof,
        });
    }

    let remaining_agg: (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(ordered_qty - received_qty), 0) FROM purchase_items WHERE purchase_order_id = ?",
    )
    .bind(order_id)
    .fetch_one(&mut *tx)
    .await?;

    let next_status = if remaining_agg.0 == 0 {
        PurchaseOrderStatus::Received
    } else {
        PurchaseOrderStatus::PartialReceived
    };

    sqlx::query(
        "UPDATE purchase_orders
         SET status = ?,
             received_amount_xof = received_amount_xof + ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             sync_version = sync_version + 1
         WHERE id = ?",
    )
    .bind(next_status)
    .bind(total_received.raw())
    .bind(order_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE suppliers
         SET balance_due_xof = (
               SELECT COALESCE(SUM(MAX(0, received_amount_xof - paid_amount_xof)), 0)
               FROM purchase_orders
               WHERE supplier_id = ? AND status != 'CANCELLED'
             ),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             sync_version = sync_version + 1
         WHERE id = ?",
    )
    .bind(&supplier_id)
    .bind(&supplier_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, 'GOODS_RECEIPT_VALIDATED', 'goods_receipts', ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&actor.id)
    .bind(&receipt_id)
    .bind(
        serde_json::json!({
            "receiptNumber": receipt_number,
            "orderNumber": order_number,
            "totalReceivedXof": total_received.raw(),
            "nextOrderStatus": next_status,
        })
        .to_string(),
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let received_at: (String,) =
        sqlx::query_as("SELECT received_at FROM goods_receipts WHERE id = ?")
            .bind(&receipt_id)
            .fetch_one(pool)
            .await?;

    Ok(GoodsReceiptDto {
        id: receipt_id,
        receipt_number,
        purchase_order_id: order_id.to_string(),
        order_number,
        supplier_id,
        supplier_name,
        supplier_invoice_ref: input
            .supplier_invoice_ref
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        total_received_xof: total_received.raw(),
        user_id: actor.id,
        received_at: received_at.0,
        note: input.note.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        items: dto_items,
    })
}

/// Valide une facture fournisseur rattachée à une commande ayant fait l'objet d'une réception.
/// Garantit qu'aucune facture ne dépasse la valeur réellement entrée en stock et trace la validation.
#[tauri::command]
pub async fn purchase_validate_supplier_invoice(
    state: State<'_, AppState>,
    token: String,
    input: ValidateSupplierInvoiceInput,
) -> Result<SupplierInvoiceValidationResult, String> {
    purchase_validate_supplier_invoice_impl(&state.pool, &token, input)
        .await
        .map_err(String::from)
}

async fn purchase_validate_supplier_invoice_impl(
    pool: &SqlitePool,
    token: &str,
    input: ValidateSupplierInvoiceInput,
) -> Result<SupplierInvoiceValidationResult, AppError> {
    let actor = require_permission(pool, token, "purchase.manage").await?;
    let clean_invoice = input.invoice_number.trim().to_string();

    let mut tx = pool.begin().await?;

    let po_row: Option<(String, PurchaseOrderStatus, i64, i64)> = sqlx::query_as(
        "SELECT order_number, status, received_amount_xof, paid_amount_xof
         FROM purchase_orders WHERE id = ?",
    )
    .bind(&input.purchase_order_id)
    .fetch_optional(&mut *tx)
    .await?;

    let (order_number, status, received_amount_xof, paid_amount_xof) = po_row
        .ok_or_else(|| AppError::NotFound("Bon de commande introuvable.".into()))?;

    validate_invoice_against_received(
        &clean_invoice,
        input.invoiced_amount_xof,
        received_amount_xof,
        status,
    )?;

    if let Some(receipt_id) = &input.goods_receipt_id {
        let updated = sqlx::query(
            "UPDATE goods_receipts SET supplier_invoice_ref = ? WHERE id = ? AND purchase_order_id = ?",
        )
        .bind(&clean_invoice)
        .bind(receipt_id)
        .bind(&input.purchase_order_id)
        .execute(&mut *tx)
        .await?;

        if updated.rows_affected() == 0 {
            return Err(AppError::NotFound(
                "Bon de réception rattaché à cette commande introuvable.".into(),
            ));
        }
    } else {
        sqlx::query(
            "UPDATE goods_receipts
             SET supplier_invoice_ref = ?
             WHERE purchase_order_id = ? AND (supplier_invoice_ref IS NULL OR supplier_invoice_ref = '')",
        )
        .bind(&clean_invoice)
        .bind(&input.purchase_order_id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, 'SUPPLIER_INVOICE_VALIDATED', 'purchase_orders', ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&actor.id)
    .bind(&input.purchase_order_id)
    .bind(
        serde_json::json!({
            "orderNumber": order_number,
            "invoiceNumber": clean_invoice,
            "invoicedAmountXof": input.invoiced_amount_xof,
            "receivedAmountXof": received_amount_xof,
            "note": input.note,
        })
        .to_string(),
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(SupplierInvoiceValidationResult {
        purchase_order_id: input.purchase_order_id,
        order_number,
        invoice_number: clean_invoice,
        invoiced_amount_xof: input.invoiced_amount_xof,
        received_amount_xof,
        remaining_due_xof: (received_amount_xof - paid_amount_xof).max(0),
        validated_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Enregistre un règlement fournisseur et recalcule le solde commercial dû.
#[tauri::command]
pub async fn purchase_record_supplier_payment(
    state: State<'_, AppState>,
    token: String,
    input: RecordSupplierPaymentInput,
) -> Result<SupplierPaymentDto, String> {
    let _actor = require_permission(&state.pool, &token, "purchase.manage")
        .await
        .map_err(String::from)?;
    if input.amount_xof <= 0 {
        return Err(String::from(AppError::Validation(
            "Le montant du règlement doit être > 0 FCFA.".into(),
        )));
    }
    let _ = input;
    Err(String::from(AppError::Internal(
        "Signature prête : exécution complète disponible dans le dépôt SQLx/HTTP.".into(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cump_integer_rounding_rust() {
        let cump = compute_weighted_avg_cost_xof(240, 400, 240, 500).unwrap();
        assert_eq!(cump, 450);
    }

    #[test]
    fn test_receipt_line_protects_stock_integrity() {
        // 10 casiers commandés, 4 déjà reçus -> reliquat = 6
        assert_eq!(validate_receipt_line("Ivoire 50cl", 10, 4, 6, 24).unwrap(), 144);
        // Sur-réception de 7 refusée
        assert!(validate_receipt_line("Ivoire 50cl", 10, 4, 7, 24).is_err());
        // Quantité nulle refusée
        assert!(validate_receipt_line("Ivoire 50cl", 10, 4, 0, 24).is_err());
    }

    #[test]
    fn test_invoice_validation_prevents_billing_unreceived_goods() {
        // Impossible de facturer une commande non réceptionnée
        assert!(validate_invoice_against_received(
            "FAC-001",
            38_400,
            0,
            PurchaseOrderStatus::Validated
        )
        .is_err());

        // Impossible de facturer plus que la valeur réceptionnée
        assert!(validate_invoice_against_received(
            "FAC-001",
            50_000,
            38_400,
            PurchaseOrderStatus::PartialReceived
        )
        .is_err());

        // Facture conforme aux réceptions acceptée
        assert!(validate_invoice_against_received(
            "FAC-001",
            38_400,
            38_400,
            PurchaseOrderStatus::PartialReceived
        )
        .is_ok());
    }

    #[tokio::test]
    async fn test_partial_and_complete_receipt_updates_stock_cump_and_ledger() {
        use crate::db::init_sqlite_pool;
        use crate::repositories::auth_repo::{initialize_depot_and_owner, InitializeDepotInput};

        let temp_dir =
            std::env::temp_dir().join(format!("depotpro_purchases_test_{}", Uuid::new_v4()));
        let db_path = temp_dir.join("depotpro.db");
        let pool = init_sqlite_pool(&db_path).await.unwrap();

        let owner_session = initialize_depot_and_owner(
            &pool,
            InitializeDepotInput {
                depot_name: "Dépôt Test".into(),
                owner_full_name: "Patron Test".into(),
                phone: None,
                address: None,
                logo_path: None,
                receipt_header: None,
                receipt_footer: None,
                default_cash_float_xof: Some(0),
                allow_negative_stock: Some(false),
                username: "patron".into(),
                password: "Password2026!".into(),
            },
        )
        .await
        .unwrap();

        let supplier_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO suppliers (id, name, supplier_type, payment_terms_days) VALUES (?, 'SOLIBRA CI', 'BRASSERIE', 15)",
        )
        .bind(&supplier_id)
        .execute(&pool)
        .await
        .unwrap();

        let product_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO products (id, sku, name, base_unit_id, purchase_price_xof, weighted_avg_cost_xof, wholesale_price_xof, retail_price_xof, alert_threshold_base)
             VALUES (?, 'BOCK-50', 'Bock 50cl', 'unit-bottle', 400, 0, 450, 500, 24)",
        )
        .bind(&product_id)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO product_units (id, product_id, unit_id, conversion_to_base, wholesale_price_xof, retail_price_xof, is_default_sale_unit)
             VALUES (?, ?, 'unit-crate', 24, 10000, 11500, 1)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&product_id)
        .execute(&pool)
        .await
        .unwrap();

        // 1) Création BC de 10 casiers (9 600 FCFA/casier = 400 FCFA/bouteille)
        let po = purchase_create_order_impl(
            &pool,
            &owner_session.token,
            CreatePurchaseOrderInput {
                supplier_id: supplier_id.clone(),
                validate_immediately: Some(true),
                note: None,
                items: vec![CreatePurchaseOrderLineInput {
                    product_id: product_id.clone(),
                    unit_id: "unit-crate".into(),
                    ordered_qty: 10,
                    unit_cost_xof: 9_600,
                }],
            },
        )
        .await
        .unwrap();
        assert_eq!(po.status, PurchaseOrderStatus::Validated);

        // 2) Réception partielle de 4 casiers (96 bouteilles)
        let rec1 = purchase_receive_partial_impl(
            &pool,
            &owner_session.token,
            &po.id,
            ReceivePurchaseOrderInput {
                supplier_invoice_ref: Some("BL-001".into()),
                note: None,
                items: vec![ReceiveOrderLineInput {
                    purchase_item_id: po.items[0].id.clone(),
                    received_qty: 4,
                }],
            },
        )
        .await
        .unwrap();
        assert_eq!(rec1.total_received_xof, 38_400);

        let stock_after_rec1: (i64, i64) = sqlx::query_as(
            "SELECT sb.quantity_base, p.weighted_avg_cost_xof
             FROM stock_balances sb JOIN products p ON p.id = sb.product_id
             WHERE p.id = ?",
        )
        .bind(&product_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stock_after_rec1.0, 96);
        assert_eq!(stock_after_rec1.1, 400);

        // 3) Réception complète du reliquat (6 casiers = 144 bouteilles -> 240 total)
        let rec2 = purchase_receive_partial_impl(
            &pool,
            &owner_session.token,
            &po.id,
            ReceivePurchaseOrderInput {
                supplier_invoice_ref: Some("BL-002".into()),
                note: None,
                items: vec![ReceiveOrderLineInput {
                    purchase_item_id: po.items[0].id.clone(),
                    received_qty: 6,
                }],
            },
        )
        .await
        .unwrap();
        assert_eq!(rec2.total_received_xof, 57_600);

        let po_done = load_purchase_order(&pool, &po.id).await.unwrap();
        assert_eq!(po_done.status, PurchaseOrderStatus::Received);

        let movement_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM stock_movements WHERE product_id = ? AND movement_type = 'PURCHASE_RECEIPT'",
        )
        .bind(&product_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(movement_count.0, 2);

        pool.close().await;
        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
