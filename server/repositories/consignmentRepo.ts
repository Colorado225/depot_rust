import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mulXofQty } from '../domain/money.ts';
import { AppError } from '../error.ts';
import type { PaymentMethod } from './customerRepo.ts';

export type ConsignmentHolderType = 'DEPOT' | 'CUSTOMER' | 'SUPPLIER';
export type ConsignmentMovementType =
  | 'SALE_DEPOSIT'
  | 'CUSTOMER_RETURN'
  | 'REFUND'
  | 'EXCHANGE'
  | 'SUPPLIER_DEPOSIT'
  | 'SUPPLIER_RETURN'
  | 'BREAKAGE'
  | 'LOSS';

export const DEPOT_HOLDER_ID = 'DEPOT_MAIN';

export interface ConsignmentBalanceDTO {
  id: string;
  holderType: ConsignmentHolderType;
  holderId: string;
  holderName: string;
  packagingTypeId: string;
  packagingCode: string;
  packagingName: string;
  packagingKind: 'BOTTLE' | 'CRATE' | 'OTHER';
  depositAmountXof: number;
  quantity: number;
  depositValueXof: number;
  updatedAt: string;
}

export interface ConsignmentMovementDTO {
  id: string;
  packagingTypeId: string;
  packagingCode: string;
  packagingName: string;
  packagingKind: 'BOTTLE' | 'CRATE' | 'OTHER';
  movementType: ConsignmentMovementType;
  holderType: ConsignmentHolderType;
  holderId: string;
  holderName: string;
  quantityDelta: number;
  amountXof: number;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface ConsignmentSummaryDTO {
  depotBottlesQty: number;
  depotCratesQty: number;
  depotTotalValueXof: number;
  customerQty: number;
  customerValueXof: number;
  supplierQty: number;
  supplierValueXof: number;
}

export interface CustomerConsignmentReturnInput {
  customerId: string;
  packagingTypeId: string;
  quantity: number;
  refundCustomer: boolean;
  paymentMethod?: PaymentMethod;
  externalReference?: string | null;
  note?: string | null;
}

export interface CustomerConsignmentOperationInput {
  customerId: string;
  packagingTypeId: string;
  quantity: number;
  operation: 'SALE_DEPOSIT' | 'EXCHANGE' | 'BREAKAGE' | 'LOSS';
  note?: string | null;
}

export interface SupplierConsignmentOperationInput {
  supplierId: string;
  packagingTypeId: string;
  quantity: number;
  operation: 'SUPPLIER_DEPOSIT' | 'SUPPLIER_RETURN';
  note?: string | null;
}

export interface DepotPackagingOperationInput {
  packagingTypeId: string;
  quantity: number;
  operation: 'EXCHANGE' | 'BREAKAGE' | 'LOSS';
  note?: string | null;
}

export class ConsignmentRepository {
  constructor(private readonly db: DatabaseSync) {}

  private generatePaymentNumber(): string {
    const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
    const ts = Date.now().toString().slice(-6);
    return `RCONS-${ts}-${rand}`;
  }

  private getPackagingType(packagingTypeId: string) {
    const pkg = this.db
      .prepare(
        `SELECT id, code, name, kind, deposit_amount_xof AS depositAmountXof
         FROM packaging_types WHERE id = ?`
      )
      .get(packagingTypeId) as
      | {
          id: string;
          code: string;
          name: string;
          kind: 'BOTTLE' | 'CRATE' | 'OTHER';
          depositAmountXof: number;
        }
      | undefined;
    if (!pkg) {
      throw new AppError('NOT_FOUND', "Type d'emballage consigné introuvable.", 404);
    }
    return pkg;
  }

  private getHolderBalance(
    holderType: ConsignmentHolderType,
    holderId: string,
    packagingTypeId: string
  ): { id: string; quantity: number; depositValueXof: number } | undefined {
    return this.db
      .prepare(
        `SELECT id, quantity, deposit_value_xof AS depositValueXof
         FROM consignment_balances
         WHERE holder_type = ? AND holder_id = ? AND packaging_type_id = ?`
      )
      .get(holderType, holderId, packagingTypeId) as
      | { id: string; quantity: number; depositValueXof: number }
      | undefined;
  }

