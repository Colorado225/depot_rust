import crypto from 'node:crypto';
import type { DatabaseLike } from '../db/driver.ts';
import { assertNonNegativeXof, mulXofQty } from '../domain/money.ts';
import { AppError } from '../error.ts';
import { AuthRepository } from './authRepo.ts';
import { CustomerRepository, type PaymentMethod } from './customerRepo.ts';

export type PriceTier = 'WHOLESALE' | 'RETAIL';

export interface SaleItemDTO {
  id: string;
  saleId: string;
  productId: string;
  productSku: string;
  productName: string;
  unitId: string;
  unitName: string;
  baseUnitName: string;
  quantity: number;
  conversionToBase: number;
  baseQty: number;
  unitPriceXof: number;
  unitCostXof: number;
  lineTotalXof: number;
}

export interface SalePaymentDTO {
  id: string;
  paymentNumber: string;
  paymentMethod: PaymentMethod;
  amountXof: number;
  externalReference: string | null;
  createdAt: string;
}

export interface SaleDTO {
  id: string;
  saleNumber: string;
  idempotencyKey: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  priceTier: PriceTier;
  subtotalXof: number;
  discountXof: number;
  consignmentTotalXof: number;
  totalPayableXof: number;
  paidAmountXof: number;
  creditAmountXof: number;
  status: 'VALIDATED' | 'CANCELLED';
  dueAt: string | null;
  note: string | null;
  cancelledAt: string | null;
  cancelledByUserName: string | null;
  cancelReason: string | null;
  userId: string;
  userName: string;
  createdAt: string;
  items: SaleItemDTO[];
  payments: SalePaymentDTO[];
}

export interface CreateSaleLineInput {
  productId: string;
  unitId: string;
  quantity: number;
  applyConsignment?: boolean;
}

export interface CreateSalePaymentLineInput {
  paymentMethod: PaymentMethod;
  amountXof: number;
  externalReference?: string | null;
}

export interface CreateSaleInput {
  idempotencyKey: string;
  customerId?: string | null;
  priceTier: PriceTier;
  discountXof?: number;
  note?: string | null;
  items: CreateSaleLineInput[];
  payments: CreateSalePaymentLineInput[];
}

export class PosRepository {
  private readonly customerRepo: CustomerRepository;

  constructor(
    private readonly db: DatabaseLike,
    private readonly authRepo: AuthRepository
  ) {
    this.customerRepo = new CustomerRepository(db);
  }

  private generateDocNumber(prefix: string): string {
    const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
    const ts = Date.now().toString().slice(-6);
    return `${prefix}-${ts}-${rand}`;
  }

