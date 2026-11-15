import { AppError } from '../error.ts';

/**
 * Montants financiers exclusivement en entiers XOF (FCFA).
 * Aucun calcul flottant n'est autorisé.
 */
export function assertXofInt(value: number, label = 'Montant'): number {
  if (!Number.isSafeInteger(value)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${label} doit être un entier sûr en FCFA (reçu : ${String(value)})`,
      400
    );
  }
  return value;
}

export function assertNonNegativeXof(value: number, label = 'Montant'): number {
  const safe = assertXofInt(value, label);
  if (safe < 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${label} ne peut pas être négatif (${safe} FCFA)`,
      400
    );
  }
  return safe;
}

export function assertPositiveXof(value: number, label = 'Montant'): number {
  const safe = assertXofInt(value, label);
  if (safe <= 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${label} doit être strictement positif (${safe} FCFA)`,
      400
    );
  }
  return safe;
}

export function addXof(a: number, b: number): number {
  const sa = assertXofInt(a, 'Opérande A');
  const sb = assertXofInt(b, 'Opérande B');
  const sum = sa + sb;
  if (!Number.isSafeInteger(sum)) {
    throw new AppError('VALIDATION_ERROR', 'Dépassement arithmétique XOF (addition)', 400);
  }
  return sum;
}

export function subXof(a: number, b: number): number {
  const sa = assertXofInt(a, 'Opérande A');
  const sb = assertXofInt(b, 'Opérande B');
  const diff = sa - sb;
  if (!Number.isSafeInteger(diff)) {
    throw new AppError('VALIDATION_ERROR', 'Dépassement arithmétique XOF (soustraction)', 400);
  }
  return diff;
}

export function mulXofQty(unitPriceXof: number, qty: number): number {
  const price = assertNonNegativeXof(unitPriceXof, 'Prix unitaire');
  if (!Number.isSafeInteger(qty) || qty < 0) {
    throw new AppError('VALIDATION_ERROR', `Quantité invalide : ${String(qty)}`, 400);
  }
  const prod = price * qty;
  if (!Number.isSafeInteger(prod)) {
    throw new AppError('VALIDATION_ERROR', 'Dépassement arithmétique XOF (multiplication)', 400);
  }
  return prod;
}
