import { assertNonNegativeXof } from './money.ts';
import { AppError } from '../error.ts';

/**
 * Calcule le Coût Moyen Pondéré (CUMP) en entiers XOF stricts via BigInt.
 * Aucun calcul flottant n'est utilisé.
 * Formule arrondie à l'entier FCFA le plus proche :
 *   CUMP = (stock_existant * cump_actuel + qte_entree * cout_unitaire_entree) / (stock_existant + qte_entree)
 */
export function computeWeightedAvgCostXof(
  existingQtyBase: number,
  currentCumpXof: number,
  incomingQtyBase: number,
  incomingUnitCostXof: number
): number {
  const safeExistingQty = assertNonNegativeXof(existingQtyBase, 'Stock existant');
  const safeCurrentCump = assertNonNegativeXof(currentCumpXof, 'CUMP actuel');
  const safeIncomingCost = assertNonNegativeXof(incomingUnitCostXof, "Coût unitaire d'entrée");

  if (!Number.isSafeInteger(incomingQtyBase) || incomingQtyBase <= 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      "La quantité d'entrée doit être un entier strictement positif.",
      400
    );
  }

  const totalQty = BigInt(safeExistingQty) + BigInt(incomingQtyBase);
  const numerator =
    BigInt(safeExistingQty) * BigInt(safeCurrentCump) +
    BigInt(incomingQtyBase) * BigInt(safeIncomingCost);

  // Arrondi entier au FCFA le plus proche sans flottant
  const rounded = (numerator + totalQty / 2n) / totalQty;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) {
    throw new AppError('VALIDATION_ERROR', 'Dépassement arithmétique lors du calcul CUMP.', 400);
  }
  return result;
}
