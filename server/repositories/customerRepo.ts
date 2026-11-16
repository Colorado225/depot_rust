import crypto from 'node:crypto';
import type { DatabaseLike } from '../db/driver.ts';
import { assertNonNegativeXof } from '../domain/money.ts';
import { AppError } from '../error.ts';

export type CustomerType = 'PARTICULIER' | 'DETAILLANT' | 'REVENDEUR' | 'ENTREPRISE';

export type PaymentMethod =
  | 'CASH'
  | 'ORANGE_MONEY'
  | 'MTN_MOMO'
  | 'MOOV_MONEY'
  | 'WAVE'
  | 'BANK_TRANSFER';

export interface CustomerDTO {
  id: string;
  fullName: string;
  customerType: CustomerType;
  phone: string | null;
  email: string | null;
  address: string | null;
  creditLimitXof: number;
  commercialDebtXof: number;
  overdueDebtXof: number;
  consignmentBalanceXof: number;
  dueDays: number;
  notes: string | null;
  isActive: boolean;
  salesCount: number;
  totalPurchasedXof: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerPaymentDTO {
  id: string;
  paymentNumber: string;
  customerId: string;
  customerName: string;
  paymentMethod: PaymentMethod;
  amountXof: number;
  externalReference: string | null;
  saleId: string | null;
  saleNumber: string | null;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface CustomerSaleSummaryDTO {
  id: string;
  saleNumber: string;
  priceTier: 'WHOLESALE' | 'RETAIL';
  subtotalXof: number;
  discountXof: number;
  consignmentTotalXof: number;
  totalPayableXof: number;
  paidAmountXof: number;
  creditAmountXof: number;
  status: 'VALIDATED' | 'CANCELLED';
  dueAt: string | null;
  isOverdue: boolean;
  createdAt: string;
}

export interface CustomerStatementDTO {
  customer: CustomerDTO;
  sales: CustomerSaleSummaryDTO[];
  payments: CustomerPaymentDTO[];
}

export interface SaveCustomerInput {
  fullName: string;
  customerType: CustomerType;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  creditLimitXof: number;
  dueDays: number;
  notes?: string | null;
}

export interface RecordCustomerPaymentInput {
  customerId: string;
  saleId?: string | null;
  paymentMethod: PaymentMethod;
  amountXof: number;
  externalReference?: string | null;
}

export class CustomerRepository {
  constructor(private readonly db: DatabaseLike) {}

  private generatePaymentNumber(): string {
    const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
    const ts = Date.now().toString().slice(-6);
    return `ENC-${ts}-${rand}`;
  }

  recomputeCustomerCommercialDebt(customerId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(credit_amount_xof), 0) AS debtXof
         FROM sales
         WHERE customer_id = ? AND status = 'VALIDATED'`
      )
      .get(customerId) as { debtXof: number };

    const debtXof = Math.max(0, row.debtXof ?? 0);
    this.db
      .prepare(
        `UPDATE customers
         SET commercial_debt_xof = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             sync_version = sync_version + 1
         WHERE id = ?`
      )
      .run(debtXof, customerId);

    return debtXof;
  }

  listCustomers(
    filter: {
      search?: string;
      customerType?: string;
      onlyWithDebt?: boolean;
      includeInactive?: boolean;
    } = {}
  ): CustomerDTO[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (!filter.includeInactive) {
      clauses.push('c.is_active = 1');
    }
    if (filter.customerType) {
      clauses.push('c.customer_type = ?');
      params.push(filter.customerType);
    }
    if (filter.onlyWithDebt) {
      clauses.push('c.commercial_debt_xof > 0');
    }
    if (filter.search?.trim()) {
      const q = `%${filter.search.trim().toLowerCase()}%`;
      clauses.push(
        "(LOWER(c.full_name) LIKE ? OR LOWER(COALESCE(c.phone, '')) LIKE ? OR LOWER(COALESCE(c.address, '')) LIKE ?)"
      );
      params.push(q, q, q);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT c.id, c.full_name AS fullName, c.customer_type AS customerType,
                c.phone, c.email, c.address,
                c.credit_limit_xof AS creditLimitXof,
                c.commercial_debt_xof AS commercialDebtXof,
                c.due_days AS dueDays,
                c.notes, c.is_active AS isActive,
                c.created_at AS createdAt, c.updated_at AS updatedAt,
                COALESCE((
                  SELECT SUM(s.credit_amount_xof)
                  FROM sales s
                  WHERE s.customer_id = c.id
                    AND s.status = 'VALIDATED'
                    AND s.credit_amount_xof > 0
                    AND s.due_at IS NOT NULL
                    AND s.due_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ), 0) AS overdueDebtXof,
                COALESCE((
                  SELECT SUM(cb.deposit_value_xof)
                  FROM consignment_balances cb
                  WHERE cb.holder_type = 'CUSTOMER' AND cb.holder_id = c.id
                ), 0) AS consignmentBalanceXof,
                COALESCE((
                  SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'VALIDATED'
                ), 0) AS salesCount,
                COALESCE((
                  SELECT SUM(s.total_payable_xof) FROM sales s WHERE s.customer_id = c.id AND s.status = 'VALIDATED'
                ), 0) AS totalPurchasedXof
         FROM customers c
         ${whereSql}
         ORDER BY c.full_name ASC`
      )
      .all(...params) as Array<Omit<CustomerDTO, 'isActive'> & { isActive: number }>;

    return rows.map((r) => ({
      ...r,
      isActive: Boolean(r.isActive),
    }));
  }

