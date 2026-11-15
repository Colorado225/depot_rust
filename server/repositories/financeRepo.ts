import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertPositiveXof, assertNonNegativeXof } from '../domain/money.ts';
import { AppError } from '../error.ts';
import type { PaymentMethod } from './customerRepo.ts';

export type CashSessionStatus = 'OPEN' | 'CLOSED';

export type CashMovementType =
  | 'OPENING'
  | 'SALE_CASH'
  | 'DEBT_COLLECTION'
  | 'EXPENSE'
  | 'SUPPLIER_PAYMENT'
  | 'CONSIGNMENT_REFUND'
  | 'MANUAL_IN'
  | 'MANUAL_OUT'
  | 'CLOSING_ADJUSTMENT';

export const ALL_PAYMENT_METHODS: PaymentMethod[] = [
  'CASH',
  'ORANGE_MONEY',
  'MTN_MOMO',
  'MOOV_MONEY',
  'WAVE',
  'BANK_TRANSFER',
];

export interface CashRegisterDTO {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface ChannelReconciliationDTO {
  paymentMethod: PaymentMethod;
  inboundXof: number;
  outboundPaymentsXof: number;
  expensesXof: number;
  netXof: number;
  transactionCount: number;
}

export interface CashSessionDTO {
  id: string;
  cashRegisterId: string;
  registerCode: string;
  registerName: string;
  openedByUserId: string;
  openedByName: string;
  closedByUserId: string | null;
  closedByName: string | null;
  openingBalanceXof: number;
  cashInXof: number;
  cashOutXof: number;
  theoreticalClosingXof: number;
  declaredClosingXof: number | null;
  varianceXof: number | null;
  status: CashSessionStatus;
  openedAt: string;
  closedAt: string | null;
  notes: string | null;
  channels: ChannelReconciliationDTO[];
}

export interface CashMovementDTO {
  id: string;
  cashSessionId: string;
  movementType: CashMovementType;
  amountSignedXof: number;
  referenceType: string | null;
  referenceId: string | null;
  description: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface CashSessionDetailDTO {
  session: CashSessionDTO;
  movements: CashMovementDTO[];
}

export interface ExpenseCategoryDTO {
  id: string;
  name: string;
  description: string | null;
}

export interface ExpenseDTO {
  id: string;
  categoryId: string;
  categoryName: string;
  amountXof: number;
  paymentMethod: PaymentMethod;
  cashSessionId: string | null;
  receiptReference: string | null;
  description: string;
  expenseDate: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface TreasuryPaymentDTO {
  id: string;
  paymentNumber: string;
  direction: 'INBOUND' | 'OUTBOUND';
  partyType: 'CUSTOMER' | 'SUPPLIER';
  partyName: string;
  paymentMethod: PaymentMethod;
  amountXof: number;
  externalReference: string | null;
  cashSessionId: string | null;
  userName: string;
  createdAt: string;
}

export interface FinanceOverviewDTO {
  activeSession: CashSessionDTO | null;
  registers: CashRegisterDTO[];
  totalInboundXof: number;
  totalOutboundPaymentsXof: number;
  totalExpensesXof: number;
  netTreasuryXof: number;
  closedSessionsCount: number;
  cumulativeVarianceXof: number;
  channels: ChannelReconciliationDTO[];
}

export interface OpenCashSessionInput {
  cashRegisterId: string;
  openingBalanceXof: number;
  notes?: string | null;
}

export interface CloseCashSessionInput {
  declaredClosingXof: number;
  notes?: string | null;
}

export interface ManualCashMovementInput {
  cashSessionId: string;
  direction: 'IN' | 'OUT';
  amountXof: number;
  description: string;
}

export interface OverrideCashSessionInput {
  correctedDeclaredXof: number;
  justification: string;
}

export interface RecordExpenseInput {
  categoryId: string;
  amountXof: number;
  paymentMethod: PaymentMethod;
  receiptReference?: string | null;
  description: string;
  expenseDate?: string;
}

export class FinanceRepository {
  constructor(private readonly db: DatabaseSync) {}

