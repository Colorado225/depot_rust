import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { computeWeightedAvgCostXof } from '../domain/cump.ts';
import { assertNonNegativeXof, mulXofQty } from '../domain/money.ts';
import { AppError } from '../error.ts';

export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'VALIDATED'
  | 'PARTIAL_RECEIVED'
  | 'RECEIVED'
  | 'CANCELLED';

export type PaymentMethod =
  | 'CASH'
  | 'ORANGE_MONEY'
  | 'MTN_MOMO'
  | 'MOOV_MONEY'
  | 'WAVE'
  | 'BANK_TRANSFER';

export interface PurchaseItemDTO {
  id: string;
  purchaseOrderId: string;
  productId: string;
  productSku: string;
  productName: string;
  unitId: string;
  unitName: string;
  baseUnitName: string;
  orderedQty: number;
  receivedQty: number;
  remainingQty: number;
  conversionToBase: number;
  unitCostXof: number;
  lineTotalXof: number;
}

export interface PurchaseOrderDTO {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  totalAmountXof: number;
  receivedAmountXof: number;
  paidAmountXof: number;
  remainingToPayOnReceivedXof: number;
  remainingToPayOnOrderXof: number;
  note: string | null;
  userId: string;
  userName: string;
  orderedAt: string;
  createdAt: string;
  updatedAt: string;
  receiptsCount: number;
  items: PurchaseItemDTO[];
}

export interface GoodsReceiptItemDTO {
  id: string;
  goodsReceiptId: string;
  purchaseItemId: string;
  productId: string;
  productSku: string;
  productName: string;
  receivedQty: number;
  baseQty: number;
  unitCostXof: number;
}

export interface GoodsReceiptDTO {
  id: string;
  receiptNumber: string;
  purchaseOrderId: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceRef: string | null;
  totalReceivedXof: number;
  userId: string;
  userName: string;
  receivedAt: string;
  note: string | null;
  items: GoodsReceiptItemDTO[];
}

export interface SupplierPaymentDTO {
  id: string;
  paymentNumber: string;
  supplierId: string;
  supplierName: string;
  paymentMethod: PaymentMethod;
  amountXof: number;
  externalReference: string | null;
  purchaseOrderId: string | null;
  orderNumber: string | null;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  validateImmediately?: boolean;
  note?: string | null;
  items: Array<{
    productId: string;
    unitId: string;
    orderedQty: number;
    unitCostXof: number;
  }>;
}

export interface ReceivePurchaseOrderInput {
  supplierInvoiceRef?: string | null;
  note?: string | null;
  items: Array<{
    purchaseItemId: string;
    receivedQty: number;
  }>;
}

export interface RecordSupplierPaymentInput {
  supplierId: string;
  purchaseOrderId?: string | null;
  paymentMethod: PaymentMethod;
  amountXof: number;
  externalReference?: string | null;
}

export interface RecordSupplierReturnInput {
  purchaseOrderId: string;
  productId: string;
  unitId: string;
  quantity: number;
  note?: string | null;
}

export class PurchaseRepository {
  constructor(private readonly db: DatabaseSync) {}

  private generateDocNumber(prefix: string): string {
    const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
    const ts = Date.now().toString().slice(-6);
    return `${prefix}-${ts}-${rand}`;
  }