  listSales(
    filter: {
      search?: string;
      customerId?: string;
      status?: string;
      priceTier?: string;
      limit?: number;
    } = {}
  ): SaleDTO[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.customerId) {
      clauses.push('s.customer_id = ?');
      params.push(filter.customerId);
    }
    if (filter.status) {
      clauses.push('s.status = ?');
      params.push(filter.status);
    }
    if (filter.priceTier) {
      clauses.push('s.price_tier = ?');
      params.push(filter.priceTier);
    }
    if (filter.search?.trim()) {
      const q = `%${filter.search.trim().toLowerCase()}%`;
      clauses.push(
        "(LOWER(s.sale_number) LIKE ? OR LOWER(COALESCE(c.full_name, 'client comptoir')) LIKE ? OR LOWER(COALESCE(s.note, '')) LIKE ?)"
      );
      params.push(q, q, q);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitSql = filter.limit && filter.limit > 0 ? 'LIMIT ?' : 'LIMIT 150';
    if (filter.limit && filter.limit > 0) {
      params.push(filter.limit);
    }

    const rows = this.db
      .prepare(
        `SELECT s.id, s.sale_number AS saleNumber, s.idempotency_key AS idempotencyKey,
                s.customer_id AS customerId,
                COALESCE(c.full_name, 'Client comptoir') AS customerName,
                c.phone AS customerPhone,
                s.price_tier AS priceTier,
                s.subtotal_xof AS subtotalXof,
                s.discount_xof AS discountXof,
                s.consignment_total_xof AS consignmentTotalXof,
                s.total_payable_xof AS totalPayableXof,
                s.paid_amount_xof AS paidAmountXof,
                s.credit_amount_xof AS creditAmountXof,
                s.status,
                s.due_at AS dueAt,
                s.note,
                s.cancelled_at AS cancelledAt,
                COALESCE(ce.full_name, cu.username) AS cancelledByUserName,
                s.cancel_reason AS cancelReason,
                s.user_id AS userId,
                COALESCE(e.full_name, u.username) AS userName,
                s.created_at AS createdAt
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         JOIN users u ON u.id = s.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN users cu ON cu.id = s.cancelled_by_user_id
         LEFT JOIN employees ce ON ce.id = cu.employee_id
         ${whereSql}
         ORDER BY s.created_at DESC, s.rowid DESC
         ${limitSql}`
      )
      .all(...params) as Array<Omit<SaleDTO, 'items' | 'payments'>>;

    const itemsStmt = this.db.prepare(
      `SELECT si.id, si.sale_id AS saleId, si.product_id AS productId,
              p.sku AS productSku, p.name AS productName,
              si.unit_id AS unitId, un.name AS unitName, bu.name AS baseUnitName,
              si.quantity, si.conversion_to_base AS conversionToBase,
              si.base_qty AS baseQty, si.unit_price_xof AS unitPriceXof,
              si.unit_cost_xof AS unitCostXof, si.line_total_xof AS lineTotalXof
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       JOIN units un ON un.id = si.unit_id
       JOIN units bu ON bu.id = p.base_unit_id
       WHERE si.sale_id = ?
       ORDER BY p.name ASC`
    );

    const paymentsStmt = this.db.prepare(
      `SELECT p.id, p.payment_number AS paymentNumber, p.payment_method AS paymentMethod,
              pa.allocated_xof AS amountXof, p.external_reference AS externalReference,
              p.created_at AS createdAt
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
       WHERE pa.target_type = 'SALE' AND pa.target_id = ?
       ORDER BY p.created_at ASC`
    );

    return rows.map((row) => ({
      ...row,
      items: itemsStmt.all(row.id) as unknown as SaleItemDTO[],
      payments: paymentsStmt.all(row.id) as unknown as SalePaymentDTO[],
    }));
  }

  getSaleById(saleId: string): SaleDTO {
    const found = this.listSales({ limit: 500 }).find((s) => s.id === saleId);
    if (!found) {
      throw new AppError('NOT_FOUND', 'Vente introuvable.', 404);
    }
    return found;
  }

  createSale(actorUserId: string, input: CreateSaleInput): SaleDTO {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw new AppError('VALIDATION_ERROR', 'Clé d’idempotence POS invalide.', 400);
    }

    // RÈGLE 13 : Un double clic ne doit jamais créer deux ventes
    const existingSale = this.db
      .prepare('SELECT id FROM sales WHERE idempotency_key = ?')
      .get(idempotencyKey) as { id: string } | undefined;
    if (existingSale) {
      return this.getSaleById(existingSale.id);
    }