  listRegisters(): CashRegisterDTO[] {
    const rows = this.db
      .prepare('SELECT id, code, name, is_active AS isActive FROM cash_registers ORDER BY code ASC')
      .all() as Array<{ id: string; code: string; name: string; isActive: number }>;

    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      isActive: r.isActive === 1,
    }));
  }

  private computeChannels(cashSessionId?: string): ChannelReconciliationDTO[] {
    const paymentWhere = cashSessionId ? 'WHERE cash_session_id = ?' : '';
    const paymentParams = cashSessionId ? [cashSessionId] : [];
    const paymentRows = this.db
      .prepare(
        `SELECT payment_method AS paymentMethod,
                direction,
                COALESCE(SUM(amount_xof), 0) AS totalXof,
                COUNT(*) AS txCount
         FROM payments
         ${paymentWhere}
         GROUP BY payment_method, direction`
      )
      .all(...paymentParams) as Array<{
      paymentMethod: PaymentMethod;
      direction: 'INBOUND' | 'OUTBOUND';
      totalXof: number;
      txCount: number;
    }>;

    const expenseWhere = cashSessionId ? 'WHERE cash_session_id = ?' : '';
    const expenseParams = cashSessionId ? [cashSessionId] : [];
    const expenseRows = this.db
      .prepare(
        `SELECT payment_method AS paymentMethod,
                COALESCE(SUM(amount_xof), 0) AS totalXof,
                COUNT(*) AS txCount
         FROM expenses
         ${expenseWhere}
         GROUP BY payment_method`
      )
      .all(...expenseParams) as Array<{
      paymentMethod: PaymentMethod;
      totalXof: number;
      txCount: number;
    }>;

    const map = new Map<PaymentMethod, ChannelReconciliationDTO>();
    for (const m of ALL_PAYMENT_METHODS) {
      map.set(m, {
        paymentMethod: m,
        inboundXof: 0,
        outboundPaymentsXof: 0,
        expensesXof: 0,
        netXof: 0,
        transactionCount: 0,
      });
    }

    for (const r of paymentRows) {
      const entry = map.get(r.paymentMethod);
      if (!entry) continue;
      if (r.direction === 'INBOUND') {
        entry.inboundXof += r.totalXof;
      } else {
        entry.outboundPaymentsXof += r.totalXof;
      }
      entry.transactionCount += r.txCount;
    }

    for (const e of expenseRows) {
      const entry = map.get(e.paymentMethod);
      if (!entry) continue;
      entry.expensesXof += e.totalXof;
      entry.transactionCount += e.txCount;
    }

    return ALL_PAYMENT_METHODS.map((m) => {
      const entry = map.get(m)!;
      entry.netXof = entry.inboundXof - entry.outboundPaymentsXof - entry.expensesXof;
      return entry;
    });
  }