  private upsertHolderBalanceDelta(
    holderType: ConsignmentHolderType,
    holderId: string,
    packagingTypeId: string,
    qtyDelta: number,
    valueDeltaXof: number
  ) {
    const existing = this.getHolderBalance(holderType, holderId, packagingTypeId);
    const nextQty = (existing?.quantity ?? 0) + qtyDelta;
    const nextValue = Math.max(0, (existing?.depositValueXof ?? 0) + valueDeltaXof);

    if (nextQty < 0) {
      throw new AppError(
        'CONFLICT',
        `Solde d'emballages insuffisant (${existing?.quantity ?? 0} disponible, variation ${qtyDelta}).`,
        409
      );
    }

    if (existing) {
      this.db
        .prepare(
          `UPDATE consignment_balances
           SET quantity = ?,
               deposit_value_xof = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`
        )
        .run(nextQty, nextQty === 0 ? 0 : nextValue, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO consignment_balances (
             id, holder_type, holder_id, packaging_type_id, quantity, deposit_value_xof
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          holderType,
          holderId,
          packagingTypeId,
          nextQty,
          nextQty === 0 ? 0 : Math.max(0, valueDeltaXof)
        );
    }
  }

  getSummary(): ConsignmentSummaryDTO {
    const rows = this.db
      .prepare(
        `SELECT cb.holder_type AS holderType, pt.kind AS packagingKind,
                COALESCE(SUM(cb.quantity), 0) AS qty,
                COALESCE(SUM(cb.deposit_value_xof), 0) AS valueXof
         FROM consignment_balances cb
         JOIN packaging_types pt ON pt.id = cb.packaging_type_id
         GROUP BY cb.holder_type, pt.kind`
      )
      .all() as Array<{
      holderType: ConsignmentHolderType;
      packagingKind: 'BOTTLE' | 'CRATE' | 'OTHER';
      qty: number;
      valueXof: number;
    }>;

    const summary: ConsignmentSummaryDTO = {
      depotBottlesQty: 0,
      depotCratesQty: 0,
      depotTotalValueXof: 0,
      customerQty: 0,
      customerValueXof: 0,
      supplierQty: 0,
      supplierValueXof: 0,
    };

    for (const r of rows) {
      if (r.holderType === 'DEPOT') {
        if (r.packagingKind === 'BOTTLE') summary.depotBottlesQty += r.qty;
        if (r.packagingKind === 'CRATE') summary.depotCratesQty += r.qty;
        summary.depotTotalValueXof += r.valueXof;
      } else if (r.holderType === 'CUSTOMER') {
        summary.customerQty += r.qty;
        summary.customerValueXof += r.valueXof;
      } else if (r.holderType === 'SUPPLIER') {
        summary.supplierQty += r.qty;
        summary.supplierValueXof += r.valueXof;
      }
    }

    return summary;
  }

  listBalances(
    filter: {
      holderType?: ConsignmentHolderType;
      holderId?: string;
      kind?: 'BOTTLE' | 'CRATE' | 'OTHER';
      onlyNonZero?: boolean;
    } = {}
  ): ConsignmentBalanceDTO[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.holderType) {
      clauses.push('cb.holder_type = ?');
      params.push(filter.holderType);
    }
    if (filter.holderId) {
      clauses.push('cb.holder_id = ?');
      params.push(filter.holderId);
    }
    if (filter.kind) {
      clauses.push('pt.kind = ?');
      params.push(filter.kind);
    }
    if (filter.onlyNonZero) {
      clauses.push('cb.quantity != 0');
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    return this.db
      .prepare(
        `SELECT cb.id, cb.holder_type AS holderType, cb.holder_id AS holderId,
                CASE
                  WHEN cb.holder_type = 'DEPOT' THEN 'Dépôt (Emballages vides)'
                  WHEN cb.holder_type = 'CUSTOMER' THEN COALESCE(c.full_name, 'Client inconnu')
                  WHEN cb.holder_type = 'SUPPLIER' THEN COALESCE(s.name, 'Fournisseur inconnu')
                  ELSE cb.holder_id
                END AS holderName,
                cb.packaging_type_id AS packagingTypeId,
                pt.code AS packagingCode,
                pt.name AS packagingName,
                pt.kind AS packagingKind,
                pt.deposit_amount_xof AS depositAmountXof,
                cb.quantity,
                cb.deposit_value_xof AS depositValueXof,
                cb.updated_at AS updatedAt
         FROM consignment_balances cb
         JOIN packaging_types pt ON pt.id = cb.packaging_type_id
         LEFT JOIN customers c ON cb.holder_type = 'CUSTOMER' AND c.id = cb.holder_id
         LEFT JOIN suppliers s ON cb.holder_type = 'SUPPLIER' AND s.id = cb.holder_id
         ${whereSql}
         ORDER BY cb.holder_type ASC, holderName ASC, pt.kind ASC, pt.name ASC`
      )
      .all(...params) as unknown as ConsignmentBalanceDTO[];
  }

  listMovements(
    filter: {
      holderType?: ConsignmentHolderType;
      holderId?: string;
      packagingTypeId?: string;
      movementType?: ConsignmentMovementType;
      limit?: number;
    } = {}
  ): ConsignmentMovementDTO[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.holderType) {
      clauses.push('cm.holder_type = ?');
      params.push(filter.holderType);
    }
    if (filter.holderId) {
      clauses.push('cm.holder_id = ?');
      params.push(filter.holderId);
    }
    if (filter.packagingTypeId) {
      clauses.push('cm.packaging_type_id = ?');
      params.push(filter.packagingTypeId);
    }
    if (filter.movementType) {
      clauses.push('cm.movement_type = ?');
      params.push(filter.movementType);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitSql = filter.limit && filter.limit > 0 ? 'LIMIT ?' : 'LIMIT 150';
    if (filter.limit && filter.limit > 0) {
      params.push(filter.limit);
    }

    return this.db
      .prepare(
        `SELECT cm.id, cm.packaging_type_id AS packagingTypeId,
                pt.code AS packagingCode, pt.name AS packagingName, pt.kind AS packagingKind,
                cm.movement_type AS movementType,
                cm.holder_type AS holderType, cm.holder_id AS holderId,
                CASE
                  WHEN cm.holder_type = 'DEPOT' THEN 'Dépôt'
                  WHEN cm.holder_type = 'CUSTOMER' THEN COALESCE(c.full_name, 'Client comptoir')
                  WHEN cm.holder_type = 'SUPPLIER' THEN COALESCE(s.name, 'Fournisseur')
                  ELSE cm.holder_id
                END AS holderName,
                cm.quantity_delta AS quantityDelta,
                cm.amount_xof AS amountXof,
                cm.reference_type AS referenceType,
                cm.reference_id AS referenceId,
                cm.note,
                cm.user_id AS userId,
                COALESCE(e.full_name, u.username) AS userName,
                cm.created_at AS createdAt
         FROM consignment_movements cm
         JOIN packaging_types pt ON pt.id = cm.packaging_type_id
         LEFT JOIN customers c ON cm.holder_type = 'CUSTOMER' AND c.id = cm.holder_id
         LEFT JOIN suppliers s ON cm.holder_type = 'SUPPLIER' AND s.id = cm.holder_id
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         ${whereSql}
         ORDER BY cm.created_at DESC, cm.rowid DESC
         ${limitSql}`
      )
      .all(...params) as unknown as ConsignmentMovementDTO[];
  }

  recordCustomerReturn(
    actorUserId: string,
    input: CustomerConsignmentReturnInput
  ): {
    movementId: string;
    remainingCustomerQty: number;
    refundedAmountXof: number;
  } {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 'La quantité retournée doit être >= 1.', 400);
    }

