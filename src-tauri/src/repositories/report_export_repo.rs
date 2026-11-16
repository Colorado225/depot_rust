//! LOT 10 — Tranche 4, exports de rapports : port de `exportDataset()`
//! (`server/repositories/reportsRepo.ts`) et de `pdfExport.ts`.
//!
//! Après le retrait du sidecar Node, le desktop produit lui-même les fichiers
//! CSV/PDF : aucun octet ne transite par HTTP. Les six jeux de données, le BOM
//! UTF-8, le séparateur `;`, le nom de fichier, l'audit `REPORT_EXPORTED` et le
//! générateur PDF 1.4 sont repris à l'identique.

use crate::domain::pdf_export::{build_tabular_pdf, PdfColumn, PdfTableDocument};
use crate::error::AppError;
use crate::json::{self, Json};
use crate::repositories::common::{normalize_date, number, text};
use crate::repositories::reports_repo as reports;
use serde_json::Value;
use sqlx::SqlitePool;

const DATASETS: &[&str] = &[
    "margins",
    "sales",
    "receivables",
    "payables",
    "expenses",
    "consignments",
];

pub struct ExportedFile {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

fn format_xof_text(xof: i64) -> String {
    let negative = xof < 0;
    let digits = xof.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(' ');
        }
        grouped.push(ch);
    }
    if negative {
        format!("-{grouped} FCFA")
    } else {
        format!("{grouped} FCFA")
    }
}

fn tenths_to_percent(tenths: i64) -> String {
    let abs = tenths.abs();
    let sign = if tenths < 0 { "-" } else { "" };
    format!("{sign}{}.{}", abs / 10, abs % 10)
}