  private hydrateSession(row: {
    id: string;
    cashRegisterId: string;
    registerCode: string;
    registerName: string;
    openedByUserId: string;
    openedByName: string;
    closedByUserId: string | null;
    closedByName: string | null;
    openingBalanceXof: number;
    theoreticalClosingXof: number | null;
    declaredClosingXof: number | null;
    varianceXof: number | null;
    status: CashSessionStatus;
    openedAt: string;
    closedAt: string | null;
    notes: string | null;
  }): CashSessionDTO {
    const movAgg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN movement_type NOT IN ('OPENING', 'CLOSING_ADJUSTMENT') AND amount_signed_xof > 0 THEN amount_signed_xof ELSE 0 END), 0) AS cashInXof,
           COALESCE(SUM(CASE WHEN movement_type NOT IN ('OPENING', 'CLOSING_ADJUSTMENT') AND amount_signed_xof < 0 THEN -amount_signed_xof ELSE 0 END), 0) AS cashOutXof,
           COALESCE(SUM(CASE WHEN movement_type != 'CLOSING_ADJUSTMENT' THEN amount_signed_xof ELSE 0 END), 0) AS computedTheoreticalXof
         FROM cash_movements
         WHERE cash_session_id = ?`
      )
      .get(row.id) as {
      cashInXof: number;
      cashOutXof: number;
      computedTheoreticalXof: number;
    };

    const theoretical =
      row.status === 'CLOSED' && row.theoreticalClosingXof !== null
        ? row.theoreticalClosingXof
        : movAgg.computedTheoreticalXof;

    return {
      ...row,
      cashInXof: movAgg.cashInXof,
      cashOutXof: movAgg.cashOutXof,
      theoreticalClosingXof: theoretical,
      channels: this.computeChannels(row.id),
    };
  }

  listSessions(limit = 30): CashSessionDTO[] {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    const rows = this.db
      .prepare(
        `SELECT cs.id,
                cs.cash_register_id AS cashRegisterId,
                cr.code AS registerCode,
                cr.name AS registerName,
                cs.opened_by_user_id AS openedByUserId,
                COALESCE(eo.full_name, uo.username) AS openedByName,
                cs.closed_by_user_id AS closedByUserId,
                COALESCE(ec.full_name, uc.username) AS closedByName,
                cs.opening_balance_xof AS openingBalanceXof,
                cs.theoretical_closing_xof AS theoreticalClosingXof,
                cs.declared_closing_xof AS declaredClosingXof,
                cs.variance_xof AS varianceXof,
                cs.status,
                cs.opened_at AS openedAt,
                cs.closed_at AS closedAt,
                cs.notes
         FROM cash_sessions cs
         JOIN cash_registers cr ON cr.id = cs.cash_register_id
         JOIN users uo ON uo.id = cs.opened_by_user_id
         LEFT JOIN employees eo ON eo.id = uo.employee_id
         LEFT JOIN users uc ON uc.id = cs.closed_by_user_id
         LEFT JOIN employees ec ON ec.id = uc.employee_id
         ORDER BY CASE WHEN cs.status = 'OPEN' THEN 0 ELSE 1 END, cs.opened_at DESC
         LIMIT ?`
      )
      .all(safeLimit) as Array<{
      id: string;
      cashRegisterId: string;
      registerCode: string;
      registerName: string;
      openedByUserId: string;
      openedByName: string;
      closedByUserId: string | null;
      closedByName: string | null;
      openingBalanceXof: number;
      theoreticalClosingXof: number | null;
      declaredClosingXof: number | null;
      varianceXof: number | null;
      status: CashSessionStatus;
      openedAt: string;
      closedAt: string | null;
      notes: string | null;
    }>;

    return rows.map((r) => this.hydrateSession(r));
  }

  getActiveSession(): CashSessionDTO | null {
    const open = this.db
      .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")
      .get() as { id: string } | undefined;
    if (!open) return null;
    return this.getSessionById(open.id);
  }

  getSessionById(sessionId: string): CashSessionDTO {
    const row = this.db
      .prepare(
        `SELECT cs.id,
                cs.cash_register_id AS cashRegisterId,
                cr.code AS registerCode,
                cr.name AS registerName,
                cs.opened_by_user_id AS openedByUserId,
                COALESCE(eo.full_name, uo.username) AS openedByName,
                cs.closed_by_user_id AS closedByUserId,
                COALESCE(ec.full_name, uc.username) AS closedByName,
                cs.opening_balance_xof AS openingBalanceXof,
                cs.theoretical_closing_xof AS theoreticalClosingXof,
                cs.declared_closing_xof AS declaredClosingXof,
                cs.variance_xof AS varianceXof,
                cs.status,
                cs.opened_at AS openedAt,
                cs.closed_at AS closedAt,
                cs.notes
         FROM cash_sessions cs
         JOIN cash_registers cr ON cr.id = cs.cash_register_id
         JOIN users uo ON uo.id = cs.opened_by_user_id
         LEFT JOIN employees eo ON eo.id = uo.employee_id
         LEFT JOIN users uc ON uc.id = cs.closed_by_user_id
         LEFT JOIN employees ec ON ec.id = uc.employee_id
         WHERE cs.id = ?`
      )
      .get(sessionId) as Parameters<FinanceRepository['hydrateSession']>[0] | undefined;

    if (!row) {
      throw new AppError('NOT_FOUND', 'Session de caisse introuvable.', 404);
    }
    return this.hydrateSession(row);
  }

  getSessionDetail(sessionId: string): CashSessionDetailDTO {
    const session = this.getSessionById(sessionId);
    const movements = this.db
      .prepare(
        `SELECT cm.id,
                cm.cash_session_id AS cashSessionId,
                cm.movement_type AS movementType,
                cm.amount_signed_xof AS amountSignedXof,
                cm.reference_type AS referenceType,
                cm.reference_id AS referenceId,
                cm.description,
                cm.user_id AS userId,
                COALESCE(e.full_name, u.username) AS userName,
                cm.created_at AS createdAt
         FROM cash_movements cm
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE cm.cash_session_id = ?
         ORDER BY cm.created_at DESC, cm.rowid DESC`
      )
      .all(sessionId) as unknown as CashMovementDTO[];

    return { session, movements };
  }

  openSession(actorUserId: string, input: OpenCashSessionInput): CashSessionDTO {
    const openingBalanceXof = assertNonNegativeXof(input.openingBalanceXof, 'Fond de caisse initial');

    const reg = this.db
      .prepare('SELECT id, name, is_active AS isActive FROM cash_registers WHERE id = ?')
      .get(input.cashRegisterId) as { id: string; name: string; isActive: number } | undefined;
    if (!reg || reg.isActive !== 1) {
      throw new AppError('NOT_FOUND', 'Caisse enregistreuse active introuvable.', 404);
    }

    const existingOpen = this.db
      .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' LIMIT 1")
      .get() as { id: string } | undefined;
    if (existingOpen) {
      throw new AppError(
        'CONFLICT',
        'Une session de caisse est déjà ouverte. Clôturez-la avant d’en ouvrir une nouvelle.',
        409
      );
    }

    const sessionId = crypto.randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO cash_sessions (
             id, cash_register_id, opened_by_user_id, opening_balance_xof, status, notes
           ) VALUES (?, ?, ?, ?, 'OPEN', ?)`
        )
        .run(
          sessionId,
          input.cashRegisterId,
          actorUserId,
          openingBalanceXof,
          input.notes?.trim() || null
        );

      this.db
        .prepare(
          `INSERT INTO cash_movements (
             id, cash_session_id, movement_type, amount_signed_xof,
             reference_type, reference_id, description, user_id
           ) VALUES (?, ?, 'OPENING', ?, 'CASH_SESSION', ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          sessionId,
          openingBalanceXof,
          sessionId,
          `Ouverture ${reg.name} — fond initial`,
          actorUserId
        );

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CASH_SESSION_OPENED', 'cash_sessions', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          sessionId,
          JSON.stringify({ cashRegisterId: input.cashRegisterId, openingBalanceXof })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getSessionById(sessionId);
  }

  recordManualMovement(actorUserId: string, input: ManualCashMovementInput): CashSessionDTO {
    const amountXof = assertPositiveXof(input.amountXof, 'Montant du mouvement de caisse');
    const cleanDesc = input.description.trim();
    if (cleanDesc.length < 3) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Un motif explicite (minimum 3 caractères) est requis pour un mouvement manuel.',
        400
      );
    }

    const session = this.getSessionById(input.cashSessionId);
    if (session.status !== 'OPEN') {
      throw new AppError('CONFLICT', 'Impossible d’ajouter un mouvement sur une session clôturée.', 409);
    }

    if (input.direction === 'OUT' && session.theoreticalClosingXof < amountXof) {
      throw new AppError(
        'CONFLICT',
        `Solde espèces théorique insuffisant (${session.theoreticalClosingXof} FCFA disponible, retrait demandé ${amountXof} FCFA).`,
        409
      );
    }

    const movementType: CashMovementType = input.direction === 'IN' ? 'MANUAL_IN' : 'MANUAL_OUT';
    const signedXof = input.direction === 'IN' ? amountXof : -amountXof;
    const movId = crypto.randomUUID();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO cash_movements (
             id, cash_session_id, movement_type, amount_signed_xof,
             reference_type, reference_id, description, user_id
           ) VALUES (?, ?, ?, ?, 'MANUAL', ?, ?, ?)`
        )
        .run(movId, session.id, movementType, signedXof, movId, cleanDesc, actorUserId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CASH_MANUAL_MOVEMENT', 'cash_movements', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          movId,
          JSON.stringify({ cashSessionId: session.id, movementType, amountXof, description: cleanDesc })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getSessionById(session.id);
  }

  closeSession(
    actorUserId: string,
    sessionId: string,
    input: CloseCashSessionInput
  ): CashSessionDTO {
    const declaredClosingXof = assertNonNegativeXof(
      input.declaredClosingXof,
      'Montant compté en caisse'
    );

    const current = this.getSessionById(sessionId);
    if (current.status !== 'OPEN') {
      throw new AppError('CONFLICT', 'Cette session de caisse est déjà clôturée.', 409);
    }

    const theoreticalClosingXof = current.theoreticalClosingXof;
    const varianceXof = declaredClosingXof - theoreticalClosingXof;
    const cleanNotes = input.notes?.trim() || null;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE cash_sessions
           SET status = 'CLOSED',
               closed_by_user_id = ?,
               theoretical_closing_xof = ?,
               declared_closing_xof = ?,
               variance_xof = ?,
               closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               notes = COALESCE(?, notes)
           WHERE id = ? AND status = 'OPEN'`
        )
        .run(
          actorUserId,
          theoreticalClosingXof,
          declaredClosingXof,
          varianceXof,
          cleanNotes,
          sessionId
        );

      if (varianceXof !== 0) {
        this.db
          .prepare(
            `INSERT INTO cash_movements (
               id, cash_session_id, movement_type, amount_signed_xof,
               reference_type, reference_id, description, user_id
             ) VALUES (?, ?, 'CLOSING_ADJUSTMENT', ?, 'CASH_SESSION', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            sessionId,
            varianceXof,
            sessionId,
            cleanNotes
              ? `Écart de clôture (${varianceXof > 0 ? '+' : ''}${varianceXof} FCFA) : ${cleanNotes}`
              : `Écart constaté à la clôture (${varianceXof > 0 ? '+' : ''}${varianceXof} FCFA)`,
            actorUserId
          );
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CASH_SESSION_CLOSED', 'cash_sessions', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          sessionId,
          JSON.stringify({
            theoreticalClosingXof,
            declaredClosingXof,
            varianceXof,
            notes: cleanNotes,
          })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getSessionById(sessionId);
  }

  overrideClosedSession(
    actorUserId: string,
    sessionId: string,
    input: OverrideCashSessionInput
  ): CashSessionDTO {
    const correctedDeclaredXof = assertNonNegativeXof(
      input.correctedDeclaredXof,
      'Nouveau montant compté corrigé'
    );
    const justification = input.justification.trim();
    if (justification.length < 5) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Une justification administrative détaillée (minimum 5 caractères) est requise.',
        400
      );
    }

    const current = this.getSessionById(sessionId);
    if (current.status !== 'CLOSED') {
      throw new AppError(
        'CONFLICT',
        'La correction administrative s’applique uniquement à une session déjà clôturée.',
        409
      );
    }

    const oldDeclared = current.declaredClosingXof ?? current.theoreticalClosingXof;
    const adjustmentDelta = correctedDeclaredXof - oldDeclared;
    const newVarianceXof = correctedDeclaredXof - current.theoreticalClosingXof;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE cash_sessions
           SET declared_closing_xof = ?,
               variance_xof = ?,
               notes = ?
           WHERE id = ?`
        )
        .run(
          correctedDeclaredXof,
          newVarianceXof,
          current.notes ? `${current.notes} | Rectif: ${justification}` : `Rectif: ${justification}`,
          sessionId
        );

      if (adjustmentDelta !== 0) {
        this.db
          .prepare(
            `INSERT INTO cash_movements (
               id, cash_session_id, movement_type, amount_signed_xof,
               reference_type, reference_id, description, user_id
             ) VALUES (?, ?, 'CLOSING_ADJUSTMENT', ?, 'CASH_OVERRIDE', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            sessionId,
            adjustmentDelta,
            sessionId,
            `Correction administrative clôture : ${justification}`,
            actorUserId
          );
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CASH_SESSION_OVERRIDE', 'cash_sessions', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          sessionId,
          JSON.stringify({
            previousDeclaredXof: oldDeclared,
            correctedDeclaredXof,
            newVarianceXof,
            justification,
          })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getSessionById(sessionId);
  }

  listExpenseCategories(): ExpenseCategoryDTO[] {
    return this.db
      .prepare('SELECT id, name, description FROM expense_categories ORDER BY name ASC')
      .all() as unknown as ExpenseCategoryDTO[];
  }

  createExpenseCategory(
    actorUserId: string,
    input: { name: string; description?: string | null }
  ): ExpenseCategoryDTO {
    const cleanName = input.name.trim();
    if (cleanName.length < 2) {
      throw new AppError('VALIDATION_ERROR', 'Nom de catégorie de dépense invalide.', 400);
    }

    const exists = this.db
      .prepare('SELECT id FROM expense_categories WHERE LOWER(name) = LOWER(?)')
      .get(cleanName);
    if (exists) {
      throw new AppError('CONFLICT', `La catégorie « ${cleanName} » existe déjà.`, 409);
    }

    const id = crypto.randomUUID();
    const desc = input.description?.trim() || null;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO expense_categories (id, name, description) VALUES (?, ?, ?)')
        .run(id, cleanName, desc);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'EXPENSE_CATEGORY_CREATED', 'expense_categories', ?, ?)`
        )
        .run(crypto.randomUUID(), actorUserId, id, JSON.stringify({ name: cleanName }));

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { id, name: cleanName, description: desc };
  }

  listExpenses(
    filter: {
      categoryId?: string;
      paymentMethod?: PaymentMethod;
      limit?: number;
    } = {}
  ): ExpenseDTO[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.categoryId) {
      clauses.push('ex.category_id = ?');
      params.push(filter.categoryId);
    }
    if (filter.paymentMethod) {
      clauses.push('ex.payment_method = ?');
      params.push(filter.paymentMethod);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitVal = Math.min(300, Math.max(1, Math.trunc(filter.limit ?? 150)));
    params.push(limitVal);

    return this.db
      .prepare(
        `SELECT ex.id,
                ex.category_id AS categoryId,
                ec.name AS categoryName,
                ex.amount_xof AS amountXof,
                ex.payment_method AS paymentMethod,
                ex.cash_session_id AS cashSessionId,
                ex.receipt_reference AS receiptReference,
                ex.description,
                ex.expense_date AS expenseDate,
                ex.user_id AS userId,
                COALESCE(e.full_name, u.username) AS userName,
                ex.created_at AS createdAt
         FROM expenses ex
         JOIN expense_categories ec ON ec.id = ex.category_id
         JOIN users u ON u.id = ex.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         ${whereSql}
         ORDER BY ex.expense_date DESC, ex.created_at DESC
         LIMIT ?`
      )
      .all(...params) as unknown as ExpenseDTO[];
  }

  recordExpense(actorUserId: string, input: RecordExpenseInput): ExpenseDTO {
    const amountXof = assertPositiveXof(input.amountXof, 'Montant de la dépense');
    const cleanDesc = input.description.trim();
    if (cleanDesc.length < 3) {
      throw new AppError(
        'VALIDATION_ERROR',
        'La description de la dépense doit comporter au moins 3 caractères.',
        400
      );
    }

    const category = this.db
      .prepare('SELECT id, name FROM expense_categories WHERE id = ?')
      .get(input.categoryId) as { id: string; name: string } | undefined;
    if (!category) {
      throw new AppError('NOT_FOUND', 'Catégorie de dépense introuvable.', 404);
    }

    const expenseDate =
      input.expenseDate?.trim() || new Date().toISOString().slice(0, 10);

    const openSession = this.db
      .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")
      .get() as { id: string } | undefined;

    if (input.paymentMethod === 'CASH' && openSession) {
      const currentSession = this.getSessionById(openSession.id);
      if (currentSession.theoreticalClosingXof < amountXof) {
        throw new AppError(
          'CONFLICT',
          `Espèces insuffisantes en caisse (${currentSession.theoreticalClosingXof} FCFA disponible, dépense ${amountXof} FCFA).`,
          409
        );
      }
    }

    const expenseId = crypto.randomUUID();
    const receiptRef = input.receiptReference?.trim() || null;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO expenses (
             id, category_id, amount_xof, payment_method, cash_session_id,
             receipt_reference, description, expense_date, user_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          expenseId,
          category.id,
          amountXof,
          input.paymentMethod,
          openSession?.id ?? null,
          receiptRef,
          cleanDesc,
          expenseDate,
          actorUserId
        );

      if (input.paymentMethod === 'CASH' && openSession) {
        this.db
          .prepare(
            `INSERT INTO cash_movements (
               id, cash_session_id, movement_type, amount_signed_xof,
               reference_type, reference_id, description, user_id
             ) VALUES (?, ?, 'EXPENSE', ?, 'EXPENSE', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            openSession.id,
            -amountXof,
            expenseId,
            `Dépense (${category.name}) : ${cleanDesc}`,
            actorUserId
          );
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'EXPENSE_RECORDED', 'expenses', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          expenseId,
          JSON.stringify({
            categoryId: category.id,
            amountXof,
            paymentMethod: input.paymentMethod,
            cashSessionId: openSession?.id ?? null,
          })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.listExpenses({ limit: 50 }).find((e) => e.id === expenseId)!;
  }

  listTreasuryPayments(
    filter: {
      paymentMethod?: PaymentMethod;
      direction?: 'INBOUND' | 'OUTBOUND';
      limit?: number;
    } = {}
  ): TreasuryPaymentDTO[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.paymentMethod) {
      clauses.push('p.payment_method = ?');
      params.push(filter.paymentMethod);
    }
    if (filter.direction) {
      clauses.push('p.direction = ?');
      params.push(filter.direction);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitVal = Math.min(300, Math.max(1, Math.trunc(filter.limit ?? 150)));
    params.push(limitVal);

    return this.db
      .prepare(
        `SELECT p.id,
                p.payment_number AS paymentNumber,
                p.direction,
                p.party_type AS partyType,
                CASE
                  WHEN p.party_type = 'CUSTOMER' THEN COALESCE(c.full_name, 'Client comptoir')
                  WHEN p.party_type = 'SUPPLIER' THEN COALESCE(s.name, 'Fournisseur')
                  ELSE 'Tiers'
                END AS partyName,
                p.payment_method AS paymentMethod,
                p.amount_xof AS amountXof,
                p.external_reference AS externalReference,
                p.cash_session_id AS cashSessionId,
                COALESCE(e.full_name, u.username) AS userName,
                p.created_at AS createdAt
         FROM payments p
         LEFT JOIN customers c ON p.party_type = 'CUSTOMER' AND c.id = p.party_id
         LEFT JOIN suppliers s ON p.party_type = 'SUPPLIER' AND s.id = p.party_id
         JOIN users u ON u.id = p.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         ${whereSql}
         ORDER BY p.created_at DESC, p.rowid DESC
         LIMIT ?`
      )
      .all(...params) as unknown as TreasuryPaymentDTO[];
  }

  getOverview(): FinanceOverviewDTO {
    const activeSession = this.getActiveSession();
    const registers = this.listRegisters();
    const channels = this.computeChannels();

    const totalInboundXof = channels.reduce((sum, c) => sum + c.inboundXof, 0);
    const totalOutboundPaymentsXof = channels.reduce((sum, c) => sum + c.outboundPaymentsXof, 0);
    const totalExpensesXof = channels.reduce((sum, c) => sum + c.expensesXof, 0);
    const netTreasuryXof = totalInboundXof - totalOutboundPaymentsXof - totalExpensesXof;

    const closedAgg = this.db
      .prepare(
        `SELECT COUNT(*) AS closedCount,
                COALESCE(SUM(variance_xof), 0) AS cumulativeVarianceXof
         FROM cash_sessions
         WHERE status = 'CLOSED'`
      )
      .get() as { closedCount: number; cumulativeVarianceXof: number };

    return {
      activeSession,
      registers,
      totalInboundXof,
      totalOutboundPaymentsXof,
      totalExpensesXof,
      netTreasuryXof,
      closedSessionsCount: closedAgg.closedCount,
      cumulativeVarianceXof: closedAgg.cumulativeVarianceXof,
      channels,
    };
  }
}