    const pkg = this.getPackagingType(input.packagingTypeId);
    const customer = this.db
      .prepare('SELECT id, full_name AS fullName, is_active AS isActive FROM customers WHERE id = ?')
      .get(input.customerId) as { id: string; fullName: string; isActive: number } | undefined;

    if (!customer) {
      throw new AppError('NOT_FOUND', 'Client introuvable.', 404);
    }

    const customerBal = this.getHolderBalance('CUSTOMER', input.customerId, input.packagingTypeId);
    const heldQty = customerBal?.quantity ?? 0;
    if (input.quantity > heldQty) {
      throw new AppError(
        'CONFLICT',
        `Retour impossible : ${customer.fullName} détient ${heldQty} « ${pkg.name} », demandé ${input.quantity}.`,
        409
      );
    }

    const depositValueReturned = Math.min(
      customerBal?.depositValueXof ?? 0,
      mulXofQty(pkg.depositAmountXof, input.quantity)
    );
    const movementId = crypto.randomUUID();
    const refundAmountXof = input.refundCustomer ? depositValueReturned : 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 1) Décrémenter le solde client (emballages détenus)
      this.upsertHolderBalanceDelta(
        'CUSTOMER',
        input.customerId,
        input.packagingTypeId,
        -input.quantity,
        -depositValueReturned
      );

