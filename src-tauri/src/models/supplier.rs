use crate::domain::money::XofAmount;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Catégorie métier d'un fournisseur du dépôt de boissons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[sqlx(type_name = "TEXT", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SupplierType {
    Brasserie,
    Distributeur,
    Importateur,
    Autre,
}

impl Default for SupplierType {
    fn default() -> Self {
        Self::Distributeur
    }
}

/// Modèle persistant d'un fournisseur (`suppliers`) avec séparation stricte entre :
/// - `solde_dettes_xof` (`balance_due_xof`) : dette commerciale liée aux réceptions non réglées ;
/// - `solde_consignes_xof` : valeur financière des emballages consignés détenus/dus vis-à-vis du fournisseur.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SupplierModel {
    pub id: String,
    pub name: String,
    pub supplier_type: SupplierType,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub address: Option<String>,
    pub tax_id: Option<String>,
    pub payment_terms_days: i64,
    /// Solde commercial dû au fournisseur en FCFA entiers (`suppliers.balance_due_xof`).
    #[sqlx(rename = "balance_due_xof")]
    pub solde_dettes_xof: i64,
    /// Solde net des consignes emballages (bouteilles/casiers) avec ce fournisseur en FCFA entiers.
    #[sqlx(default)]
    pub solde_consignes_xof: i64,
    pub notes: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
    pub sync_version: i64,
}

impl SupplierModel {
    /// Parse et retourne l'identifiant UUID v4 typé du fournisseur.
    pub fn parsed_id(&self) -> Result<Uuid, AppError> {
        Uuid::parse_str(&self.id)
            .map_err(|_| AppError::Database(sqlx::Error::Decode("UUID fournisseur invalide".into())))
    }

    /// Vérifie l'invariant financier entier sur les soldes du fournisseur.
    pub fn validate_balances(&self) -> Result<(), AppError> {
        XofAmount::non_negative(self.solde_dettes_xof)?;
        XofAmount::non_negative(self.solde_consignes_xof)?;
        Ok(())
    }
}

/// Position détaillée des emballages consignés par type pour un fournisseur (`consignment_balances`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SupplierConsignmentBalance {
    pub id: String,
    pub supplier_id: String,
    pub packaging_type_id: String,
    pub quantity: i64,
    pub deposit_value_xof: i64,
    pub updated_at: String,
}

/// Liaison N-N Produit <-> Fournisseur (`product_suppliers`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProductSupplierLink {
    pub id: String,
    pub product_id: String,
    pub supplier_id: String,
    pub supplier_sku: Option<String>,
    pub last_unit_cost_xof: i64,
    pub is_preferred: bool,
    pub created_at: String,
}

/// Charge utile de création / mise à jour d'un fournisseur depuis l'interface React.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSupplierInput {
    pub name: String,
    pub supplier_type: SupplierType,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub address: Option<String>,
    pub tax_id: Option<String>,
    pub payment_terms_days: i64,
    pub notes: Option<String>,
}

impl SaveSupplierInput {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().chars().count() < 2 {
            return Err(AppError::Validation(
                "La raison sociale du fournisseur doit contenir au moins 2 caractères.".into(),
            ));
        }
        if self.payment_terms_days < 0 || self.payment_terms_days > 365 {
            return Err(AppError::Validation(
                "Le délai de règlement doit être compris entre 0 et 365 jours.".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_supplier_model_serde_and_balances_separation() {
        let id = Uuid::new_v4().to_string();
        let supplier = SupplierModel {
            id: id.clone(),
            name: "SOLIBRA CI".into(),
            supplier_type: SupplierType::Brasserie,
            phone: Some("+225 27 21 00 00 00".into()),
            email: Some("commandes@solibra.ci".into()),
            address: Some("Zone 3 Treichville, Abidjan".into()),
            tax_id: Some("CI-ABJ-001".into()),
            payment_terms_days: 15,
            solde_dettes_xof: 120_000,
            solde_consignes_xof: 45_000,
            notes: None,
            is_active: true,
            created_at: "2026-11-15T10:00:00Z".into(),
            updated_at: "2026-11-15T10:00:00Z".into(),
            sync_version: 1,
        };

        assert!(supplier.parsed_id().is_ok());
        assert!(supplier.validate_balances().is_ok());

        let json = serde_json::to_string(&supplier).expect("Sérialisation fournisseur");
        assert!(json.contains("\"supplierType\":\"BRASSERIE\""));
        assert!(json.contains("\"soldeDettesXof\":120000"));
        assert!(json.contains("\"soldeConsignesXof\":45000"));

        let decoded: SupplierModel =
            serde_json::from_str(&json).expect("Désérialisation fournisseur");
        assert_eq!(decoded, supplier);
    }

    #[test]
    fn test_save_supplier_input_validation() {
        let bad_name = SaveSupplierInput {
            name: "A".into(),
            supplier_type: SupplierType::Autre,
            phone: None,
            email: None,
            address: None,
            tax_id: None,
            payment_terms_days: 0,
            notes: None,
        };
        assert!(bad_name.validate().is_err());

        let bad_terms = SaveSupplierInput {
            name: "Brassivoire".into(),
            supplier_type: SupplierType::Brasserie,
            phone: None,
            email: None,
            address: None,
            tax_id: None,
            payment_terms_days: -5,
            notes: None,
        };
        assert!(bad_terms.validate().is_err());
    }
}