  getCustomerById(customerId: string): CustomerDTO {
    const found = this.listCustomers({ includeInactive: true }).find((c) => c.id === customerId);
    if (!found) {
      throw new AppError('NOT_FOUND', 'Client introuvable.', 404);
    }
    return found;
  }

  createCustomer(actorUserId: string, input: SaveCustomerInput): CustomerDTO {
    const fullName = input.fullName.trim();
    if (fullName.length < 2) {
      throw new AppError('VALIDATION_ERROR', 'Le nom du client doit contenir au moins 2 caractères.', 400);
    }
    assertNonNegativeXof(input.creditLimitXof, 'Plafond de crédit');
    if (!Number.isInteger(input.dueDays) || input.dueDays < 0 || input.dueDays > 365) {
      throw new AppError('VALIDATION_ERROR', 'Le délai de règlement doit être entre 0 et 365 jours.', 400);
    }

    const id = crypto.randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO customers (
             id, full_name, customer_type, phone, email, address,
             credit_limit_xof, commercial_debt_xof, due_days, notes, is_active
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)`
        )
        .run(
          id,
          fullName,
          input.customerType,
          input.phone?.trim() || null,
          input.email?.trim() || null,
          input.address?.trim() || null,
          input.creditLimitXof,
          input.dueDays,
          input.notes?.trim() || null
        );

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CUSTOMER_CREATED', 'customers', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          id,
          JSON.stringify({ fullName, customerType: input.customerType, creditLimitXof: input.creditLimitXof })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getCustomerById(id);
  }

  updateCustomer(actorUserId: string, customerId: string, input: SaveCustomerInput): CustomerDTO {
    this.getCustomerById(customerId);
    const fullName = input.fullName.trim();
    if (fullName.length < 2) {
      throw new AppError('VALIDATION_ERROR', 'Le nom du client doit contenir au moins 2 caractères.', 400);
    }
    assertNonNegativeXof(input.creditLimitXof, 'Plafond de crédit');
    if (!Number.isInteger(input.dueDays) || input.dueDays < 0 || input.dueDays > 365) {
      throw new AppError('VALIDATION_ERROR', 'Le délai de règlement doit être entre 0 et 365 jours.', 400);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE customers
           SET full_name = ?, customer_type = ?, phone = ?, email = ?, address = ?,
               credit_limit_xof = ?, due_days = ?, notes = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(
          fullName,
          input.customerType,
          input.phone?.trim() || null,
          input.email?.trim() || null,
          input.address?.trim() || null,
          input.creditLimitXof,
          input.dueDays,
          input.notes?.trim() || null,
          customerId
        );

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CUSTOMER_UPDATED', 'customers', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          customerId,
          JSON.stringify({ fullName, customerType: input.customerType, creditLimitXof: input.creditLimitXof })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getCustomerById(customerId);
  }

  toggleCustomerActive(actorUserId: string, customerId: string, isActive: boolean): CustomerDTO {
    const existing = this.getCustomerById(customerId);
    if (!isActive && existing.commercialDebtXof > 0) {
      throw new AppError(
        'CONFLICT',
        'Impossible d’archiver un client ayant encore une créance commerciale non soldée.',
        409
      );
    }

    this.db
      .prepare(
        `UPDATE customers
         SET is_active = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             sync_version = sync_version + 1
         WHERE id = ?`
      )
      .run(isActive ? 1 : 0, customerId);

    this.db
      .prepare(
        `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
         VALUES (?, ?, ?, 'customers', ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        actorUserId,
        isActive ? 'CUSTOMER_RESTORED' : 'CUSTOMER_ARCHIVED',
        customerId,
        JSON.stringify({ isActive })
      );

    return this.getCustomerById(customerId);
  }

