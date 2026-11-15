use crate::domain::money::XofAmount;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Canaux de paiement supportés en Côte d'Ivoire (`expenses.payment_method` / `payments.payment_method`).
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

/// Compte de trésorerie général utilisé lorsqu'une dépense n'est pas prélevée dans un tiroir-caisse actif.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[sqlx(type_name = "TEXT", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GeneralTreasuryAccount {
    GeneralTreasury,
    OrangeMoneyAccount,
    MtnMomoAccount,
    MoovMoneyAccount,
    WaveAccount,
    BankAccount,
}

/// Statut d'une session de caisse (`cash_sessions.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[sqlx(type_name = "TEXT", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CashSessionStatus {
    Open,
    Closed,
}

/// Modèle persistant d'une catégorie de dépenses (`expense_categories`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseCategoryModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

impl ExpenseCategoryModel {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().chars().count() < 2 {
            return Err(AppError::Validation(
                "Le nom de la catégorie de dépense doit contenir au moins 2 caractères.".into(),
            ));
        }
        Ok(())
    }
}

/// Modèle persistant d'une caisse enregistreuse (`cash_registers`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CashRegisterModel {
    pub id: String,
    pub code: String,
    pub name: String,
    pub is_active: bool,
}

/// Modèle persistant d'une session de caisse (`cash_sessions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CashSessionModel {
    pub id: String,
    pub cash_register_id: String,
    pub opened_by_user_id: String,
    pub closed_by_user_id: Option<String>,
    pub opening_balance_xof: i64,
    pub theoretical_closing_xof: Option<i64>,
    pub declared_closing_xof: Option<i64>,
    pub variance_xof: Option<i64>,
    pub status: CashSessionStatus,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub notes: Option<String>,
}

/// Modèle persistant d'une dépense opérationnelle (`expenses`),
/// avec invariant de rattachement obligatoire soit à une session de caisse active (`cash_session_id`),
/// soit à un compte de trésorerie général (`treasury_account`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseModel {
    pub id: String,
    pub category_id: String,
    pub amount_xof: i64,
    pub payment_method: PaymentMethod,
    pub cash_session_id: Option<String>,
    #[sqlx(default)]
    pub treasury_account: Option<GeneralTreasuryAccount>,
    pub receipt_reference: Option<String>,
    pub description: String,
    pub expense_date: String,
    pub user_id: String,
    pub created_at: String,
    pub sync_version: i64,
}

impl ExpenseModel {
    /// Valide les invariants métier d'une dépense :
    /// 1. Montant strictement positif en FCFA entiers.
    /// 2. Rattachement obligatoire à une `cash_session_id` (UUID valide) OU à un `treasury_account` général.
    /// 3. Description explicite (min. 3 caractères) et date non vide.
    pub fn validate(&self) -> Result<(), AppError> {
        XofAmount::positive(self.amount_xof)?;
        if self.description.trim().chars().count() < 3 {
            return Err(AppError::Validation(
                "La description de la dépense doit contenir au moins 3 caractères.".into(),
            ));
        }
        if self.expense_date.trim().is_empty() {
            return Err(AppError::Validation(
                "La date de dépense est obligatoire.".into(),
            ));
        }
        validate_expense_funding_source(
            self.payment_method,
            self.cash_session_id.as_deref(),
            self.treasury_account,
        )?;
        Ok(())
    }
}

/// Charge utile d'ouverture d'une session de caisse (`open_cash_session`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCashSessionInput {
    pub cash_register_id: String,
    pub opening_balance_xof: i64,
    pub notes: Option<String>,
}

impl OpenCashSessionInput {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.cash_register_id.trim().is_empty() {
            return Err(AppError::Validation(
                "L'identifiant de la caisse enregistreuse est obligatoire.".into(),
            ));
        }
        XofAmount::non_negative(self.opening_balance_xof)?;
        Ok(())
    }
}