fn csv_cell(value: &str) -> String {
    if value.contains(';') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

struct Dataset {
    title: String,
    headers: Vec<String>,
    pdf_columns: Vec<PdfColumn>,
    raw_rows: Vec<Vec<String>>,
    pdf_rows: Vec<Vec<String>>,
    footer_lines: Vec<String>,
}

impl Dataset {
    fn new(title: &str) -> Self {
        Self {
            title: title.to_string(),
            headers: Vec::new(),
            pdf_columns: Vec::new(),
            raw_rows: Vec::new(),
            pdf_rows: Vec::new(),
            footer_lines: Vec::new(),
        }
    }
}

fn headers(items: &[&str]) -> Vec<String> {
    items.iter().map(|value| value.to_string()).collect()
}

async fn build_margins(pool: &SqlitePool, input: &Json) -> Result<Dataset, AppError> {
    let mut data = Dataset::new("Rapport Marges Réelles (CUMP) par Produit");
    data.headers = headers(&[
        "SKU", "Produit", "Catégorie", "Qté vendue (base)", "CA Brut (FCFA)",
        "Coût CUMP (FCFA)", "Marge Brute (FCFA)", "Taux Marge (%)",
        "Stock Actuel (base)", "Valorisation Stock CUMP (FCFA)",
    ]);
    data.pdf_columns = vec![
        PdfColumn::left("SKU", 12),
        PdfColumn::left("Produit", 24),
        PdfColumn::right("Qte", 7),
        PdfColumn::right("CA Brut", 15),
        PdfColumn::right("Cout CUMP", 15),
        PdfColumn::right("Marge", 15),
        PdfColumn::right("Taux", 7),
        PdfColumn::right("Val. Stock", 16),
    ];

    let rows = reports::product_margins(pool, input).await?;
    let mut sum_ca = 0_i64;
    let mut sum_cogs = 0_i64;
    let mut sum_margin = 0_i64;
    let mut sum_stock = 0_i64;
    let empty: Vec<Value> = Vec::new();
    for row in rows.as_array().unwrap_or(&empty) {
        let sku = text(row, "sku").unwrap_or_default();
        let name = text(row, "productName").unwrap_or_default();
        let category = text(row, "categoryName").unwrap_or_default();
        let qty = number(row, "qtySoldBase");
        let ca = number(row, "grossSalesXof");
        let cogs = number(row, "cogsXof");
        let margin = number(row, "grossMarginXof");
        let rate = number(row, "marginRateTenths");
        let stock = number(row, "currentStockBase");
        let valuation = number(row, "stockValuationCumpXof");
        sum_ca += ca;
        sum_cogs += cogs;
        sum_margin += margin;
        sum_stock += valuation;
        data.raw_rows.push(vec![
            sku.clone(), name.clone(), category, qty.to_string(), ca.to_string(),
            cogs.to_string(), margin.to_string(), tenths_to_percent(rate),
            stock.to_string(), valuation.to_string(),
        ]);
        data.pdf_rows.push(vec![
            sku, name, qty.to_string(), format_xof_text(ca), format_xof_text(cogs),
            format_xof_text(margin), format!("{}%", tenths_to_percent(rate)),
            format_xof_text(valuation),
        ]);
    }
    data.footer_lines.push(format!(
        "TOTAL CA Brut: {} | COGS CUMP: {} | Marge Brute: {} | Valorisation Stock: {}",
        format_xof_text(sum_ca), format_xof_text(sum_cogs),
        format_xof_text(sum_margin), format_xof_text(sum_stock)
    ));
    Ok(data)
}

async fn build_sales(pool: &SqlitePool, range: &Json) -> Result<Dataset, AppError> {
    let start = normalize_date(range, "startDate")?;
    let end = normalize_date(range, "endDate")?;
    let rows = sqlx::query(
        "SELECT s.sale_number AS saleNumber, s.created_at AS createdAt,
                COALESCE(c.full_name, 'Client comptoir') AS customerName, s.status,
                s.subtotal_xof AS subtotalXof, s.discount_xof AS discountXof,
                (s.subtotal_xof - s.discount_xof) AS netRevenueXof,
                COALESCE((SELECT SUM(si.base_qty * si.unit_cost_xof)
                          FROM sale_items si WHERE si.sale_id = s.id), 0) AS cogsXof,
                s.consignment_total_xof AS consignmentXof,
                s.paid_amount_xof AS paidXof, s.credit_amount_xof AS creditXof
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
         WHERE (? IS NULL OR substr(s.created_at, 1, 10) >= ?)
           AND (? IS NULL OR substr(s.created_at, 1, 10) <= ?)
         ORDER BY s.created_at DESC",
    )
    .bind(start.clone())
    .bind(start)
    .bind(end.clone())
    .bind(end)
    .fetch_all(pool)
    .await?;

    let mut data = Dataset::new("Journal des Ventes & Marges Réalisées");
    data.headers = headers(&[
        "N° Vente", "Date", "Client", "Statut", "CA Net Liquide (FCFA)",
        "Coût CUMP (FCFA)", "Marge (FCFA)", "Consignes (FCFA)",
        "Encaissé (FCFA)", "Crédit (FCFA)",
    ]);
    data.pdf_columns = vec![
        PdfColumn::left("N° Vente", 18),
        PdfColumn::left("Date", 10),
        PdfColumn::left("Client", 20),
        PdfColumn::left("Statut", 10),
        PdfColumn::right("CA Net", 14),
        PdfColumn::right("CUMP", 14),
        PdfColumn::right("Marge", 14),
        PdfColumn::right("Credit", 14),
    ];
    for row in rows {
        let dto = json::row_to_json(row, &[]);
        let sale_number = text(&dto, "saleNumber").unwrap_or_default();
        let created_at = text(&dto, "createdAt").unwrap_or_default();
        let date = created_at.chars().take(10).collect::<String>();
        let customer = text(&dto, "customerName").unwrap_or_default();
        let status = text(&dto, "status").unwrap_or_default();
        let net = number(&dto, "netRevenueXof");
        let cogs = number(&dto, "cogsXof");
        let consignment = number(&dto, "consignmentXof");
        let paid = number(&dto, "paidXof");
        let credit = number(&dto, "creditXof");
        data.raw_rows.push(vec![
            sale_number.clone(), date.clone(), customer.clone(), status.clone(),
            net.to_string(), cogs.to_string(), (net - cogs).to_string(),
            consignment.to_string(), paid.to_string(), credit.to_string(),
        ]);
        data.pdf_rows.push(vec![
            sale_number, date, customer, status, format_xof_text(net),
            format_xof_text(cogs), format_xof_text(net - cogs), format_xof_text(credit),
        ]);
    }
    Ok(data)
}

async fn build_receivables(pool: &SqlitePool) -> Result<Dataset, AppError> {
    let snap = reports::snapshot(pool).await?;
    let mut data = Dataset::new("État des Créances Clients & Consignes Détenues");
    data.headers = headers(&[
        "Client", "Téléphone", "Créance Commerciale (FCFA)", "Consignes Emballages (FCFA)",
    ]);
    data.pdf_columns = vec![
        PdfColumn::left("Client", 34),
        PdfColumn::left("Telephone", 18),
        PdfColumn::right("Creance Commerciale", 22),
        PdfColumn::right("Solde Consignes", 22),
    ];
    if let Some(rows) = snap.get("topDebtors").and_then(Value::as_array) {
        for row in rows {
            let name = text(row, "fullName").unwrap_or_default();
            let phone = text(row, "phone").unwrap_or_default();
            let debt = number(row, "commercialDebtXof");
            let consignment = number(row, "consignmentBalanceXof");
            data.raw_rows.push(vec![
                name.clone(), phone.clone(), debt.to_string(), consignment.to_string(),
            ]);
            data.pdf_rows.push(vec![
                name, if phone.is_empty() { "-".to_string() } else { phone },
                format_xof_text(debt), format_xof_text(consignment),
            ]);
        }
    }
    data.footer_lines.push(format!(
        "TOTAL Créances Commerciales: {} | TOTAL Consignes Clients: {}",
        format_xof_text(number(&snap, "totalCustomerReceivablesXof")),
        format_xof_text(number(&snap, "customerConsignmentValueXof"))
    ));
    Ok(data)
}

async fn build_payables(pool: &SqlitePool) -> Result<Dataset, AppError> {
    let snap = reports::snapshot(pool).await?;
    let mut data = Dataset::new("État des Dettes Fournisseurs");
    data.headers = headers(&["Fournisseur", "Téléphone", "Dette Commerciale Due (FCFA)"]);
    data.pdf_columns = vec![
        PdfColumn::left("Fournisseur", 42),
        PdfColumn::left("Telephone", 22),
        PdfColumn::right("Dette Due (FCFA)", 24),
    ];
    if let Some(rows) = snap.get("topCreditors").and_then(Value::as_array) {
        for row in rows {
            let name = text(row, "name").unwrap_or_default();
            let phone = text(row, "phone").unwrap_or_default();
            let due = number(row, "balanceDueXof");
            data.raw_rows.push(vec![name.clone(), phone.clone(), due.to_string()]);
            data.pdf_rows.push(vec![
                name, if phone.is_empty() { "-".to_string() } else { phone },
                format_xof_text(due),
            ]);
        }
    }
    data.footer_lines.push(format!(
        "TOTAL Dettes Fournisseurs: {}",
        format_xof_text(number(&snap, "totalSupplierPayablesXof"))
    ));
    Ok(data)
}

async fn build_expenses(pool: &SqlitePool, range: &Json) -> Result<Dataset, AppError> {
    let start = normalize_date(range, "startDate")?;
    let end = normalize_date(range, "endDate")?;
    let rows = sqlx::query(
        "SELECT ex.expense_date AS expenseDate, ec.name AS categoryName,
                ex.description, ex.payment_method AS paymentMethod,
                ex.receipt_reference AS receiptReference, ex.amount_xof AS amountXof
         FROM expenses ex JOIN expense_categories ec ON ec.id = ex.category_id
         WHERE (? IS NULL OR substr(ex.expense_date, 1, 10) >= ?)
           AND (? IS NULL OR substr(ex.expense_date, 1, 10) <= ?)
         ORDER BY ex.expense_date DESC, ex.created_at DESC",
    )
    .bind(start.clone())
    .bind(start)
    .bind(end.clone())
    .bind(end)
    .fetch_all(pool)
    .await?;

    let mut data = Dataset::new("Journal des Dépenses Opérationnelles");
    data.headers = headers(&[
        "Date", "Catégorie", "Description", "Mode", "Justificatif", "Montant (FCFA)",
    ]);
    data.pdf_columns = vec![
        PdfColumn::left("Date", 11),
        PdfColumn::left("Categorie", 22),
        PdfColumn::left("Description", 34),
        PdfColumn::left("Canal", 15),
        PdfColumn::left("Ref", 12),
        PdfColumn::right("Montant", 16),
    ];
    let mut total = 0_i64;
    for row in rows {
        let dto = json::row_to_json(row, &[]);
        let date = text(&dto, "expenseDate").unwrap_or_default();
        let category = text(&dto, "categoryName").unwrap_or_default();
        let description = text(&dto, "description").unwrap_or_default();
        let method = text(&dto, "paymentMethod").unwrap_or_default();
        let reference = text(&dto, "receiptReference").unwrap_or_default();
        let amount = number(&dto, "amountXof");
        total += amount;
        data.raw_rows.push(vec![
            date.clone(), category.clone(), description.clone(), method.clone(),
            reference.clone(), amount.to_string(),
        ]);
        data.pdf_rows.push(vec![
            date, category, description, method,
            if reference.is_empty() { "-".to_string() } else { reference },
            format_xof_text(amount),
        ]);
    }
    data.footer_lines
        .push(format!("TOTAL Dépenses: {}", format_xof_text(total)));
    Ok(data)
}

async fn build_consignments(pool: &SqlitePool) -> Result<Dataset, AppError> {
    let rows = sqlx::query(
        "SELECT cb.holder_type AS holderType,
                CASE
                  WHEN cb.holder_type = 'DEPOT' THEN 'Dépôt (Vides)'
                  WHEN cb.holder_type = 'CUSTOMER' THEN COALESCE(c.full_name, 'Client')
                  WHEN cb.holder_type = 'SUPPLIER' THEN COALESCE(s.name, 'Fournisseur')
                  ELSE cb.holder_id
                END AS holderName,
                pt.name AS packagingName, pt.kind AS packagingKind,
                cb.quantity, cb.deposit_value_xof AS depositValueXof
         FROM consignment_balances cb
         JOIN packaging_types pt ON pt.id = cb.packaging_type_id
         LEFT JOIN customers c ON cb.holder_type = 'CUSTOMER' AND c.id = cb.holder_id
         LEFT JOIN suppliers s ON cb.holder_type = 'SUPPLIER' AND s.id = cb.holder_id
         WHERE cb.quantity != 0
         ORDER BY cb.holder_type ASC, holderName ASC, pt.kind ASC",
    )
    .fetch_all(pool)
    .await?;

    let mut data = Dataset::new("État des Consignes & Emballages Vides");
    data.headers = headers(&[
        "Type Titulaire", "Titulaire", "Emballage", "Catégorie", "Quantité", "Valeur (FCFA)",
    ]);
    data.pdf_columns = vec![
        PdfColumn::left("Type", 10),
        PdfColumn::left("Titulaire", 30),
        PdfColumn::left("Emballage", 24),
        PdfColumn::left("Categorie", 10),
        PdfColumn::right("Qte", 8),
        PdfColumn::right("Valeur", 18),
    ];
    for row in rows {
        let dto = json::row_to_json(row, &[]);
        let holder_type = text(&dto, "holderType").unwrap_or_default();
        let holder_name = text(&dto, "holderName").unwrap_or_default();
        let packaging = text(&dto, "packagingName").unwrap_or_default();
        let kind = text(&dto, "packagingKind").unwrap_or_default();
        let quantity = number(&dto, "quantity");
        let value = number(&dto, "depositValueXof");
        data.raw_rows.push(vec![
            holder_type.clone(), holder_name.clone(), packaging.clone(), kind.clone(),
            quantity.to_string(), value.to_string(),
        ]);
        data.pdf_rows.push(vec![
            holder_type, holder_name, packaging, kind, quantity.to_string(),
            format_xof_text(value),
        ]);
    }
    Ok(data)
}

pub async fn export_dataset(
    pool: &SqlitePool,
    actor_user_id: &str,
    input: &Json,
) -> Result<ExportedFile, AppError> {
    let format = json::enum_field(input, "format", &["csv", "pdf"])?;
    let dataset = json::enum_field(input, "dataset", DATASETS)?;
    // Validation des dates avant toute requête (même contrat que les rapports).
    normalize_date(input, "startDate")?;
    normalize_date(input, "endDate")?;
    let start = json::opt_str(input, "startDate");
    let end = json::opt_str(input, "endDate");

    let data = match dataset.as_str() {
        "margins" => build_margins(pool, input).await?,
        "sales" => build_sales(pool, input).await?,
        "receivables" => build_receivables(pool).await?,
        "payables" => build_payables(pool).await?,
        "expenses" => build_expenses(pool, input).await?,
        _ => build_consignments(pool).await?,
    };

    let stamp = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let period_label = if start.is_some() || end.is_some() {
        format!(
            "Période : {} au {}",
            start.clone().unwrap_or_else(|| "Début".into()),
            end.clone().unwrap_or_else(|| "Aujourd’hui".into())
        )
    } else {
        "Période : Toutes les écritures".to_string()
    };

    sqlx::query(
        "INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, 'REPORT_EXPORTED', 'reports', ?, ?)",
    )
    .bind(json::new_id())
    .bind(actor_user_id)
    .bind(&dataset)
    .bind(serde_json::json!({
        "dataset": dataset, "format": format,
        "startDate": start, "endDate": end
    }).to_string())
    .execute(pool)
    .await?;

    if format == "csv" {
        let mut lines = vec![data
            .headers
            .iter()
            .map(|value| csv_cell(value))
            .collect::<Vec<_>>()
            .join(";")];
        for row in &data.raw_rows {
            lines.push(row.iter().map(|value| csv_cell(value)).collect::<Vec<_>>().join(";"));
        }
        let csv = format!("\u{FEFF}{}", lines.join("\r\n"));
        return Ok(ExportedFile {
            filename: format!("depotpro-{dataset}-{stamp}.csv"),
            mime_type: "text/csv; charset=utf-8".to_string(),
            bytes: csv.into_bytes(),
        });
    }

    let pdf = build_tabular_pdf(&PdfTableDocument {
        title: format!("DepotPro CI — {}", data.title),
        subtitle: period_label,
        generated_at: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        columns: data.pdf_columns,
        rows: data.pdf_rows,
        footer_lines: data.footer_lines,
    });
    Ok(ExportedFile {
        filename: format!("depotpro-{dataset}-{stamp}.pdf"),
        mime_type: "application/pdf".to_string(),
        bytes: pdf,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jeux_de_donnees_et_formats() {
        assert_eq!(DATASETS.len(), 6);
        assert!(DATASETS.contains(&"margins"));
        assert!(DATASETS.contains(&"consignments"));
    }

    #[test]
    fn formatage_csv_et_xof() {
        assert_eq!(format_xof_text(1_276_000), "1 276 000 FCFA");
        assert_eq!(format_xof_text(-2_500), "-2 500 FCFA");
        assert_eq!(csv_cell("a;b"), "\"a;b\"");
        assert_eq!(csv_cell("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_cell("simple"), "simple");
        assert_eq!(tenths_to_percent(250), "25.0");
        assert_eq!(tenths_to_percent(-495), "-49.5");
    }
}