  private recomputeSupplierBalanceDue(supplierId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(MAX(0, received_amount_xof - paid_amount_xof)), 0) AS dueXof
         FROM purchase_orders
         WHERE supplier_id = ? AND status != 'CANCELLED'`
      )
      .get(supplierId) as { dueXof: number };

    const dueXof = Math.max(0, row.dueXof ?? 0);
    this.db
      .prepare(
        `UPDATE suppliers
         SET balance_due_xof = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             sync_version = sync_version + 1
         WHERE id = ?`
      )
      .run(dueXof, supplierId);

    return dueXof;
  }

  listPurchaseOrders(filter: {
    search?: string;
    supplierId?: string;
    status?: string;
  } = {}): PurchaseOrderDTO[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.supplierId) {
      clauses.push('po.supplier_id = ?');
      params.push(filter.supplierId);
    }
    if (filter.status) {
      clauses.push('po.status = ?');
      params.push(filter.status);
    }
    if (filter.search?.trim()) {
      const q = `%${filter.search.trim().toLowerCase()}%`;
      clauses.push(
        "(LOWER(po.order_number) LIKE ? OR LOWER(s.name) LIKE ? OR LOWER(COALESCE(po.note, '')) LIKE ?)"
      );
      params.push(q, q, q);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT po.id, po.order_number AS orderNumber, po.supplier_id AS supplierId,
                s.name AS supplierName, po.status, po.total_amount_xof AS totalAmountXof,
                po.received_amount_xof AS receivedAmountXof,
                po.paid_amount_xof AS paidAmountXof,
                po.note, po.user_id AS userId,
                COALESCE(e.full_name, u.username) AS userName,
                po.ordered_at AS orderedAt, po.created_at AS createdAt, po.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM goods_receipts gr WHERE gr.purchase_order_id = po.id) AS receiptsCount
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
         JOIN users u ON u.id = po.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         ${whereSql}
         ORDER BY po.created_at DESC, po.rowid DESC`
      )
      .all(...params) as Array<
      Omit<
        PurchaseOrderDTO,
        'items' | 'remainingToPayOnReceivedXof' | 'remainingToPayOnOrderXof'
      >
    >;

    const itemStmt = this.db.prepare(
      `SELECT pi.id, pi.purchase_order_id AS purchaseOrderId, pi.product_id AS productId,
              p.sku AS productSku, p.name AS productName,
              pi.unit_id AS unitId, un.name AS unitName, bu.name AS baseUnitName,
              pi.ordered_qty AS orderedQty, pi.received_qty AS receivedQty,
              (pi.ordered_qty - pi.received_qty) AS remainingQty,
              pi.conversion_to_base AS conversionToBase,
              pi.unit_cost_xof AS unitCostXof, pi.line_total_xof AS lineTotalXof
       FROM purchase_items pi
       JOIN products p ON p.id = pi.product_id
       JOIN units un ON un.id = pi.unit_id
       JOIN units bu ON bu.id = p.base_unit_id
       WHERE pi.purchase_order_id = ?
       ORDER BY p.name ASC`
    );

    return rows.map((row) => ({
      ...row,
      remainingToPayOnReceivedXof: Math.max(0, row.receivedAmountXof - row.paidAmountXof),
      remainingToPayOnOrderXof: Math.max(0, row.totalAmountXof - row.paidAmountXof),
      items: itemStmt.all(row.id) as unknown as PurchaseItemDTO[],
    }));
  }

  getPurchaseOrderById(orderId: string): PurchaseOrderDTO {
    const found = this.listPurchaseOrders().find((o) => o.id === orderId);
    if (!found) {
      throw new AppError('NOT_FOUND', "Bon d'achat introuvable.", 404);
    }
    return found;
  }

  createPurchaseOrder(actorUserId: string, input: CreatePurchaseOrderInput): PurchaseOrderDTO {
    if (!input.items || input.items.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Ajoutez au moins une ligne produit au bon de commande.',
        400
      );
    }

    const supplier = this.db
      .prepare('SELECT id, name, is_active AS isActive FROM suppliers WHERE id = ?')
      .get(input.supplierId) as { id: string; name: string; isActive: number } | undefined;

    if (!supplier || supplier.isActive !== 1) {
      throw new AppError('NOT_FOUND', 'Fournisseur actif introuvable.', 404);
    }

    const seenPairs = new Set<string>();
    const preparedItems: Array<{
      id: string;
      productId: string;
      unitId: string;
      orderedQty: number;
      conversionToBase: number;
      unitCostXof: number;
      lineTotalXof: number;
    }> = [];

    let totalAmountXof = 0;

    for (const item of input.items) {
      const pairKey = `${item.productId}::${item.unitId}`;
      if (seenPairs.has(pairKey)) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Un même produit avec la même unité ne peut pas apparaître deux fois sur la commande.',
          400
        );
      }
      seenPairs.add(pairKey);

      if (!Number.isSafeInteger(item.orderedQty) || item.orderedQty <= 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          'La quantité commandée doit être un entier strictement positif.',
          400
        );
      }

      const unitCostXof = assertNonNegativeXof(item.unitCostXof, "Coût d'achat unitaire");

      const prod = this.db
        .prepare('SELECT id, name, is_active AS isActive FROM products WHERE id = ?')
        .get(item.productId) as { id: string; name: string; isActive: number } | undefined;
      if (!prod || prod.isActive !== 1) {
        throw new AppError('NOT_FOUND', 'Produit actif introuvable dans la commande.', 404);
      }

      const unitCfg = this.db
        .prepare(
          'SELECT conversion_to_base AS conversionToBase FROM product_units WHERE product_id = ? AND unit_id = ?'
        )
        .get(item.productId, item.unitId) as { conversionToBase: number } | undefined;
      if (!unitCfg) {
        throw new AppError(
          'VALIDATION_ERROR',
          `L'unité sélectionnée n'est pas configurée pour « ${prod.name} ».`,
          400
        );
      }

      const lineTotalXof = mulXofQty(unitCostXof, item.orderedQty);
      totalAmountXof += lineTotalXof;
      if (!Number.isSafeInteger(totalAmountXof)) {
        throw new AppError('VALIDATION_ERROR', 'Dépassement du montant total commande.', 400);
      }

      preparedItems.push({
        id: crypto.randomUUID(),
        productId: item.productId,
        unitId: item.unitId,
        orderedQty: item.orderedQty,
        conversionToBase: unitCfg.conversionToBase,
        unitCostXof,
        lineTotalXof,
      });
    }

    const orderId = crypto.randomUUID();
    const orderNumber = this.generateDocNumber('BC');
    const status: PurchaseOrderStatus = input.validateImmediately ? 'VALIDATED' : 'DRAFT';

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO purchase_orders (
             id, order_number, supplier_id, status, total_amount_xof, received_amount_xof,
             paid_amount_xof, note, user_id
           ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`
        )
        .run(
          orderId,
          orderNumber,
          supplier.id,
          status,
          totalAmountXof,
          input.note?.trim() || null,
          actorUserId
        );

      const insertItemStmt = this.db.prepare(
        `INSERT INTO purchase_items (
           id, purchase_order_id, product_id, unit_id, ordered_qty, received_qty,
           conversion_to_base, unit_cost_xof, line_total_xof
         ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
      );

      for (const line of preparedItems) {
        insertItemStmt.run(
          line.id,
          orderId,
          line.productId,
          line.unitId,
          line.orderedQty,
          line.conversionToBase,
          line.unitCostXof,
          line.lineTotalXof
        );
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'PURCHASE_ORDER_CREATED', 'purchase_orders', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          orderId,
          JSON.stringify({
            orderNumber,
            supplierId: supplier.id,
            status,
            totalAmountXof,
          })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getPurchaseOrderById(orderId);
  }

  validatePurchaseOrder(actorUserId: string, orderId: string): PurchaseOrderDTO {
    const order = this.db
      .prepare('SELECT id, order_number AS orderNumber, status FROM purchase_orders WHERE id = ?')
      .get(orderId) as { id: string; orderNumber: string; status: PurchaseOrderStatus } | undefined;

    if (!order) {
      throw new AppError('NOT_FOUND', "Bon d'achat introuvable.", 404);
    }
    if (order.status !== 'DRAFT') {
      throw new AppError(
        'CONFLICT',
        `Seul un brouillon peut être validé (statut actuel : ${order.status}).`,
        409
      );
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE purchase_orders
           SET status = 'VALIDATED',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(orderId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'PURCHASE_ORDER_VALIDATED', 'purchase_orders', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          orderId,
          JSON.stringify({ orderNumber: order.orderNumber })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getPurchaseOrderById(orderId);
  }

  cancelPurchaseOrder(actorUserId: string, orderId: string, reason?: string): PurchaseOrderDTO {
    const order = this.db
      .prepare(
        `SELECT id, order_number AS orderNumber, supplier_id AS supplierId, status,
                received_amount_xof AS receivedAmountXof, paid_amount_xof AS paidAmountXof
         FROM purchase_orders WHERE id = ?`
      )
      .get(orderId) as
      | {
          id: string;
          orderNumber: string;
          supplierId: string;
          status: PurchaseOrderStatus;
          receivedAmountXof: number;
          paidAmountXof: number;
        }
      | undefined;

    if (!order) {
      throw new AppError('NOT_FOUND', "Bon d'achat introuvable.", 404);
    }
    if (order.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'Cette commande est déjà annulée.', 409);
    }
    if (order.receivedAmountXof > 0 || order.paidAmountXof > 0) {
      throw new AppError(
        'CONFLICT',
        "Impossible d'annuler une commande ayant déjà fait l'objet d'une réception ou d'un règlement.",
        409
      );
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE purchase_orders
           SET status = 'CANCELLED',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(orderId);

      this.recomputeSupplierBalanceDue(order.supplierId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'PURCHASE_ORDER_CANCELLED', 'purchase_orders', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          orderId,
          JSON.stringify({ orderNumber: order.orderNumber, reason: reason?.trim() || null })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getPurchaseOrderById(orderId);
  }

  receivePurchaseOrder(
    actorUserId: string,
    orderId: string,
    input: ReceivePurchaseOrderInput
  ): GoodsReceiptDTO {
    if (!input.items || input.items.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Aucune ligne à réceptionner n’a été transmise.',
        400
      );
    }

    const activeLines = input.items.filter((i) => i.receivedQty > 0);
    if (activeLines.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Saisissez au moins une quantité reçue strictement positive.',
        400
      );
    }

    this.db.exec('BEGIN IMMEDIATE;');
    const receiptId = crypto.randomUUID();
    const receiptNumber = this.generateDocNumber('REC');

    try {
      const order = this.db
        .prepare(
          `SELECT id, order_number AS orderNumber, supplier_id AS supplierId, status,
                  received_amount_xof AS receivedAmountXof
           FROM purchase_orders WHERE id = ?`
        )
        .get(orderId) as
        | {
            id: string;
            orderNumber: string;
            supplierId: string;
            status: PurchaseOrderStatus;
            receivedAmountXof: number;
          }
        | undefined;

      if (!order) {
        throw new AppError('NOT_FOUND', "Bon d'achat introuvable.", 404);
      }

      if (order.status !== 'VALIDATED' && order.status !== 'PARTIAL_RECEIVED') {
        throw new AppError(
          'CONFLICT',
          `Cette commande ne peut pas être réceptionnée (statut actuel : ${order.status}).`,
          409
        );
      }

      const orderItems = this.db
        .prepare(
          `SELECT pi.id, pi.product_id AS productId, p.name AS productName,
                  pi.ordered_qty AS orderedQty, pi.received_qty AS receivedQty,
                  pi.conversion_to_base AS conversionToBase, pi.unit_cost_xof AS unitCostXof
           FROM purchase_items pi
           JOIN products p ON p.id = pi.product_id
           WHERE pi.purchase_order_id = ?`
        )
        .all(orderId) as Array<{
        id: string;
        productId: string;
        productName: string;
        orderedQty: number;
        receivedQty: number;
        conversionToBase: number;
        unitCostXof: number;
      }>;

      const itemById = new Map(orderItems.map((i) => [i.id, i]));
      const seenLineIds = new Set<string>();
      let totalReceivedXof = 0;

      const receiptLinesToInsert: Array<{
        id: string;
        purchaseItemId: string;
        productId: string;
        receivedQty: number;
        baseQty: number;
        unitCostXof: number;
        baseUnitCostXof: number;
      }> = [];

      for (const reqLine of activeLines) {
        if (seenLineIds.has(reqLine.purchaseItemId)) {
          throw new AppError('VALIDATION_ERROR', 'Ligne dupliquée dans le bon de réception.', 400);
        }
        seenLineIds.add(reqLine.purchaseItemId);

        if (!Number.isSafeInteger(reqLine.receivedQty) || reqLine.receivedQty <= 0) {
          throw new AppError(
            'VALIDATION_ERROR',
            'Chaque quantité reçue doit être un entier strictement positif.',
            400
          );
        }

        const poItem = itemById.get(reqLine.purchaseItemId);
        if (!poItem) {
          throw new AppError(
            'NOT_FOUND',
            `Ligne de commande introuvable (${reqLine.purchaseItemId}).`,
            404
          );
        }

        const remaining = poItem.orderedQty - poItem.receivedQty;
        if (reqLine.receivedQty > remaining) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Quantité reçue (${reqLine.receivedQty}) supérieure au reliquat (${remaining}) pour « ${poItem.productName} ».`,
            400
          );
        }

        const baseQty = reqLine.receivedQty * poItem.conversionToBase;
        const lineReceivedXof = mulXofQty(poItem.unitCostXof, reqLine.receivedQty);
        totalReceivedXof += lineReceivedXof;

        const baseUnitCostBig =
          (BigInt(poItem.unitCostXof) + BigInt(poItem.conversionToBase) / 2n) /
          BigInt(poItem.conversionToBase);
        const baseUnitCostXof = Number(baseUnitCostBig);

        receiptLinesToInsert.push({
          id: crypto.randomUUID(),
          purchaseItemId: poItem.id,
          productId: poItem.productId,
          receivedQty: reqLine.receivedQty,
          baseQty,
          unitCostXof: poItem.unitCostXof,
          baseUnitCostXof,
        });
      }

      // 1) Création du bon de réception
      this.db
        .prepare(
          `INSERT INTO goods_receipts (
             id, receipt_number, purchase_order_id, supplier_id, total_received_xof,
             user_id, note, supplier_invoice_ref
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          receiptId,
          receiptNumber,
          orderId,
          order.supplierId,
          totalReceivedXof,
          actorUserId,
          input.note?.trim() || null,
          input.supplierInvoiceRef?.trim() || null
        );

      // 2) Traitement atomique par ligne : stock + CUMP + journal stock_movements + product_suppliers
      for (const line of receiptLinesToInsert) {
        this.db
          .prepare(
            `INSERT INTO goods_receipt_items (
               id, goods_receipt_id, purchase_item_id, product_id, received_qty, base_qty, unit_cost_xof
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            line.id,
            receiptId,
            line.purchaseItemId,
            line.productId,
            line.receivedQty,
            line.baseQty,
            line.unitCostXof
          );

        this.db
          .prepare('UPDATE purchase_items SET received_qty = received_qty + ? WHERE id = ?')
          .run(line.receivedQty, line.purchaseItemId);

        const stockRow = this.db
          .prepare(
            `SELECT p.weighted_avg_cost_xof AS currentCumpXof,
                    COALESCE(sb.quantity_base, 0) AS quantityBase,
                    COALESCE(sb.damaged_quantity_base, 0) AS damagedQuantityBase
             FROM products p
             LEFT JOIN stock_balances sb ON sb.product_id = p.id
             WHERE p.id = ?`
          )
          .get(line.productId) as {
          currentCumpXof: number;
          quantityBase: number;
          damagedQuantityBase: number;
        };

        const nextQtyBase = stockRow.quantityBase + line.baseQty;
        const nextCumpXof = computeWeightedAvgCostXof(
          stockRow.quantityBase,
          stockRow.currentCumpXof,
          line.baseQty,
          line.baseUnitCostXof
        );

        this.db
          .prepare(
            `INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
             VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(product_id) DO UPDATE SET
               quantity_base = excluded.quantity_base,
               updated_at = excluded.updated_at`
          )
          .run(line.productId, nextQtyBase, stockRow.damagedQuantityBase);

        this.db
          .prepare(
            `UPDATE products
             SET weighted_avg_cost_xof = ?,
                 purchase_price_xof = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?`
          )
          .run(nextCumpXof, line.baseUnitCostXof, line.productId);

        this.db
          .prepare(
            `INSERT INTO product_suppliers (id, product_id, supplier_id, last_unit_cost_xof, is_preferred)
             VALUES (?, ?, ?, ?, 0)
             ON CONFLICT(product_id, supplier_id) DO UPDATE SET
               last_unit_cost_xof = excluded.last_unit_cost_xof`
          )
          .run(crypto.randomUUID(), line.productId, order.supplierId, line.baseUnitCostXof);

        this.db
          .prepare(
            `INSERT INTO stock_movements (
               id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
               balance_after_base, reference_type, reference_id, note, user_id
             ) VALUES (?, ?, 'PURCHASE_RECEIPT', ?, ?, ?, 'GOODS_RECEIPT', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            line.productId,
            line.baseQty,
            line.baseUnitCostXof,
            nextQtyBase,
            receiptId,
            `Réception ${receiptNumber} (BC ${order.orderNumber})`,
            actorUserId
          );
      }

      // 3) Mise à jour statut et montant réceptionné de la commande + dette fournisseur
      const remainingAgg = this.db
        .prepare(
          'SELECT COALESCE(SUM(ordered_qty - received_qty), 0) AS remainingTotal FROM purchase_items WHERE purchase_order_id = ?'
        )
        .get(orderId) as { remainingTotal: number };

      const nextStatus: PurchaseOrderStatus =
        remainingAgg.remainingTotal === 0 ? 'RECEIVED' : 'PARTIAL_RECEIVED';

      this.db
        .prepare(
          `UPDATE purchase_orders
           SET status = ?,
               received_amount_xof = received_amount_xof + ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(nextStatus, totalReceivedXof, orderId);

      this.recomputeSupplierBalanceDue(order.supplierId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'GOODS_RECEIPT_VALIDATED', 'goods_receipts', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          receiptId,
          JSON.stringify({
            receiptNumber,
            purchaseOrderId: orderId,
            orderNumber: order.orderNumber,
            totalReceivedXof,
            nextStatus,
          })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listGoodsReceipts({ purchaseOrderId: orderId }).find((r) => r.id === receiptId)!;
  }

  listGoodsReceipts(filter: {
    purchaseOrderId?: string;
    supplierId?: string;
  } = {}): GoodsReceiptDTO[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (filter.purchaseOrderId) {
      clauses.push('gr.purchase_order_id = ?');
      params.push(filter.purchaseOrderId);
    }
    if (filter.supplierId) {
      clauses.push('gr.supplier_id = ?');
      params.push(filter.supplierId);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT gr.id, gr.receipt_number AS receiptNumber, gr.purchase_order_id AS purchaseOrderId,
                po.order_number AS orderNumber, gr.supplier_id AS supplierId,
                s.name AS supplierName, gr.supplier_invoice_ref AS supplierInvoiceRef,
                gr.total_received_xof AS totalReceivedXof, gr.user_id AS userId,
                COALESCE(e.full_name, u.username) AS userName,
                gr.received_at AS receivedAt, gr.note
         FROM goods_receipts gr
         JOIN purchase_orders po ON po.id = gr.purchase_order_id
         JOIN suppliers s ON s.id = gr.supplier_id
         JOIN users u ON u.id = gr.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         ${whereSql}
         ORDER BY gr.received_at DESC, gr.rowid DESC`
      )
      .all(...params) as Array<Omit<GoodsReceiptDTO, 'items'>>;

    const itemStmt = this.db.prepare(
      `SELECT gri.id, gri.goods_receipt_id AS goodsReceiptId, gri.purchase_item_id AS purchaseItemId,
              gri.product_id AS productId, p.sku AS productSku, p.name AS productName,
              gri.received_qty AS receivedQty, gri.base_qty AS baseQty, gri.unit_cost_xof AS unitCostXof
       FROM goods_receipt_items gri
       JOIN products p ON p.id = gri.product_id
       WHERE gri.goods_receipt_id = ?`
    );

    return rows.map((r) => ({
      ...r,
      items: itemStmt.all(r.id) as unknown as GoodsReceiptItemDTO[],
    }));
  }

  recordSupplierPayment(
    actorUserId: string,
    input: RecordSupplierPaymentInput
  ): SupplierPaymentDTO {
    const amountXof = assertNonNegativeXof(input.amountXof, 'Montant du règlement');
    if (amountXof <= 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Le montant du règlement fournisseur doit être supérieur à 0 FCFA.',
        400
      );
    }

    const supplier = this.db
      .prepare('SELECT id, name, balance_due_xof AS balanceDueXof FROM suppliers WHERE id = ?')
      .get(input.supplierId) as { id: string; name: string; balanceDueXof: number } | undefined;

    if (!supplier) {
      throw new AppError('NOT_FOUND', 'Fournisseur introuvable.', 404);
    }

    const paymentId = crypto.randomUUID();
    const paymentNumber = this.generateDocNumber('PAY-FRN');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const openCashSession = this.db
        .prepare("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1")
        .get() as { id: string } | undefined;

      this.db
        .prepare(
          `INSERT INTO payments (
             id, payment_number, direction, party_type, party_id, payment_method,
             amount_xof, external_reference, cash_session_id, user_id
           ) VALUES (?, ?, 'OUTBOUND', 'SUPPLIER', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          paymentId,
          paymentNumber,
          supplier.id,
          input.paymentMethod,
          amountXof,
          input.externalReference?.trim() || null,
          input.paymentMethod === 'CASH' && openCashSession ? openCashSession.id : null,
          actorUserId
        );

      if (input.purchaseOrderId) {
        const po = this.db
          .prepare(
            `SELECT id, order_number AS orderNumber, supplier_id AS supplierId, status,
                    total_amount_xof AS totalAmountXof, paid_amount_xof AS paidAmountXof
             FROM purchase_orders WHERE id = ?`
          )
          .get(input.purchaseOrderId) as
          | {
              id: string;
              orderNumber: string;
              supplierId: string;
              status: PurchaseOrderStatus;
              totalAmountXof: number;
              paidAmountXof: number;
            }
          | undefined;

        if (!po || po.supplierId !== supplier.id) {
          throw new AppError(
            'NOT_FOUND',
            'Commande fournisseur introuvable pour ce fournisseur.',
            404
          );
        }
        if (po.status === 'CANCELLED' || po.status === 'DRAFT') {
          throw new AppError(
            'CONFLICT',
            "Impossible d'enregistrer un règlement sur un brouillon ou une commande annulée.",
            409
          );
        }

        const remaining = po.totalAmountXof - po.paidAmountXof;
        if (amountXof > remaining) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Le règlement (${amountXof} FCFA) dépasse le solde restant sur le bon ${po.orderNumber} (${remaining} FCFA).`,
            400
          );
        }

        this.db
          .prepare(
            `UPDATE purchase_orders
             SET paid_amount_xof = paid_amount_xof + ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?`
          )
          .run(amountXof, po.id);

        this.db
          .prepare(
            `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
             VALUES (?, ?, 'PURCHASE_ORDER', ?, ?)`
          )
          .run(crypto.randomUUID(), paymentId, po.id, amountXof);
      } else {
        // Répartition FIFO sur les commandes réceptionnées non soldées
        const unpaidOrders = this.db
          .prepare(
            `SELECT id, order_number AS orderNumber, received_amount_xof AS receivedAmountXof,
                    paid_amount_xof AS paidAmountXof
             FROM purchase_orders
             WHERE supplier_id = ?
               AND status IN ('PARTIAL_RECEIVED', 'RECEIVED')
               AND received_amount_xof > paid_amount_xof
             ORDER BY created_at ASC`
          )
          .all(supplier.id) as Array<{
          id: string;
          orderNumber: string;
          receivedAmountXof: number;
          paidAmountXof: number;
        }>;

        const totalDueReceived = unpaidOrders.reduce(
          (acc, o) => acc + (o.receivedAmountXof - o.paidAmountXof),
          0
        );
        if (amountXof > totalDueReceived) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Le montant (${amountXof} FCFA) dépasse la dette réceptionnée due au fournisseur (${totalDueReceived} FCFA).`,
            400
          );
        }

        let remainingToAllocate = amountXof;
        for (const o of unpaidOrders) {
          if (remainingToAllocate <= 0) break;
          const dueOnOrder = o.receivedAmountXof - o.paidAmountXof;
          const alloc = Math.min(remainingToAllocate, dueOnOrder);
          if (alloc > 0) {
            this.db
              .prepare(
                `UPDATE purchase_orders
                 SET paid_amount_xof = paid_amount_xof + ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                     sync_version = sync_version + 1
                 WHERE id = ?`
              )
              .run(alloc, o.id);

            this.db
              .prepare(
                `INSERT INTO payment_allocations (id, payment_id, target_type, target_id, allocated_xof)
                 VALUES (?, ?, 'PURCHASE_ORDER', ?, ?)`
              )
              .run(crypto.randomUUID(), paymentId, o.id, alloc);

            remainingToAllocate -= alloc;
          }
        }
      }

      const newBalanceDue = this.recomputeSupplierBalanceDue(supplier.id);

      if (input.paymentMethod === 'CASH' && openCashSession) {
        this.db
          .prepare(
            `INSERT INTO cash_movements (
               id, cash_session_id, movement_type, amount_signed_xof, reference_type,
               reference_id, description, user_id
             ) VALUES (?, ?, 'SUPPLIER_PAYMENT', ?, 'PAYMENT', ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            openCashSession.id,
            -amountXof,
            paymentId,
            `Règlement fournisseur ${supplier.name} (${paymentNumber})`,
            actorUserId
          );
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'SUPPLIER_PAYMENT_RECORDED', 'payments', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          paymentId,
          JSON.stringify({
            paymentNumber,
            supplierId: supplier.id,
            amountXof,
            paymentMethod: input.paymentMethod,
            newBalanceDue,
          })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listSupplierPayments({ supplierId: input.supplierId }).find(
      (p) => p.id === paymentId
    )!;
  }

  listSupplierPayments(filter: {
    supplierId?: string;
    purchaseOrderId?: string;
  } = {}): SupplierPaymentDTO[] {
    const clauses = ["p.party_type = 'SUPPLIER'"];
    const params: string[] = [];

    if (filter.supplierId) {
      clauses.push('p.party_id = ?');
      params.push(filter.supplierId);
    }
    if (filter.purchaseOrderId) {
      clauses.push('pa.target_id = ?');
      params.push(filter.purchaseOrderId);
    }

    return this.db
      .prepare(
        `SELECT p.id, p.payment_number AS paymentNumber, p.party_id AS supplierId,
                s.name AS supplierName, p.payment_method AS paymentMethod,
                p.amount_xof AS amountXof, p.external_reference AS externalReference,
                pa.target_id AS purchaseOrderId, po.order_number AS orderNumber,
                p.user_id AS userId, COALESCE(e.full_name, u.username) AS userName,
                p.created_at AS createdAt
         FROM payments p
         JOIN suppliers s ON s.id = p.party_id
         JOIN users u ON u.id = p.user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN payment_allocations pa ON pa.payment_id = p.id AND pa.target_type = 'PURCHASE_ORDER'
         LEFT JOIN purchase_orders po ON po.id = pa.target_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY p.created_at DESC, p.rowid DESC`
      )
      .all(...params) as unknown as SupplierPaymentDTO[];
  }

  recordSupplierReturn(
    actorUserId: string,
    input: RecordSupplierReturnInput
  ): { returnNumber: string; baseQtyReturned: number; totalReturnXof: number } {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 'La quantité retournée doit être >= 1.', 400);
    }

    const returnId = crypto.randomUUID();
    const returnNumber = this.generateDocNumber('RET-FRN');
    let baseQtyReturned = 0;
    let totalReturnXof = 0;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const po = this.db
        .prepare(
          `SELECT id, order_number AS orderNumber, supplier_id AS supplierId, status,
                  received_amount_xof AS receivedAmountXof
           FROM purchase_orders WHERE id = ?`
        )
        .get(input.purchaseOrderId) as
        | {
            id: string;
            orderNumber: string;
            supplierId: string;
            status: PurchaseOrderStatus;
            receivedAmountXof: number;
          }
        | undefined;

      if (!po) {
        throw new AppError('NOT_FOUND', "Bon d'achat introuvable.", 404);
      }
      if (po.status !== 'PARTIAL_RECEIVED' && po.status !== 'RECEIVED') {
        throw new AppError(
          'CONFLICT',
          'Un retour fournisseur ne peut concerner qu’une commande déjà réceptionnée.',
          409
        );
      }

      const poItem = this.db
        .prepare(
          `SELECT id, unit_id AS unitId, received_qty AS receivedQty,
                  conversion_to_base AS conversionToBase, unit_cost_xof AS unitCostXof
           FROM purchase_items
           WHERE purchase_order_id = ? AND product_id = ? AND unit_id = ?`
        )
        .get(po.id, input.productId, input.unitId) as
        | {
            id: string;
            unitId: string;
            receivedQty: number;
            conversionToBase: number;
            unitCostXof: number;
          }
        | undefined;

      if (!poItem || poItem.receivedQty < input.quantity) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Quantité retournée supérieure à la quantité reçue sur cette commande.',
          400
        );
      }

      baseQtyReturned = input.quantity * poItem.conversionToBase;
      totalReturnXof = mulXofQty(poItem.unitCostXof, input.quantity);

      const stockRow = this.db
        .prepare(
          `SELECT p.name, p.weighted_avg_cost_xof AS currentCumpXof,
                  COALESCE(sb.quantity_base, 0) AS quantityBase
           FROM products p
           LEFT JOIN stock_balances sb ON sb.product_id = p.id
           WHERE p.id = ?`
        )
        .get(input.productId) as
        | { name: string; currentCumpXof: number; quantityBase: number }
        | undefined;

      if (!stockRow || stockRow.quantityBase < baseQtyReturned) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `Stock disponible insuffisant pour retourner ${baseQtyReturned} unités de « ${stockRow?.name ?? 'produit'} ».`,
          409
        );
      }

      const nextQtyBase = stockRow.quantityBase - baseQtyReturned;
      this.db
        .prepare(
          `UPDATE stock_balances
           SET quantity_base = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE product_id = ?`
        )
        .run(nextQtyBase, input.productId);

      const baseUnitCostBig =
        (BigInt(poItem.unitCostXof) + BigInt(poItem.conversionToBase) / 2n) /
        BigInt(poItem.conversionToBase);

      this.db
        .prepare(
          `INSERT INTO supplier_returns (
             id, return_number, purchase_order_id, supplier_id, total_return_xof, note, user_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          returnId,
          returnNumber,
          po.id,
          po.supplierId,
          totalReturnXof,
          input.note?.trim() || null,
          actorUserId
        );

      this.db
        .prepare(
          `INSERT INTO supplier_return_items (
             id, supplier_return_id, product_id, unit_id, returned_qty, base_qty, unit_cost_xof, line_total_xof
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          returnId,
          input.productId,
          input.unitId,
          input.quantity,
          baseQtyReturned,
          poItem.unitCostXof,
          totalReturnXof
        );

      this.db
        .prepare(
          `INSERT INTO stock_movements (
             id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
             balance_after_base, reference_type, reference_id, note, user_id
           ) VALUES (?, ?, 'SUPPLIER_RETURN', ?, ?, ?, 'SUPPLIER_RETURN', ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          input.productId,
          -baseQtyReturned,
          Number(baseUnitCostBig),
          nextQtyBase,
          returnId,
          input.note?.trim() || `Retour fournisseur ${returnNumber} (BC ${po.orderNumber})`,
          actorUserId
        );

      // Réduit le montant réceptionné exigible sur la commande (sans jamais passer en négatif)
      this.db
        .prepare(
          `UPDATE purchase_orders
           SET received_amount_xof = MAX(0, received_amount_xof - ?),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(totalReturnXof, po.id);

      this.recomputeSupplierBalanceDue(po.supplierId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'SUPPLIER_RETURN_RECORDED', 'supplier_returns', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          returnId,
          JSON.stringify({
            returnNumber,
            purchaseOrderId: po.id,
            baseQtyReturned,
            totalReturnXof,
          })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return { returnNumber, baseQtyReturned, totalReturnXof };
  }
}