  listCustomerPayments(filter: { customerId?: string; saleId?: string } = {}): CustomerPaymentDTO[] {
    const clauses = ["p.party_type = 'CUSTOMER'", "p.direction = 'INBOUND'"];
    const params: string[] = [];

    if (filter.customerId) {
      clauses.push('p.party_id = ?');
      params.push(filter.customerId);
    }
    if (filter.saleId) {
      clauses.push('pa.target_id = ?');
      params.push(filter.saleId);
    }

    return this.db
      .prepare(
        `SELECT p.id, p.payment_number AS paymentNumber,
                COALESCE(p.party_id, '') AS customerId,
                COALESCE(c.full_name, 'Client comptoir') AS customerName,
                p.payment_method AS paymentMethod,
                p.amount_xof AS amountXof,
                p.external_reference AS externalReference,
                pa.target_id AS saleId,
                s.sale_number AS saleNumber,
                p.user_id AS userId,
                COALESCE(e.full_name, u.username) AS userName,
                p.created_at AS createdAt
         FROM payments p
         LEFT JOIN customers c ON c.id = p.party_id
         LEFT JOIN payment_allocations pa ON pa.payment_id = p.id AND pa.target_type = 'SALE'
         LEFT JOIN sales s ON s.id = pa.target_id
         JOIN users u ON u.id = p.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY p.created_at DESC, p.rowid DESC`
      )
      .all(...params) as unknown as CustomerPaymentDTO[];
  }

  getCustomerStatement(customerId: string): CustomerStatementDTO {
    const customer = this.getCustomerById(customerId);
    const sales = this.db
      .prepare(
        `SELECT id, sale_number AS saleNumber, price_tier AS priceTier,
                subtotal_xof AS subtotalXof, discount_xof AS discountXof,
                consignment_total_xof AS consignmentTotalXof,
                total_payable_xof AS totalPayableXof,
                paid_amount_xof AS paidAmountXof,
                credit_amount_xof AS creditAmountXof,
                status, due_at AS dueAt,
                CASE
                  WHEN status = 'VALIDATED'
                   AND credit_amount_xof > 0
                   AND due_at IS NOT NULL
                   AND due_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  THEN 1 ELSE 0
                END AS isOverdue,
                created_at AS createdAt
         FROM sales
         WHERE customer_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(customerId) as Array<Omit<CustomerSaleSummaryDTO, 'isOverdue'> & { isOverdue: number }>;

    const payments = this.listCustomerPayments({ customerId });

    return {
      customer,
      sales: sales.map((s) => ({ ...s, isOverdue: Boolean(s.isOverdue) })),
      payments,
    };
  }

  recordCustomerDebtPayment(
    actorUserId: string,
    input: RecordCustomerPaymentInput
  ): CustomerPaymentDTO {
    if (!Number.isInteger(input.amountXof) || input.amountXof <= 0) {
      throw new AppError('VALIDATION_ERROR', 'Le montant encaissé doit être strictement positif.', 400);
    }

    const customer = this.getCustomerById(input.customerId);
    if (customer.commercialDebtXof <= 0) {
      throw new AppError('CONFLICT', 'Ce client n’a aucune créance commerciale en cours.', 409);
    }
    if (input.amountXof > customer.commercialDebtXof) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Montant supérieur à la créance commerciale due (${customer.commercialDebtXof} FCFA).`,
        400
      );
    }

