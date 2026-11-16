//! LOT 10 — Tranche 3, Clients & créances : port de
//! `server/repositories/customerRepo.ts`.
//!
//! Créances commerciales, plafond de crédit, archivage interdit avec dette,
//! relevé client, allocation FIFO des règlements et recouvrement en caisse
//! sont validés ici, dans le backend Rust.

use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{
    self, add_xof, attach, audit, doc_number, find, like, not_found, conflict, number,
    PAYMENT_METHODS,
};
use serde_json::json;
use sqlx::SqlitePool;

const CUSTOMER_TYPES: &[&str] = &["PARTICULIER", "DETAILLANT", "REVENDEUR", "ENTREPRISE"];
const BOOL_CUSTOMERS: &[&str] = &["isActive"];
const BOOL_SALES: &[&str] = &["isOverdue"];

struct CustomerInput {
    full_name: String,
    customer_type: String,
    phone: Option<String>,
    email: Option<String>,
    address: Option<String>,
    credit_limit_xof: i64,
    due_days: i64,
    notes: Option<String>,
}

fn validate_customer(input: &Json) -> Result<CustomerInput, AppError> {
    let credit_limit_xof = json::non_negative_i64(input, "creditLimitXof", "Plafond de crédit")?;
    let due_days = json::non_negative_i64(input, "dueDays", "Délai de règlement")?;
    if due_days > 365 {
        return Err(common::validation(
            "Le délai de règlement doit être entre 0 et 365 jours.",
        ));
    }
    Ok(CustomerInput {
        full_name: json::text_field(input, "fullName", 2, 140, "Nom du client")?,
        customer_type: json::enum_field(input, "customerType", CUSTOMER_TYPES)?,
        phone: json::optional_text(input, "phone", 40, "Téléphone")?,
        email: json::optional_text(input, "email", 120, "E-mail")?,
        address: json::optional_text(input, "address", 240, "Adresse")?,
        credit_limit_xof,
        due_days,
        notes: json::optional_text(input, "notes", 300, "Notes")?,
    })
}

async fn recompute_commercial_debt(
    tx: &mut sqlx::sqlite::SqliteConnection,
    customer_id: &str,
) -> Result<i64, AppError> {
    let row = sqlx::query(
        "SELECT COALESCE(SUM(credit_amount_xof), 0) AS debt_xof
         FROM sales WHERE customer_id = ? AND status = 'VALIDATED'",
    )
    .bind(customer_id)
    .fetch_one(&mut *tx)
    .await?;
    let debt = json::row_to_json(row, &[]);
    let debt_xof = number(&debt, "debtXof").max(0);
    sqlx::query(
        "UPDATE customers SET commercial_debt_xof = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             sync_version = sync_version + 1 WHERE id = ?",
    )
    .bind(debt_xof)
    .bind(customer_id)
    .execute(&mut *tx)
    .await?;
    Ok(debt_xof)
}

async fn list_customers_query(
    pool: &SqlitePool,
    search: Option<String>,
    customer_type: Option<String>,
    only_with_debt: bool,
    include_inactive: bool,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT c.id, c.full_name, c.customer_type, c.phone, c.email, c.address,
                c.credit_limit_xof, c.commercial_debt_xof, c.due_days, c.notes,
                c.is_active, c.created_at, c.updated_at,
                COALESCE((
                  SELECT SUM(s.credit_amount_xof) FROM sales s
                  WHERE s.customer_id = c.id AND s.status = 'VALIDATED'
                    AND s.credit_amount_xof > 0 AND s.due_at IS NOT NULL
                    AND s.due_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ), 0) AS overdue_debt_xof,
                COALESCE((
                  SELECT SUM(cb.deposit_value_xof) FROM consignment_balances cb
                  WHERE cb.holder_type = 'CUSTOMER' AND cb.holder_id = c.id
                ), 0) AS consignment_balance_xof,
                COALESCE((
                  SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'VALIDATED'
                ), 0) AS sales_count,
                COALESCE((
                  SELECT SUM(s.total_payable_xof) FROM sales s
                  WHERE s.customer_id = c.id AND s.status = 'VALIDATED'
                ), 0) AS total_purchased_xof
         FROM customers c
         WHERE (? IS NULL OR c.is_active = 1)
           AND (? IS NULL OR c.customer_type = ?)
           AND (? IS NULL OR c.commercial_debt_xof > 0)
           AND (? IS NULL OR (LOWER(c.full_name) LIKE ?
                              OR LOWER(COALESCE(c.phone, '')) LIKE ?
                              OR LOWER(COALESCE(c.address, '')) LIKE ?))
         ORDER BY c.full_name ASC",
    )
    .bind(if include_inactive { None } else { Some(1_i64) })
    .bind(customer_type.clone())
    .bind(customer_type)
    .bind(if only_with_debt { Some(1_i64) } else { None::<i64> })
    .bind(search.clone())
    .bind(search.clone())
    .bind(search.clone())
    .bind(search)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, BOOL_CUSTOMERS))
}