/// Charge utile d'enregistrement d'une dépense opérationnelle.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordExpenseInput {
    pub category_id: String,
    pub amount_xof: i64,
    pub payment_method: PaymentMethod,
    pub cash_session_id: Option<String>,
    pub treasury_account: Option<GeneralTreasuryAccount>,
    pub receipt_reference: Option<String>,
    pub description: String,
    pub expense_date: String,
}

impl RecordExpenseInput {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.category_id.trim().is_empty() {
            return Err(AppError::Validation(
                "La catégorie de dépense est obligatoire.".into(),
            ));
        }
        XofAmount::positive(self.amount_xof)?;
        if self.description.trim().chars().count() < 3 {
            return Err(AppError::Validation(
                "La description de la dépense doit contenir au moins 3 caractères.".into(),
            ));
        }
        if self.expense_date.trim().is_empty() {
            return Err(AppError::Validation(
                "La date de la dépense (YYYY-MM-DD) est obligatoire.".into(),
            ));
        }
        validate_expense_funding_source(
            self.payment_method,
            self.cash_session_id.as_deref(),
            self.treasury_account,
        )?;
        Ok(())
    }
}

/// Garantit qu'aucune dépense orpheline ne puisse exister sans source de trésorerie identifiée :
/// - Soit liée à une session de caisse active (`cash_session_id`),
/// - Soit imputée à un compte de trésorerie général (`treasury_account`).
/// - Si le règlement est en `CASH` sans `cash_session_id`, `GeneralTreasury` est obligatoire.
pub fn validate_expense_funding_source(
    payment_method: PaymentMethod,
    cash_session_id: Option<&str>,
    treasury_account: Option<GeneralTreasuryAccount>,
) -> Result<(), AppError> {
    let clean_session = cash_session_id.map(str::trim).filter(|s| !s.is_empty());

    if let Some(session_id) = clean_session {
        Uuid::parse_str(session_id).map_err(|_| {
            AppError::Validation("Identifiant UUID de session de caisse invalide.".into())
        })?;
        return Ok(());
    }

    match treasury_account {
        Some(GeneralTreasuryAccount::GeneralTreasury) => Ok(()),
        Some(_) if payment_method != PaymentMethod::Cash => Ok(()),
        Some(_) => Err(AppError::Validation(
            "Une dépense en espèces sans session de caisse active doit être imputée sur GENERAL_TREASURY."
                .into(),
        )),
        None => Err(AppError::Validation(
            "La dépense doit être liée soit à une session de caisse active (cashSessionId), soit à un compte de trésorerie général (treasuryAccount)."
                .into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expense_requires_active_session_or_general_treasury() {
        let orphan = RecordExpenseInput {
            category_id: "exp-transport".into(),
            amount_xof: 12_000,
            payment_method: PaymentMethod::Cash,
            cash_session_id: None,
            treasury_account: None,
            receipt_reference: None,
            description: "Carburant livraison".into(),
            expense_date: "2026-11-15".into(),
        };
        assert!(orphan.validate().is_err());

        let linked_to_session = RecordExpenseInput {
            cash_session_id: Some(Uuid::new_v4().to_string()),
            ..orphan.clone()
        };
        assert!(linked_to_session.validate().is_ok());

        let linked_to_general_treasury = RecordExpenseInput {
            cash_session_id: None,
            treasury_account: Some(GeneralTreasuryAccount::GeneralTreasury),
            ..orphan
        };
        assert!(linked_to_general_treasury.validate().is_ok());
    }

    #[test]
    fn test_expense_rejects_non_positive_amount() {
        let zero = RecordExpenseInput {
            category_id: "exp-other".into(),
            amount_xof: 0,
            payment_method: PaymentMethod::Wave,
            cash_session_id: None,
            treasury_account: Some(GeneralTreasuryAccount::WaveAccount),
            receipt_reference: None,
            description: "Achat fournitures".into(),
            expense_date: "2026-11-15".into(),
        };
        assert!(zero.validate().is_err());
    }
}
