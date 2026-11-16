//! LOT 10 — CUMP (Coût Unitaire Moyen Pondéré), port exact de
//! `server/domain/cump.ts` et `server/domain/money.ts`.
//!
//! Tous les calculs sont effectués en `i128` puis convertis en `i64` : aucun
//! flottant n'intervient dans un montant FCFA. L'arrondi reproduit **à
//! l'identique** la formule Node `(numerator + totalQty / 2n) / totalQty`,
//! où `totalQty / 2` est une division entière tronquée (et non l'arrondi au
//! plus proche mathématique). Reproduire cette formule est indispensable :
//! une divergence d'un seul FCFA désynchroniserait la valorisation du stock
//! entre le pont HTTP transitoire et le moteur Rust sur la même base SQLite.

use crate::error::AppError;
use crate::domain::money::XofAmount;

fn validation(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// Ramène un coût exprimé pour un conditionnement au coût de l'unité de base.
/// Port de `(BigInt(cost) + BigInt(conversion) / 2n) / BigInt(conversion)`.
pub fn base_unit_cost_xof(unit_cost_xof: i64, conversion_to_base: i64) -> Result<i64, AppError> {
    XofAmount::non_negative(unit_cost_xof)?;
    if conversion_to_base < 1 {
        return Err(validation(
            "Le facteur de conversion doit être un entier supérieur ou égal à 1.",
        ));
    }
    let divisor = i128::from(conversion_to_base);
    let rounded = (i128::from(unit_cost_xof) + divisor / 2) / divisor;
    i64::try_from(rounded).map_err(|_| validation("Dépassement arithmétique XOF (coût unitaire)"))
}

/// Calcule le nouveau CUMP après une entrée en stock, en FCFA entiers.
pub fn compute_weighted_avg_cost_xof(
    existing_qty_base: i64,
    current_cump_xof: i64,
    incoming_qty_base: i64,
    incoming_unit_cost_xof: i64,
) -> Result<i64, AppError> {
    XofAmount::non_negative(existing_qty_base)?;
    XofAmount::non_negative(current_cump_xof)?;
    XofAmount::non_negative(incoming_unit_cost_xof)?;
    if incoming_qty_base <= 0 {
        return Err(validation(
            "La quantité d'entrée doit être un entier strictement positif.",
        ));
    }

    let existing = i128::from(existing_qty_base);
    let incoming = i128::from(incoming_qty_base);
    let total_qty = existing + incoming;
    let numerator = existing * i128::from(current_cump_xof)
        + incoming * i128::from(incoming_unit_cost_xof);
    // Même arrondi que le BigInt de cump.ts : division entière de total_qty/2.
    let rounded = (numerator + total_qty / 2) / total_qty;
    i64::try_from(rounded).map_err(|_| validation("Dépassement arithmétique lors du calcul CUMP."))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vecteurs de parité : tests/lot10-rust-tranche2.test.ts recalcule ces
    // mêmes valeurs avec la fonction Node `computeWeightedAvgCostXof`.
    #[test]
    fn vecteurs_de_parite_cump_node() {
        assert_eq!(compute_weighted_avg_cost_xof(10, 1000, 5, 1300).unwrap(), 1100);
        assert_eq!(compute_weighted_avg_cost_xof(0, 0, 3, 999).unwrap(), 999);
        assert_eq!(compute_weighted_avg_cost_xof(7, 1250, 2, 2000).unwrap(), 1417);
        assert_eq!(compute_weighted_avg_cost_xof(1, 0, 1, 1).unwrap(), 1);
        assert_eq!(compute_weighted_avg_cost_xof(3, 100, 1, 101).unwrap(), 100);
        assert_eq!(compute_weighted_avg_cost_xof(2, 999, 3, 1001).unwrap(), 1000);
    }

    #[test]
    fn vecteurs_de_parite_cout_unite_base() {
        assert_eq!(base_unit_cost_xof(9600, 24).unwrap(), 400);
        assert_eq!(base_unit_cost_xof(1000, 3).unwrap(), 333);
        assert_eq!(base_unit_cost_xof(750, 1).unwrap(), 750);
        assert_eq!(base_unit_cost_xof(1, 2).unwrap(), 1);
    }

    #[test]
    fn refuse_quantites_et_montants_invalides() {
        assert!(compute_weighted_avg_cost_xof(1, 100, 0, 100).is_err());
        assert!(compute_weighted_avg_cost_xof(-1, 100, 1, 100).is_err());
        assert!(compute_weighted_avg_cost_xof(1, -100, 1, 100).is_err());
        assert!(base_unit_cost_xof(100, 0).is_err());
        assert!(base_unit_cost_xof(-1, 2).is_err());
    }
}
