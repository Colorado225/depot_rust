use crate::domain::money::XofAmount;
use crate::error::AppError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PackagingKind {
    Bottle,
    Crate,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagingType {
    pub id: String,
    pub code: String,
    pub name: String,
    pub kind: PackagingKind,
    pub deposit_amount_xof: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUnitConfig {
    pub unit_id: String,
    pub conversion_to_base: i64,
    pub wholesale_price_xof: i64,
    pub retail_price_xof: i64,
    pub barcode: Option<String>,
    pub is_default_sale_unit: bool,
}

/// Valide les règles métier de conversion par produit côté Rust.
/// La conversion n'est jamais supposée universelle et l'unité de base vaut toujours 1.
pub fn validate_product_units(
    base_unit_id: &str,
    units: &[ProductUnitConfig],
) -> Result<(), AppError> {
    if units.is_empty() {
        return Err(AppError::Validation(
            "Au moins une unité de vente doit être configurée pour le produit.".into(),
        ));
    }

    let mut seen_ids = std::collections::HashSet::new();
    for u in units {
        if !seen_ids.insert(u.unit_id.as_str()) {
            return Err(AppError::Validation(
                "Unité dupliquée sur le même produit.".into(),
            ));
        }
        if u.conversion_to_base < 1 {
            return Err(AppError::Validation(
                "Le facteur de conversion doit être >= 1.".into(),
            ));
        }
        if u.unit_id == base_unit_id && u.conversion_to_base != 1 {
            return Err(AppError::Validation(
                "L'unité de base doit avoir un facteur de conversion égal à 1.".into(),
            ));
        }
        XofAmount::non_negative(u.wholesale_price_xof)?;
        XofAmount::non_negative(u.retail_price_xof)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_per_product_unit_conversion_validation() {
        let valid = vec![
            ProductUnitConfig {
                unit_id: "unit-bottle".into(),
                conversion_to_base: 1,
                wholesale_price_xof: 400,
                retail_price_xof: 500,
                barcode: None,
                is_default_sale_unit: false,
            },
            ProductUnitConfig {
                unit_id: "unit-crate".into(),
                conversion_to_base: 24,
                wholesale_price_xof: 9600,
                retail_price_xof: 11500,
                barcode: Some("3299990000240".into()),
                is_default_sale_unit: true,
            },
        ];
        assert!(validate_product_units("unit-bottle", &valid).is_ok());

        // Conversion unité de base != 1 rejetée
        let bad_base = vec![ProductUnitConfig {
            unit_id: "unit-bottle".into(),
            conversion_to_base: 24,
            wholesale_price_xof: 9600,
            retail_price_xof: 11500,
            barcode: None,
            is_default_sale_unit: true,
        }];
        assert!(validate_product_units("unit-bottle", &bad_base).is_err());
    }
}