    const paymentId = crypto.randomUUID();
    const paymentNumber = this.generatePaymentNumber();
    const externalRef = input.externalReference?.trim() || null;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const openSession = this.db
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")
        .get() as { id: string } | undefined;

      this.db
        .prepare(
          `INSERT INTO payments (
             id, payment_number, direction, party_type, party_id,
             payment_method, amount_xof, external_reference, cash_session_id, user_id
           ) VALUES (?, ?, 'INBOUND', 'CUSTOMER', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          paymentId,
          paymentNumber,
          input.customerId,
          input.paymentMethod,
          input.amountXof,
          externalRef,
          openSession?.id ?? null,
          actorUserId
        );

      let remainingToAllocate = input.amountXof;
      let targetSales: Array<{ id: string; saleNumber: string; creditAmountXof: number }>;

      if (input.saleId) {
        const target = this.db
          .prepare(
            `SELECT id, sale_number AS saleNumber, credit_amount_xof AS creditAmountXof
             FROM sales
             WHERE id = ? AND customer_id = ? AND status = 'VALIDATED'`
          )
          .get(input.saleId, input.customerId) as
          | { id: string; saleNumber: string; creditAmountXof: number }
          | undefined;
        if (!target) {
          throw new AppError('NOT_FOUND', 'Vente à crédit introuvable pour ce client.', 404);
        }
        if (input.amountXof > target.creditAmountXof) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Le montant dépasse le reste à payer sur ${target.saleNumber} (${target.creditAmountXof} FCFA).`,
            400
          );
        }
        targetSales = [target];
      } else {
        targetSales = this.db
          .prepare(
            `SELECT id, sale_number AS saleNumber, credit_amount_xof AS creditAmountXof
             FROM sales
             WHERE customer_id = ? AND status = 'VALIDATED' AND credit_amount_xof > 0
             ORDER BY created_at ASC, rowid ASC`
          )
          .all(input.customerId) as Array<{
          id: string;
          saleNumber: string;
          creditAmountXof: number;
        }>;
      }

      for (const sale of targetSales) {
        if (remainingToAllocate <= 0) break;
        const allocated = Math.min(remainingToAllocate, sale.creditAmountXof);
        if (allocated <= 0) continue;

        this.db
          .prepare(
            `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
             VALUES (?, ?, 'SALE', ?, ?)`
          )
          .run(crypto.randomUUID(), paymentId, sale.id, allocated);

        this.db
          .prepare(
            `UPDATE sales
             SET paid_amount_xof = paid_amount_xof + ?,
                 credit_amount_xof = credit_amount_xof - ?,
                 sync_version = sync_version + 1
             WHERE id = ?`
          )
          .run(allocated, allocated, sale.id);

        remainingToAllocate -= allocated;
      }

      if (remainingToAllocate > 0) {
        throw new AppError('CONFLICT', 'Impossible d’allouer la totalité du règlement client.', 409);
      }

      if (input.paymentMethod === 'CASH' && openSession) {
        this.db
          .prepare(
            `INSERT INTO cash_movements (
               id, cash_session_id, movement_type, amount_signed_xof,
               reference_type, reference_id, description, user_id
             ) VALUES (?, ?, 'DEBT_COLLECTION', ?, 'PAYMENT', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            openSession.id,
            input.amountXof,
            paymentId,
            `Recouvrement créance ${customer.fullName} (${paymentNumber})`,
            actorUserId
          );
      }

      const newDebt = this.recomputeCustomerCommercialDebt(input.customerId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CUSTOMER_DEBT_PAYMENT', 'payments', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          paymentId,
          JSON.stringify({
            customerId: input.customerId,
            amountXof: input.amountXof,
            paymentMethod: input.paymentMethod,
            newDebtXof: newDebt,
          })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.listCustomerPayments({ customerId: input.customerId }).find(
      (p) => p.id === paymentId
    )!;
  }
}