    if (!input.items || input.items.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'Le panier de vente est vide.', 400);
    }

    const discountXof = input.discountXof ?? 0;
    assertNonNegativeXof(discountXof, 'Remise');
    if (discountXof > 0 && !this.authRepo.hasPermission(actorUserId, 'pos.discount.apply')) {
      throw new AppError(
        'PERMISSION_DENIED',
        "Vous n'avez pas la permission d'appliquer une remise commerciale (pos.discount.apply).",
        403
      );
    }

    for (const pay of input.payments) {
      if (!Number.isInteger(pay.amountXof) || pay.amountXof <= 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Chaque ligne de paiement doit contenir un montant strictement positif en FCFA.',
          400
        );
      }
    }

    const saleId = crypto.randomUUID();
    const saleNumber = this.generateDocNumber('VNT');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const settings = this.db
        .prepare(
          'SELECT allow_negative_stock AS allowNegativeStock, default_consignment_policy AS defaultConsignmentPolicy FROM business_settings LIMIT 1'
        )
        .get() as { allowNegativeStock: number; defaultConsignmentPolicy: string } | undefined;

      const allowNegativeStock = Boolean(settings?.allowNegativeStock ?? 0);
      const defaultChargeConsignment =
        settings?.defaultConsignmentPolicy === 'AUTO_INCLUDE_CRATES';

      let customerRow:
        | {
            id: string;
            fullName: string;
            creditLimitXof: number;
            commercialDebtXof: number;
            dueDays: number;
            isActive: number;
          }
        | undefined;

      if (input.customerId) {
        customerRow = this.db
          .prepare(
            `SELECT id, full_name AS fullName, credit_limit_xof AS creditLimitXof,
                    commercial_debt_xof AS commercialDebtXof, due_days AS dueDays, is_active AS isActive
             FROM customers WHERE id = ?`
          )
          .get(input.customerId) as typeof customerRow;

        if (!customerRow || customerRow.isActive !== 1) {
          throw new AppError('NOT_FOUND', 'Client actif introuvable.', 404);
        }
      }

      const seenPairs = new Set<string>();
      let subtotalXof = 0;
      let consignmentTotalXof = 0;

      const preparedItems: Array<{
        id: string;
        productId: string;
        productName: string;
        unitId: string;
        unitCode: string;
        quantity: number;
        conversionToBase: number;
        baseQty: number;
        unitPriceXof: number;
        unitCostXof: number;
        lineTotalXof: number;
        bottlePackagingTypeId: string | null;
        bottleDepositXof: number;
        cratePackagingTypeId: string | null;
        crateDepositXof: number;
        applyConsignment: boolean;
      }> = [];

      // Cumul de sortie par produit pour vérifier le stock total demandé même si vendu en plusieurs unités (ex: 2 casiers + 3 bouteilles)
      const requestedBaseByProduct = new Map<string, { name: string; totalBase: number }>();

      for (const line of input.items) {
        const pairKey = `${line.productId}::${line.unitId}`;
        if (seenPairs.has(pairKey)) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Produit et conditionnement en double dans le panier ; ajustez directement la quantité.',
            400
          );
        }
        seenPairs.add(pairKey);

        if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
          throw new AppError('VALIDATION_ERROR', 'La quantité vendue doit être >= 1.', 400);
        }

        const productUnit = this.db
          .prepare(
            `SELECT p.id AS productId, p.name AS productName, p.is_active AS isActive,
                    p.weighted_avg_cost_xof AS weightedAvgCostXof,
                    p.bottle_packaging_type_id AS bottlePackagingTypeId,
                    COALESCE(bp.deposit_amount_xof, 0) AS bottleDepositXof,
                    p.crate_packaging_type_id AS cratePackagingTypeId,
                    COALESCE(cp.deposit_amount_xof, 0) AS crateDepositXof,
                    pu.conversion_to_base AS conversionToBase,
                    pu.wholesale_price_xof AS wholesalePriceXof,
                    pu.retail_price_xof AS retailPriceXof,
                    u.code AS unitCode
             FROM products p
             JOIN product_units pu ON pu.product_id = p.id AND pu.unit_id = ?
             JOIN units u ON u.id = pu.unit_id
             LEFT JOIN packaging_types bp ON bp.id = p.bottle_packaging_type_id
             LEFT JOIN packaging_types cp ON cp.id = p.crate_packaging_type_id
             WHERE p.id = ?`
          )
          .get(line.unitId, line.productId) as
          | {
              productId: string;
              productName: string;
              isActive: number;
              weightedAvgCostXof: number;
              bottlePackagingTypeId: string | null;
              bottleDepositXof: number;
              cratePackagingTypeId: string | null;
              crateDepositXof: number;
              conversionToBase: number;
              wholesalePriceXof: number;
              retailPriceXof: number;
              unitCode: string;
            }
          | undefined;

        if (!productUnit) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Produit ou conditionnement non configuré pour la vente.',
            400
          );
        }
        if (productUnit.isActive !== 1) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Le produit « ${productUnit.productName} » est archivé.`,
            400
          );
        }

        const baseQty = line.quantity * productUnit.conversionToBase;
        if (!Number.isSafeInteger(baseQty) || baseQty <= 0) {
          throw new AppError('VALIDATION_ERROR', 'Quantité de base invalide.', 400);
        }

        const unitPriceXof =
          input.priceTier === 'WHOLESALE'
            ? productUnit.wholesalePriceXof
            : productUnit.retailPriceXof;
        const lineTotalXof = mulXofQty(unitPriceXof, line.quantity);
        subtotalXof += lineTotalXof;

        const applyConsignment = line.applyConsignment ?? defaultChargeConsignment;
        if (applyConsignment) {
          if (productUnit.bottlePackagingTypeId && productUnit.bottleDepositXof > 0) {
            consignmentTotalXof += mulXofQty(productUnit.bottleDepositXof, baseQty);
          }
          if (
            productUnit.cratePackagingTypeId &&
            productUnit.crateDepositXof > 0 &&
            productUnit.unitCode === 'CASIER'
          ) {
            consignmentTotalXof += mulXofQty(productUnit.crateDepositXof, line.quantity);
          }
        }

        const prevReq = requestedBaseByProduct.get(line.productId);
        requestedBaseByProduct.set(line.productId, {
          name: productUnit.productName,
          totalBase: (prevReq?.totalBase ?? 0) + baseQty,
        });

        preparedItems.push({
          id: crypto.randomUUID(),
          productId: line.productId,
          productName: productUnit.productName,
          unitId: line.unitId,
          unitCode: productUnit.unitCode,
          quantity: line.quantity,
          conversionToBase: productUnit.conversionToBase,
          baseQty,
          unitPriceXof,
          unitCostXof: productUnit.weightedAvgCostXof,
          lineTotalXof,
          bottlePackagingTypeId: productUnit.bottlePackagingTypeId,
          bottleDepositXof: productUnit.bottleDepositXof,
          cratePackagingTypeId: productUnit.cratePackagingTypeId,
          crateDepositXof: productUnit.crateDepositXof,
          applyConsignment,
        });
      }

      if (discountXof > subtotalXof) {
        throw new AppError(
          'VALIDATION_ERROR',
          `La remise (${discountXof} FCFA) ne peut pas dépasser le sous-total marchandises (${subtotalXof} FCFA).`,
          400
        );
      }

      // RÈGLE 9 : Vérification stricte du stock disponible avant toute écriture
      for (const [productId, req] of requestedBaseByProduct.entries()) {
        const balanceRow = this.db
          .prepare('SELECT quantity_base AS quantityBase FROM stock_balances WHERE product_id = ?')
          .get(productId) as { quantityBase: number } | undefined;
        const available = balanceRow?.quantityBase ?? 0;
        if (!allowNegativeStock && available < req.totalBase) {
          throw new AppError(
            'INSUFFICIENT_STOCK',
            `Stock insuffisant pour « ${req.name} » : disponible ${available}, demandé ${req.totalBase}.`,
            409
          );
        }
      }

      const totalPayableXof = subtotalXof - discountXof + consignmentTotalXof;
      const paidAmountXof = input.payments.reduce((acc, p) => acc + p.amountXof, 0);

      if (paidAmountXof > totalPayableXof) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Le total encaissé (${paidAmountXof} FCFA) dépasse le net à payer (${totalPayableXof} FCFA).`,
          400
        );
      }

      const creditAmountXof = totalPayableXof - paidAmountXof;
      if (creditAmountXof > 0) {
        if (!customerRow) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Sélectionnez un client enregistré pour enregistrer une vente à crédit.',
            400
          );
        }
        const projectedDebt = customerRow.commercialDebtXof + creditAmountXof;
        if (projectedDebt > customerRow.creditLimitXof) {
          throw new AppError(
            'CONFLICT',
            `Plafond de crédit dépassé pour ${customerRow.fullName} : dette projetée ${projectedDebt} FCFA > plafond ${customerRow.creditLimitXof} FCFA.`,
            409
          );
        }
      }

      const openSession = this.db
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")
        .get() as { id: string } | undefined;

      const dueAt =
        creditAmountXof > 0 && customerRow
          ? new Date(Date.now() + customerRow.dueDays * 86_400_000).toISOString()
          : null;

      this.db
        .prepare(
          `INSERT INTO sales (
             id, sale_number, idempotency_key, customer_id, cash_session_id, price_tier,
             subtotal_xof, discount_xof, consignment_total_xof, total_payable_xof,
             paid_amount_xof, credit_amount_xof, status, due_at, note, user_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALIDATED', ?, ?, ?)`
        )
        .run(
          saleId,
          saleNumber,
          idempotencyKey,
          customerRow?.id ?? null,
          openSession?.id ?? null,
          input.priceTier,
          subtotalXof,
          discountXof,
          consignmentTotalXof,
          totalPayableXof,
          paidAmountXof,
          creditAmountXof,
          dueAt,
          input.note?.trim() || null,
          actorUserId
        );

      for (const item of preparedItems) {
        this.db
          .prepare(
            `INSERT INTO sale_items (
               id, sale_id, product_id, unit_id, quantity, conversion_to_base,
               base_qty, unit_price_xof, unit_cost_xof, line_total_xof
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            item.id,
            saleId,
            item.productId,
            item.unitId,
            item.quantity,
            item.conversionToBase,
            item.baseQty,
            item.unitPriceXof,
            item.unitCostXof,
            item.lineTotalXof
          );

        const currentBal = this.db
          .prepare(
            'SELECT quantity_base AS quantityBase, damaged_quantity_base AS damagedQuantityBase FROM stock_balances WHERE product_id = ?'
          )
          .get(item.productId) as
          | { quantityBase: number; damagedQuantityBase: number }
          | undefined;

        const nextBalanceBase = (currentBal?.quantityBase ?? 0) - item.baseQty;
        if (!allowNegativeStock && nextBalanceBase < 0) {
          throw new AppError(
            'INSUFFICIENT_STOCK',
            `Stock insuffisant pour « ${item.productName} ».`,
            409
          );
        }

        this.db
          .prepare(
            `INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
             VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(product_id) DO UPDATE SET
               quantity_base = excluded.quantity_base,
               updated_at = excluded.updated_at`
          )
          .run(item.productId, nextBalanceBase, currentBal?.damagedQuantityBase ?? 0);

        this.db
          .prepare(
            `INSERT INTO stock_movements (
               id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
               balance_after_base, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, 'SALE', ?, ?, ?, 'SALE', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            item.productId,
            -item.baseQty,
            item.unitCostXof,
            nextBalanceBase,
            saleId,
            `Vente ${saleNumber} (${item.quantity} ${item.unitCode})`,
            actorUserId
          );

        if (item.applyConsignment) {
          const holderType = customerRow ? 'CUSTOMER' : 'DEPOT';
          const holderId = customerRow ? customerRow.id : 'COMPTOIR';
          if (item.bottlePackagingTypeId && item.bottleDepositXof > 0) {
            const depAmount = mulXofQty(item.bottleDepositXof, item.baseQty);
            this.recordSaleConsignmentDelta(
              item.bottlePackagingTypeId,
              holderType,
              holderId,
              item.baseQty,
              depAmount,
              saleId,
              `Consigne bouteilles vente ${saleNumber}`,
              actorUserId
            );
          }
          if (
            item.cratePackagingTypeId &&
            item.crateDepositXof > 0 &&
            item.unitCode === 'CASIER'
          ) {
            const depAmount = mulXofQty(item.crateDepositXof, item.quantity);
            this.recordSaleConsignmentDelta(
              item.cratePackagingTypeId,
              holderType,
              holderId,
              item.quantity,
              depAmount,
              saleId,
              `Consigne casiers vente ${saleNumber}`,
              actorUserId
            );
          }
        }
      }

      for (const pay of input.payments) {
        const paymentId = crypto.randomUUID();
        const paymentNumber = this.generateDocNumber('PAY');
        const extRef = pay.externalReference?.trim() || null;

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
            customerRow?.id ?? null,
            pay.paymentMethod,
            pay.amountXof,
            extRef,
            openSession?.id ?? null,
            actorUserId
          );

        this.db
          .prepare(
            `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
             VALUES (?, ?, 'SALE', ?, ?)`
          )
          .run(crypto.randomUUID(), paymentId, saleId, pay.amountXof);

        if (pay.paymentMethod === 'CASH' && openSession) {
          this.db
            .prepare(
              `INSERT INTO cash_movements (
                 id, cash_session_id, movement_type, amount_signed_xof,
                 reference_type, reference_id, description, user_id
               ) VALUES (?, ?, 'SALE_CASH', ?, 'SALE', ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              openSession.id,
              pay.amountXof,
              saleId,
              `Encaissement espèces vente ${saleNumber}`,
              actorUserId
            );
        }
      }

      if (customerRow && creditAmountXof > 0) {
        this.customerRepo.recomputeCustomerCommercialDebt(customerRow.id);
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'SALE_VALIDATED', 'sales', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          saleId,
          JSON.stringify({
            saleNumber,
            priceTier: input.priceTier,
            totalPayableXof,
            paidAmountXof,
            creditAmountXof,
            consignmentTotalXof,
          })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getSaleById(saleId);
  }

  private recordSaleConsignmentDelta(
    packagingTypeId: string,
    holderType: 'DEPOT' | 'CUSTOMER',
    holderId: string,
    quantityDelta: number,
    amountXof: number,
    saleId: string,
    note: string,
    actorUserId: string
  ) {
    this.db
      .prepare(
        `INSERT INTO consignment_movements (
           id, packaging_type_id, movement_type, holder_type, holder_id,
           quantity_delta, amount_xof, reference_type, reference_id, note, user_id
         ) VALUES (?, ?, 'SALE_DEPOSIT', ?, ?, ?, ?, 'SALE', ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        packagingTypeId,
        holderType,
        holderId,
        quantityDelta,
        amountXof,
        saleId,
        note,
        actorUserId
      );

    if (holderType === 'CUSTOMER') {
      const existing = this.db
        .prepare(
          `SELECT id, quantity, deposit_value_xof AS depositValueXof
           FROM consignment_balances
           WHERE holder_type = 'CUSTOMER' AND holder_id = ? AND packaging_type_id = ?`
        )
        .get(holderId, packagingTypeId) as
        | { id: string; quantity: number; depositValueXof: number }
        | undefined;

      if (existing) {
        this.db
          .prepare(
            `UPDATE consignment_balances
             SET quantity = quantity + ?,
                 deposit_value_xof = deposit_value_xof + ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?`
          )
          .run(quantityDelta, amountXof, existing.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO consignment_balances (id, holder_type, holder_id, packaging_type_id, quantity, deposit_value_xof)
             VALUES (?, 'CUSTOMER', ?, ?, ?, ?)`
          )
          .run(crypto.randomUUID(), holderId, packagingTypeId, quantityDelta, amountXof);
      }
    }
  }

  cancelSale(actorUserId: string, saleId: string, reason: string): SaleDTO {
    const cleanReason = reason.trim();
    if (cleanReason.length < 3) {
      throw new AppError(
        'VALIDATION_ERROR',
        "Un motif d'annulation détaillé (min. 3 caractères) est obligatoire.",
        400
      );
    }

    const sale = this.getSaleById(saleId);
    if (sale.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'Cette vente est déjà annulée.', 409);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE sales
           SET status = 'CANCELLED',
               cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               cancelled_by_user_id = ?,
               cancel_reason = ?,
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(actorUserId, cleanReason, saleId);

      // RÈGLE 3 : Écritures compensatoires sur le stock (jamais de suppression)
      for (const item of sale.items) {
        const currentBal = this.db
          .prepare(
            'SELECT quantity_base AS quantityBase, damaged_quantity_base AS damagedQuantityBase FROM stock_balances WHERE product_id = ?'
          )
          .get(item.productId) as
          | { quantityBase: number; damagedQuantityBase: number }
          | undefined;
        const nextQty = (currentBal?.quantityBase ?? 0) + item.baseQty;

        this.db
          .prepare(
            `INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
             VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(product_id) DO UPDATE SET
               quantity_base = excluded.quantity_base,
               updated_at = excluded.updated_at`
          )
          .run(item.productId, nextQty, currentBal?.damagedQuantityBase ?? 0);

        this.db
          .prepare(
            `INSERT INTO stock_movements (
               id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
               balance_after_base, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, 'SALE_CANCEL', ?, ?, ?, 'SALE', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            item.productId,
            item.baseQty,
            item.unitCostXof,
            nextQty,
            saleId,
            `Annulation vente ${sale.saleNumber} : ${cleanReason}`,
            actorUserId
          );
      }

      // Écritures compensatoires sur les consignes générées par la vente annulée
      const depositRows = this.db
        .prepare(
          `SELECT packaging_type_id AS packagingTypeId, holder_type AS holderType,
                  holder_id AS holderId, quantity_delta AS quantityDelta, amount_xof AS amountXof
           FROM consignment_movements
           WHERE reference_type = 'SALE' AND reference_id = ? AND movement_type = 'SALE_DEPOSIT'`
        )
        .all(saleId) as Array<{
        packagingTypeId: string;
        holderType: string;
        holderId: string;
        quantityDelta: number;
        amountXof: number;
      }>;

      for (const dep of depositRows) {
        this.db
          .prepare(
            `INSERT INTO consignment_movements (
               id, packaging_type_id, movement_type, holder_type, holder_id,
               quantity_delta, amount_xof, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, 'REFUND', ?, ?, ?, ?, 'SALE_CANCEL', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            dep.packagingTypeId,
            dep.holderType,
            dep.holderId,
            -dep.quantityDelta,
            dep.amountXof,
            saleId,
            `Annulation consigne vente ${sale.saleNumber}`,
            actorUserId
          );

        if (dep.holderType === 'CUSTOMER') {
          this.db
            .prepare(
              `UPDATE consignment_balances
               SET quantity = MAX(0, quantity - ?),
                   deposit_value_xof = MAX(0, deposit_value_xof - ?),
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE holder_type = 'CUSTOMER' AND holder_id = ? AND packaging_type_id = ?`
            )
            .run(dep.quantityDelta, dep.amountXof, dep.holderId, dep.packagingTypeId);
        }
      }

      // Écritures compensatoires sur les encaissements associés à la vente
      const openSession = this.db
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")
        .get() as { id: string } | undefined;

      for (const pay of sale.payments) {
        const refundPayId = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO payments (
               id, payment_number, direction, party_type, party_id,
               payment_method, amount_xof, external_reference, cash_session_id, user_id
             ) VALUES (?, ?, 'OUTBOUND', 'CUSTOMER', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            refundPayId,
            this.generateDocNumber('REM'),
            sale.customerId,
            pay.paymentMethod,
            pay.amountXof,
            `ANNUL-${sale.saleNumber}`,
            openSession?.id ?? null,
            actorUserId
          );

        if (pay.paymentMethod === 'CASH' && openSession) {
          this.db
            .prepare(
              `INSERT INTO cash_movements (
                 id, cash_session_id, movement_type, amount_signed_xof,
                 reference_type, reference_id, description, user_id
               ) VALUES (?, ?, 'MANUAL_OUT', ?, 'SALE_CANCEL', ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              openSession.id,
              -pay.amountXof,
              saleId,
              `Remboursement annulation vente ${sale.saleNumber}`,
              actorUserId
            );
        }
      }

      if (sale.customerId) {
        this.customerRepo.recomputeCustomerCommercialDebt(sale.customerId);
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'SALE_CANCELLED', 'sales', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          saleId,
          JSON.stringify({ saleNumber: sale.saleNumber, reason: cleanReason })
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.getSaleById(saleId);
  }
}