      // 2) Réintégrer les emballages vides dans le stock physique du dépôt
      this.upsertHolderBalanceDelta(
        'DEPOT',
        DEPOT_HOLDER_ID,
        input.packagingTypeId,
        input.quantity,
        depositValueReturned
      );

      // 3) Journaliser le retour client dans consignment_movements
      this.db
        .prepare(
          `INSERT INTO consignment_movements (
             id, packaging_type_id, movement_type, holder_type, holder_id,
             quantity_delta, amount_xof, reference_type, reference_id, note, user_id
           ) VALUES (?, ?, 'CUSTOMER_RETURN', 'CUSTOMER', ?, ?, ?, 'CONSIGNMENT', ?, ?, ?)`
        )
        .run(
          movementId,
          input.packagingTypeId,
          input.customerId,
          -input.quantity,
          depositValueReturned,
          movementId,
          input.note?.trim() || `Retour ${input.quantity} × ${pkg.name} (${customer.fullName})`,
          actorUserId
        );

      // 4) Si remboursement financier demandé : tracer REFUND + paiement OUTBOUND + caisse si CASH
      if (input.refundCustomer && refundAmountXof > 0) {
        const method = input.paymentMethod ?? 'CASH';
        const refundMovementId = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO consignment_movements (
               id, packaging_type_id, movement_type, holder_type, holder_id,
               quantity_delta, amount_xof, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, 'REFUND', 'CUSTOMER', ?, ?, ?, 'CONSIGNMENT_RETURN', ?, ?, ?)`
          )
          .run(
            refundMovementId,
            input.packagingTypeId,
            input.customerId,
            -input.quantity,
            refundAmountXof,
            movementId,
            `Remboursement consigne ${input.quantity} × ${pkg.name}`,
            actorUserId
          );

        const openSession = this.db
          .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")
          .get() as { id: string } | undefined;

        const paymentId = crypto.randomUUID();
        const payNum = this.generatePaymentNumber();
        this.db
          .prepare(
            `INSERT INTO payments (
               id, payment_number, direction, party_type, party_id,
               payment_method, amount_xof, external_reference, cash_session_id, user_id
             ) VALUES (?, ?, 'OUTBOUND', 'CUSTOMER', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            paymentId,
            payNum,
            input.customerId,
            method,
            refundAmountXof,
            input.externalReference?.trim() || null,
            openSession?.id ?? null,
            actorUserId
          );

        this.db
          .prepare(
            `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
             VALUES (?, ?, 'CONSIGNMENT_REFUND', ?, ?)`
          )
          .run(crypto.randomUUID(), paymentId, movementId, refundAmountXof);

        if (method === 'CASH' && openSession) {
          this.db
            .prepare(
              `INSERT INTO cash_movements (
                 id, cash_session_id, movement_type, amount_signed_xof,
                 reference_type, reference_id, description, user_id
               ) VALUES (?, ?, 'CONSIGNMENT_REFUND', ?, 'CONSIGNMENT_RETURN', ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              openSession.id,
              -refundAmountXof,
              movementId,
              `Remboursement consigne ${customer.fullName} (${payNum})`,
              actorUserId
            );
        }
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CONSIGNMENT_CUSTOMER_RETURN', 'consignment_movements', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          movementId,
          JSON.stringify({
            customerId: input.customerId,
            packagingTypeId: input.packagingTypeId,
            quantityReturned: input.quantity,
            refundedAmountXof: refundAmountXof,
          })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const updatedBal = this.getHolderBalance('CUSTOMER', input.customerId, input.packagingTypeId);
    return {
      movementId,
      remainingCustomerQty: updatedBal?.quantity ?? 0,
      refundedAmountXof: refundAmountXof,
    };
  }

  recordCustomerOperation(
    actorUserId: string,
    input: CustomerConsignmentOperationInput
  ): ConsignmentMovementDTO {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 'La quantité doit être >= 1.', 400);
    }
    const pkg = this.getPackagingType(input.packagingTypeId);
    const customer = this.db
      .prepare('SELECT id, full_name AS fullName FROM customers WHERE id = ?')
      .get(input.customerId) as { id: string; fullName: string } | undefined;
    if (!customer) {
      throw new AppError('NOT_FOUND', 'Client introuvable.', 404);
    }

    const valueXof = mulXofQty(pkg.depositAmountXof, input.quantity);
    const movementId = crypto.randomUUID();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      let qtyDelta = input.quantity;
      if (input.operation === 'SALE_DEPOSIT') {
        this.upsertHolderBalanceDelta(
          'CUSTOMER',
          input.customerId,
          input.packagingTypeId,
          input.quantity,
          valueXof
        );
      } else if (input.operation === 'EXCHANGE') {
        // Échange standard : pas de variation de solde net dû, mais entrée/sortie tracée
        const bal = this.getHolderBalance('DEPOT', DEPOT_HOLDER_ID, input.packagingTypeId);
        if ((bal?.quantity ?? 0) < input.quantity) {
          this.upsertHolderBalanceDelta(
            'DEPOT',
            DEPOT_HOLDER_ID,
            input.packagingTypeId,
            input.quantity,
            valueXof
          );
        }
      } else {
        // BREAKAGE / LOSS déclaré sur les emballages détenus par le client
        const bal = this.getHolderBalance('CUSTOMER', input.customerId, input.packagingTypeId);
        if ((bal?.quantity ?? 0) < input.quantity) {
          throw new AppError(
            'CONFLICT',
            `Solde client insuffisant pour imputer ${input.quantity} ${pkg.name}.`,
            409
          );
        }
        qtyDelta = -input.quantity;
        this.upsertHolderBalanceDelta(
          'CUSTOMER',
          input.customerId,
          input.packagingTypeId,
          -input.quantity,
          -valueXof
        );
      }

      this.db
        .prepare(
          `INSERT INTO consignment_movements (
             id, packaging_type_id, movement_type, holder_type, holder_id,
             quantity_delta, amount_xof, reference_type, reference_id, note, user_id
           ) VALUES (?, ?, ?, 'CUSTOMER', ?, ?, ?, 'CONSIGNMENT', ?, ?, ?)`
        )
        .run(
          movementId,
          input.packagingTypeId,
          input.operation,
          input.customerId,
          qtyDelta,
          input.operation === 'EXCHANGE' ? 0 : valueXof,
          movementId,
          input.note?.trim() || `${input.operation} · ${customer.fullName}`,
          actorUserId
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.listMovements({ limit: 50 }).find((m) => m.id === movementId)!;
  }

  recordSupplierOperation(
    actorUserId: string,
    input: SupplierConsignmentOperationInput
  ): ConsignmentMovementDTO {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 'La quantité doit être >= 1.', 400);
    }
    const pkg = this.getPackagingType(input.packagingTypeId);
    const supplier = this.db
      .prepare('SELECT id, name FROM suppliers WHERE id = ?')
      .get(input.supplierId) as { id: string; name: string } | undefined;
    if (!supplier) {
      throw new AppError('NOT_FOUND', 'Fournisseur introuvable.', 404);
    }

    const valueXof = mulXofQty(pkg.depositAmountXof, input.quantity);
    const movementId = crypto.randomUUID();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.operation === 'SUPPLIER_DEPOSIT') {
        // Réception d'emballages consignés appartenant au fournisseur (+dette emballage fournisseur, +vides au dépôt)
        this.upsertHolderBalanceDelta(
          'SUPPLIER',
          input.supplierId,
          input.packagingTypeId,
          input.quantity,
          valueXof
        );
        this.upsertHolderBalanceDelta(
          'DEPOT',
          DEPOT_HOLDER_ID,
          input.packagingTypeId,
          input.quantity,
          valueXof
        );
      } else {
        // SUPPLIER_RETURN : le dépôt rend des emballages vides au fournisseur
        const depotBal = this.getHolderBalance('DEPOT', DEPOT_HOLDER_ID, input.packagingTypeId);
        if ((depotBal?.quantity ?? 0) < input.quantity) {
          throw new AppError(
            'CONFLICT',
            `Stock d'emballages vides au dépôt insuffisant (${depotBal?.quantity ?? 0} dispo, demandé ${input.quantity}).`,
            409
          );
        }
        const supBal = this.getHolderBalance('SUPPLIER', input.supplierId, input.packagingTypeId);
        if ((supBal?.quantity ?? 0) < input.quantity) {
          throw new AppError(
            'CONFLICT',
            `Le dépôt doit seulement ${supBal?.quantity ?? 0} « ${pkg.name} » à ${supplier.name}.`,
            409
          );
        }
        this.upsertHolderBalanceDelta(
          'DEPOT',
          DEPOT_HOLDER_ID,
          input.packagingTypeId,
          -input.quantity,
          -valueXof
        );
        this.upsertHolderBalanceDelta(
          'SUPPLIER',
          input.supplierId,
          input.packagingTypeId,
          -input.quantity,
          -valueXof
        );
      }