pub async fn list_customers(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    list_customers_query(
        pool,
        like(input, "search"),
        json::opt_str(input, "customerType"),
        json::opt_bool(input, "onlyWithDebt").unwrap_or(false),
        json::opt_bool(input, "includeInactive").unwrap_or(false),
    )
    .await
}

async fn get_customer(pool: &SqlitePool, customer_id: &str) -> Result<Json, AppError> {
    let rows = list_customers_query(pool, None, None, false, true).await?;
    find(&rows, "id", customer_id)
        .cloned()
        .ok_or_else(|| not_found("Client introuvable."))
}

async fn list_customer_payments_query(
    pool: &SqlitePool,
    customer_id: Option<String>,
    sale_id: Option<String>,
) -> Result<Json, AppError> {
    let rows = sqlx::query(
        "SELECT p.id, p.payment_number,
                COALESCE(p.party_id, '') AS customer_id,
                COALESCE(c.full_name, 'Client comptoir') AS customer_name,
                p.payment_method, p.amount_xof, p.external_reference,
                pa.target_id AS sale_id, s.sale_number, p.user_id,
                COALESCE(e.full_name, u.username) AS user_name, p.created_at
         FROM payments p
         LEFT JOIN customers c ON c.id = p.party_id
         LEFT JOIN payment_allocations pa
                ON pa.payment_id = p.id AND pa.target_type = 'SALE'
         LEFT JOIN sales s ON s.id = pa.target_id
         JOIN users u ON u.id = p.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE p.party_type = 'CUSTOMER' AND p.direction = 'INBOUND'
           AND (? IS NULL OR p.party_id = ?)
           AND (? IS NULL OR pa.target_id = ?)
         ORDER BY p.created_at DESC, p.rowid DESC",
    )
    .bind(customer_id.clone())
    .bind(customer_id)
    .bind(sale_id.clone())
    .bind(sale_id)
    .fetch_all(pool)
    .await?;
    Ok(json::rows_to_json(rows, &[]))
}

pub async fn customer_statement(pool: &SqlitePool, input: &Json) -> Result<Json, AppError> {
    let customer_id = json::id_field(input)?;
    let customer = get_customer(pool, &customer_id).await?;
    let rows = sqlx::query(
        "SELECT id, sale_number, price_tier, subtotal_xof, discount_xof,
                consignment_total_xof, total_payable_xof, paid_amount_xof,
                credit_amount_xof, status, due_at,
                CASE WHEN status = 'VALIDATED' AND credit_amount_xof > 0
                          AND due_at IS NOT NULL
                          AND due_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     THEN 1 ELSE 0 END AS is_overdue,
                created_at
         FROM sales WHERE customer_id = ?
         ORDER BY created_at DESC, rowid DESC",
    )
    .bind(&customer_id)
    .fetch_all(pool)
    .await?;
    let sales = json::rows_to_json(rows, BOOL_SALES);
    let payments = list_customer_payments_query(pool, Some(customer_id), None).await?;
    Ok(json!({ "customer": customer, "sales": sales, "payments": payments }))
}

