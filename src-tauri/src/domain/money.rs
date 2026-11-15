use crate::error::AppError;
use serde::{Deserialize, Serialize};

/// Représente un montant entier strict en FCFA (XOF).
/// Aucun calcul flottant n'est autorisé sur les montants financiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct XofAmount(i64);

impl XofAmount {
    pub fn new(value: i64) -> Self {
        Self(value)
    }

    pub fn non_negative(value: i64) -> Result<Self, AppError> {
        if value < 0 {
            return Err(AppError::Validation(format!(
                "Un montant financier ne peut pas être négatif : {value} FCFA"
            )));
        }
        Ok(Self(value))
    }

    pub fn raw(self) -> i64 {
        self.0
    }

    pub fn checked_add(self, rhs: Self) -> Result<Self, AppError> {
        self.0
            .checked_add(rhs.0)
            .map(Self)
            .ok_or_else(|| AppError::Validation("Dépassement arithmétique XOF (addition)".into()))
    }

    pub fn checked_sub(self, rhs: Self) -> Result<Self, AppError> {
        self.0
            .checked_sub(rhs.0)
            .map(Self)
            .ok_or_else(|| AppError::Validation("Dépassement arithmétique XOF (soustraction)".into()))
    }

    pub fn checked_mul_qty(self, qty: i64) -> Result<Self, AppError> {
        if qty < 0 {
            return Err(AppError::Validation(
                "La quantité multipliée ne peut pas être négative".into(),
            ));
        }
        self.0
            .checked_mul(qty)
            .map(Self)
            .ok_or_else(|| AppError::Validation("Dépassement arithmétique XOF (multiplication)".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xof_integer_arithmetic() {
        let casier_price = XofAmount::non_negative(9_600).unwrap();
        let total = casier_price.checked_mul_qty(10).unwrap();
        assert_eq!(total.raw(), 96_000);

        let discount = XofAmount::non_negative(1_500).unwrap();
        let net = total.checked_sub(discount).unwrap();
        assert_eq!(net.raw(), 94_500);
    }

    #[test]
    fn test_xof_rejects_negative_and_overflow() {
        assert!(XofAmount::non_negative(-1).is_err());
        let max = XofAmount::new(i64::MAX);
        assert!(max.checked_add(XofAmount::new(1)).is_err());
    }
}