      const qtyDelta = input.operation === 'SUPPLIER_DEPOSIT' ? input.quantity : -input.quantity;
      this.db
        .prepare(
          `INSERT INTO consignment_movements (
             id, packaging_type_id, movement_type, holder_type, holder_id,
             quantity_delta, amount_xof, reference_type, reference_id, note, user_id
           ) VALUES (?, ?, ?, 'SUPPLIER', ?, ?, ?, 'SUPPLIER_CONSIGNMENT', ?, ?, ?)`
        )
        .run(
          movementId,
          input.packagingTypeId,
          input.operation,
          input.supplierId,
          qtyDelta,
          valueXof,
          movementId,
          input.note?.trim() || `${input.operation} · ${supplier.name}`,
          actorUserId
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.listMovements({ limit: 50 }).find((m) => m.id === movementId)!;
  }

  recordDepotOperation(
    actorUserId: string,
    input: DepotPackagingOperationInput
  ): ConsignmentMovementDTO {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 'La quantité doit être >= 1.', 400);
    }
    const pkg = this.getPackagingType(input.packagingTypeId);
    const valueXof = mulXofQty(pkg.depositAmountXof, input.quantity);
    const movementId = crypto.randomUUID();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const qtyDelta = input.operation === 'EXCHANGE' ? input.quantity : -input.quantity;
      const valDelta = input.operation === 'EXCHANGE' ? valueXof : -valueXof;

      this.upsertHolderBalanceDelta(
        'DEPOT',
        DEPOT_HOLDER_ID,
        input.packagingTypeId,
        qtyDelta,
        valDelta
      );

      this.db
        .prepare(
          `INSERT INTO consignment_movements (
             id, packaging_type_id, movement_type, holder_type, holder_id,
             quantity_delta, amount_xof, reference_type, reference_id, note, user_id
           ) VALUES (?, ?, ?, 'DEPOT', ?, ?, ?, 'DEPOT_PACKAGING', ?, ?, ?)`
        )
        .run(
          movementId,
          input.packagingTypeId,
          input.operation,
          DEPOT_HOLDER_ID,
          qtyDelta,
          valueXof,
          movementId,
          input.note?.trim() || `Mouvement dépôt ${input.operation} (${pkg.name})`,
          actorUserId
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.listMovements({ limit: 50 }).find((m) => m.id === movementId)!;
  }
}