pub async fn create_customer(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let customer = validate_customer(input)?;
    let id = json::new_id();
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "INSERT INTO customers (
               id, full_name, customer_type, phone, email, address,
               credit_limit_xof, commercial_debt_xof, due_days, notes, is_active
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)",
        )
        .bind(&id)
        .bind(&customer.full_name)
        .bind(&customer.customer_type)
        .bind(&customer.phone)
        .bind(&customer.email)
        .bind(&customer.address)
        .bind(customer.credit_limit_xof)
        .bind(customer.due_days)
        .bind(&customer.notes)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "CUSTOMER_CREATED",
            "customers",
            &id,
            &json!({
                "fullName": customer.full_name, "customerType": customer.customer_type,
                "creditLimitXof": customer.credit_limit_xof
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
    get_customer(pool, &id).await
}

pub async fn update_customer(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let id = json::id_field(input)?;
    let _ = get_customer(pool, &id).await?;
    let customer = validate_customer(input)?;
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE customers
             SET full_name = ?, customer_type = ?, phone = ?, email = ?, address = ?,
                 credit_limit_xof = ?, due_days = ?, notes = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?",
        )
        .bind(&customer.full_name)
        .bind(&customer.customer_type)
        .bind(&customer.phone)
        .bind(&customer.email)
        .bind(&customer.address)
        .bind(customer.credit_limit_xof)
        .bind(customer.due_days)
        .bind(&customer.notes)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
        audit(
            &mut *tx,
            actor_user_id,
            "CUSTOMER_UPDATED",
            "customers",
            &id,
            &json!({
                "fullName": customer.full_name, "customerType": customer.customer_type,
                "creditLimitXof": customer.credit_limit_xof
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
    get_customer(pool, &id).await
}

pub async fn toggle_customer_active(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let id = json::id_field(input)?;
    let is_active = json::bool_field(input, "isActive")
        .map_err(|_| common::validation("Paramètre isActive invalide"))?;
    let customer = get_customer(pool, &id).await?;
    if !is_active && number(&customer, "commercialDebtXof") > 0 {
        return Err(conflict(
            "Impossible d'archiver un client ayant encore une créance commerciale non soldée.",
        ));
    }
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "UPDATE customers SET is_active = ?,
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
            if is_active { "CUSTOMER_RESTORED" } else { "CUSTOMER_ARCHIVED" },
            "customers",
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
    get_customer(pool, &id).await
}

pub async fn record_customer_payment(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<Json, AppError> {
    let customer_id = json::text_field(input, "customerId", 1, 80, "Client")?;
    let sale_id = json::opt_str(input, "saleId");
    let payment_method = json::enum_field(input, "paymentMethod", PAYMENT_METHODS)?;
    let amount_xof = json::positive_i64(input, "amountXof", "Montant encaissé")?;
    let external_reference = json::optional_text(input, "externalReference", 100, "Référence externe")?;

    let customer = get_customer(pool, &customer_id).await?;
    let debt = number(&customer, "commercialDebtXof");
    if debt <= 0 {
        return Err(conflict("Ce client n'a aucune créance commerciale en cours."));
    }
    if amount_xof > debt {
        return Err(common::validation(format!(
            "Montant supérieur à la créance commerciale due ({debt} FCFA)."
        )));
    }
    let customer_name = common::text(&customer, "fullName").unwrap_or_default();

    let payment_id = json::new_id();
    let payment_number = doc_number("ENC");
    let mut tx = pool.begin().await?;
    let result = async {
        let open_session: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM cash_sessions WHERE status = 'OPEN'
             ORDER BY opened_at DESC LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO payments (
               id, payment_number, direction, party_type, party_id,
               payment_method, amount_xof, external_reference, cash_session_id, user_id
             ) VALUES (?, ?, 'INBOUND', 'CUSTOMER', ?, ?, ?, ?, ?, ?)",
        )
        .bind(&payment_id)
        .bind(&payment_number)
        .bind(&customer_id)
        .bind(&payment_method)
        .bind(amount_xof)
        .bind(&external_reference)
        .bind(open_session.as_ref().map(|row| row.0.clone()))
        .bind(actor_user_id)
        .execute(&mut *tx)
        .await?;

        let mut remaining = amount_xof;
        let targets: Vec<(String, String, i64)> = if let Some(ref sale) = sale_id {
            let target: Option<(String, String, i64)> = sqlx::query_as(
                "SELECT id, sale_number, credit_amount_xof FROM sales
                 WHERE id = ? AND customer_id = ? AND status = 'VALIDATED'",
            )
            .bind(sale)
            .bind(&customer_id)
            .fetch_optional(&mut *tx)
            .await?;
            let target = target.ok_or_else(|| not_found("Vente à crédit introuvable pour ce client."))?;
            if amount_xof > target.2 {
                return Err(common::validation(format!(
                    "Le montant dépasse le reste à payer sur {} ({} FCFA).",
                    target.1, target.2
                )));
            }
            vec![target]
        } else {
            sqlx::query_as(
                "SELECT id, sale_number, credit_amount_xof FROM sales
                 WHERE customer_id = ? AND status = 'VALIDATED' AND credit_amount_xof > 0
                 ORDER BY created_at ASC, rowid ASC",
            )
            .bind(&customer_id)
            .fetch_all(&mut *tx)
            .await?
        };

        for sale in &targets {
            if remaining <= 0 {
                break;
            }
            let allocated = remaining.min(sale.2);
            if allocated <= 0 {
                continue;
            }
            sqlx::query(
                "INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
                 VALUES (?, ?, 'SALE', ?, ?)",
            )
            .bind(json::new_id())
            .bind(&payment_id)
            .bind(&sale.0)
            .bind(allocated)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE sales SET paid_amount_xof = paid_amount_xof + ?,
                     credit_amount_xof = credit_amount_xof - ?,
                     sync_version = sync_version + 1 WHERE id = ?",
            )
            .bind(allocated)
            .bind(allocated)
            .bind(&sale.0)
            .execute(&mut *tx)
            .await?;
            remaining -= allocated;
        }
        if remaining > 0 {
            return Err(conflict("Impossible d'allouer la totalité du règlement client."));
        }

        if payment_method == "CASH" {
            if let Some(ref session) = open_session {
                sqlx::query(
                    "INSERT INTO cash_movements (
                       id, cash_session_id, movement_type, amount_signed_xof,
                       reference_type, reference_id, description, user_id
                     ) VALUES (?, ?, 'DEBT_COLLECTION', ?, 'PAYMENT', ?, ?, ?)",
                )
                .bind(json::new_id())
                .bind(&session.0)
                .bind(amount_xof)
                .bind(&payment_id)
                .bind(format!("Recouvrement créance {customer_name} ({payment_number})"))
                .bind(actor_user_id)
                .execute(&mut *tx)
                .await?;
            }
        }

        let new_debt = recompute_commercial_debt(&mut *tx, &customer_id).await?;
        audit(
            &mut *tx,
            actor_user_id,
            "CUSTOMER_DEBT_PAYMENT",
            "payments",
            &payment_id,
            &json!({
                "customerId": customer_id, "amountXof": amount_xof,
                "paymentMethod": payment_method, "newDebtXof": new_debt
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
    let rows = list_customer_payments_query(pool, Some(customer_id), None).await?;
    find(&rows, "id", &payment_id)
        .cloned()
        .ok_or_else(|| conflict("Règlement client enregistré mais introuvable à la relecture."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_client_et_plafond() {
        let ok = serde_json::json!({
            "fullName": "Client Test", "customerType": "DETAILLANT",
            "creditLimitXof": 500_000, "dueDays": 15
        });
        let parsed = validate_customer(&ok).unwrap();
        assert_eq!(parsed.full_name, "Client Test");
        assert_eq!(parsed.credit_limit_xof, 500_000);
        assert_eq!(parsed.due_days, 15);
        assert!(validate_customer(&serde_json::json!({
            "fullName": "X", "customerType": "INCONNU",
            "creditLimitXof": 0, "dueDays": 0
        }))
        .is_err());
        assert!(validate_customer(&serde_json::json!({
            "fullName": "Client", "customerType": "AUTRE",
            "creditLimitXof": 0, "dueDays": 366
        }))
        .is_err());
    }

    #[test]
    fn dto_releve_et_bool() {
        let rows = json::rows_to_json(vec![], BOOL_SALES);
        assert_eq!(rows, json!([]));
    }
}
