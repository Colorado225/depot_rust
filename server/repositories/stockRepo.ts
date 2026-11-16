import crypto from 'node:crypto';
import type { DatabaseLike } from '../db/driver.ts';
import { computeWeightedAvgCostXof } from '../domain/cump.ts';
import { assertNonNegativeXof, mulXofQty } from '../domain/money.ts';
import { AppError } from '../error.ts';

export type ManualStockMovementType =
  | 'INITIAL'
  | 'MANUAL_IN'
  | 'MANUAL_OUT'
  | 'BREAKAGE'
  | 'LOSS';

export interface StockBalanceItemDTO {
  productId: string;
  sku: string;
  name: string;
  categoryName: string | null;
  baseUnitId: string;
  baseUnitName: string;
  quantityBase: number;
  damagedQuantityBase: number;
  alertThresholdBase: number;
  isLowStock: boolean;
  weightedAvgCostXof: number;
  totalValuationXof: number;
  updatedAt: string;
}

export interface StockMovementDTO {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  baseUnitName: string;
  movementType: string;
  quantityDeltaBase: number;
  unitCostXof: number;
  balanceAfterBase: number;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  userId: string;
  userName: string;
  createdAt: string;
}

export interface StockInventorySummaryDTO {
  id: string;
  inventoryNumber: string;
  status: 'DRAFT' | 'VALIDATED';
  note: string | null;
  linesCount: number;
  totalVarianceBase: number;
  createdByName: string;
  validatedByName: string | null;
  validatedAt: string | null;
  createdAt: string;
}

export interface RecordStockMovementInput {
  productId: string;
  unitId: string;
  quantity: number;
  movementType: ManualStockMovementType;
  unitCostXof?: number;
  note?: string;
}

export interface InventoryCountLineInput {
  productId: string;
  countedBase: number;
}

export class StockRepository {
  constructor(private readonly db: DatabaseLike) {}

  listStockBalances(filter: { search?: string; onlyLowStock?: boolean } = {}): StockBalanceItemDTO[] {
    const clauses = ['p.is_active = 1'];
    const params: string[] = [];

    if (filter.search?.trim()) {
      const q = `%${filter.search.trim().toLowerCase()}%`;
      clauses.push("(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(COALESCE(p.barcode, '')) LIKE ?)");
      params.push(q, q, q);
    }

    if (filter.onlyLowStock) {
      clauses.push('COALESCE(sb.quantity_base, 0) <= p.alert_threshold_base');
    }

    const rows = this.db
      .prepare(
        `SELECT p.id AS productId, p.sku, p.name, c.name AS categoryName,
                p.base_unit_id AS baseUnitId, u.name AS baseUnitName,
                COALESCE(sb.quantity_base, 0) AS quantityBase,
                COALESCE(sb.damaged_quantity_base, 0) AS damagedQuantityBase,
                p.alert_threshold_base AS alertThresholdBase,
                p.weighted_avg_cost_xof AS weightedAvgCostXof,
                COALESCE(sb.updated_at, p.updated_at) AS updatedAt
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         JOIN units u ON u.id = p.base_unit_id
         LEFT JOIN stock_balances sb ON sb.product_id = p.id
         WHERE ${clauses.join(' AND ')}
         ORDER BY p.name ASC`
      )
      .all(...params) as Array<
      Omit<StockBalanceItemDTO, 'isLowStock' | 'totalValuationXof'>
    >;

    return rows.map((r) => ({
      ...r,
      isLowStock: r.quantityBase <= r.alertThresholdBase,
      totalValuationXof: mulXofQty(r.weightedAvgCostXof, r.quantityBase),
    }));
  }

  listMovements(filter: { productId?: string; movementType?: string; limit?: number } = {}): StockMovementDTO[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.productId) {
      clauses.push('sm.product_id = ?');
      params.push(filter.productId);
    }
    if (filter.movementType) {
      clauses.push('sm.movement_type = ?');
      params.push(filter.movementType);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(300, Math.max(1, filter.limit ?? 100));
    params.push(limit);

    return this.db
      .prepare(
        `SELECT sm.id, sm.product_id AS productId, p.sku AS productSku, p.name AS productName,
                u.name AS baseUnitName, sm.movement_type AS movementType,
                sm.quantity_delta_base AS quantityDeltaBase,
                sm.unit_cost_xof AS unitCostXof,
                sm.balance_after_base AS balanceAfterBase,
                sm.reference_type AS referenceType,
                sm.reference_id AS referenceId,
                sm.note,
                sm.user_id AS userId,
                COALESCE(e.full_name, usr.username) AS userName,
                sm.created_at AS createdAt
         FROM stock_movements sm
         JOIN products p ON p.id = sm.product_id
         JOIN units u ON u.id = p.base_unit_id
         JOIN users usr ON usr.id = sm.user_id
         LEFT JOIN employees e ON e.id = usr.employee_id
         ${whereSql}
         ORDER BY sm.created_at DESC, sm.rowid DESC
         LIMIT ?`
      )
      .all(...params) as unknown as StockMovementDTO[];
  }

  recordMovement(actorUserId: string, input: RecordStockMovementInput): StockMovementDTO {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 'La quantité doit être un entier strictement positif.', 400);
    }

    this.db.exec('BEGIN IMMEDIATE;');
    let movementId = '';
    try {
      const product = this.db
        .prepare(
          `SELECT p.id, p.name, p.weighted_avg_cost_xof AS weightedAvgCostXof, p.purchase_price_xof AS purchasePriceXof,
                  p.is_active AS isActive, COALESCE(sb.quantity_base, 0) AS quantityBase,
                  COALESCE(sb.damaged_quantity_base, 0) AS damagedQuantityBase
           FROM products p
           LEFT JOIN stock_balances sb ON sb.product_id = p.id
           WHERE p.id = ?`
        )
        .get(input.productId) as
        | {
            id: string;
            name: string;
            weightedAvgCostXof: number;
            purchasePriceXof: number;
            isActive: number;
            quantityBase: number;
            damagedQuantityBase: number;
          }
        | undefined;

      if (!product || product.isActive !== 1) {
        throw new AppError('NOT_FOUND', 'Produit actif introuvable.', 404);
      }

      const unitConfig = this.db
        .prepare(
          'SELECT conversion_to_base AS conversionToBase FROM product_units WHERE product_id = ? AND unit_id = ?'
        )
        .get(input.productId, input.unitId) as { conversionToBase: number } | undefined;

      if (!unitConfig) {
        throw new AppError(
          'VALIDATION_ERROR',
          "Cette unité n'est pas configurée pour ce produit.",
          400
        );
      }

      const baseQty = input.quantity * unitConfig.conversionToBase;
      if (!Number.isSafeInteger(baseQty) || baseQty <= 0) {
        throw new AppError('VALIDATION_ERROR', 'Quantité convertie invalide.', 400);
      }

      const isIncoming = input.movementType === 'INITIAL' || input.movementType === 'MANUAL_IN';
      const deltaBase = isIncoming ? baseQty : -baseQty;
      const nextQtyBase = product.quantityBase + deltaBase;

      const settings = this.db
        .prepare('SELECT allow_negative_stock AS allowNegative FROM business_settings LIMIT 1')
        .get() as { allowNegative: number } | undefined;
      const allowNegative = settings?.allowNegative === 1;

      if (!allowNegative && nextQtyBase < 0) {
        throw new AppError(
          'INSUFFICIENT_STOCK',
          `Stock insuffisant pour « ${product.name} » : disponible ${product.quantityBase}, demandé ${baseQty}.`,
          409
        );
      }

      let movementUnitCostXof = product.weightedAvgCostXof;
      let nextCumpXof = product.weightedAvgCostXof;

      if (isIncoming) {
        // Coût saisi pour l'unité choisie, ramené à l'unité de base (ou coût actuel si non fourni)
        const providedUnitCostForSelectedUnit =
          input.unitCostXof !== undefined
            ? assertNonNegativeXof(input.unitCostXof, 'Coût unitaire')
            : product.weightedAvgCostXof * unitConfig.conversionToBase;

        // Ramène le coût unitaire de l'unité choisie à l'unité de base (division entière arrondie)
        const baseCostBig =
          (BigInt(providedUnitCostForSelectedUnit) + BigInt(unitConfig.conversionToBase) / 2n) /
          BigInt(unitConfig.conversionToBase);
        movementUnitCostXof = Number(baseCostBig);

        nextCumpXof = computeWeightedAvgCostXof(
          product.quantityBase,
          product.weightedAvgCostXof,
          baseQty,
          movementUnitCostXof
        );
      }

      // Les marchandises cassées ne sont plus revendables : on incrémente damaged_quantity_base
      const nextDamagedBase =
        input.movementType === 'BREAKAGE'
          ? product.damagedQuantityBase + baseQty
          : product.damagedQuantityBase;

      this.db
        .prepare(
          `INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
           VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ON CONFLICT(product_id) DO UPDATE SET
             quantity_base = excluded.quantity_base,
             damaged_quantity_base = excluded.damaged_quantity_base,
             updated_at = excluded.updated_at`
        )
        .run(input.productId, nextQtyBase, nextDamagedBase);

      if (isIncoming && nextCumpXof !== product.weightedAvgCostXof) {
        this.db
          .prepare(
            `UPDATE products
             SET weighted_avg_cost_xof = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 sync_version = sync_version + 1
             WHERE id = ?`
          )
          .run(nextCumpXof, input.productId);
      }

      movementId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO stock_movements (
             id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
             balance_after_base, reference_type, reference_id, note, user_id
           ) VALUES (?, ?, ?, ?, ?, ?, 'MANUAL_STOCK', ?, ?, ?)`
        )
        .run(
          movementId,
          input.productId,
          input.movementType,
          deltaBase,
          movementUnitCostXof,
          nextQtyBase,
          movementId,
          input.note?.trim() || null,
          actorUserId
        );

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'STOCK_MOVEMENT_RECORDED', 'stock_movements', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          movementId,
          JSON.stringify({
            productId: input.productId,
            movementType: input.movementType,
            deltaBase,
            balanceAfterBase: nextQtyBase,
            newCumpXof: nextCumpXof,
          })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listMovements({ productId: input.productId, limit: 20 }).find(
      (m) => m.id === movementId
    )!;
  }

  listInventories(): StockInventorySummaryDTO[] {
    return this.db
      .prepare(
        `SELECT si.id, si.inventory_number AS inventoryNumber, si.status, si.note,
                (SELECT COUNT(*) FROM stock_inventory_lines sil WHERE sil.inventory_id = si.id) AS linesCount,
                COALESCE((SELECT SUM(sil.variance_base) FROM stock_inventory_lines sil WHERE sil.inventory_id = si.id), 0) AS totalVarianceBase,
                COALESCE(ec.full_name, uc.username) AS createdByName,
                COALESCE(ev.full_name, uv.username) AS validatedByName,
                si.validated_at AS validatedAt,
                si.created_at AS createdAt
         FROM stock_inventories si
         JOIN users uc ON uc.id = si.created_by_user_id
         LEFT JOIN employees ec ON ec.id = uc.employee_id
         LEFT JOIN users uv ON uv.id = si.validated_by_user_id
         LEFT JOIN employees ev ON ev.id = uv.employee_id
         ORDER BY si.created_at DESC`
      )
      .all() as unknown as StockInventorySummaryDTO[];
  }

  validateInventory(
    actorUserId: string,
    lines: InventoryCountLineInput[],
    note?: string
  ): StockInventorySummaryDTO {
    if (lines.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'Au moins une ligne de comptage est requise.', 400);
    }

    const seenProducts = new Set<string>();
    for (const line of lines) {
      if (seenProducts.has(line.productId)) {
        throw new AppError('VALIDATION_ERROR', 'Produit en double dans le comptage inventaire.', 400);
      }
      seenProducts.add(line.productId);
      assertNonNegativeXof(line.countedBase, 'Quantité comptée');
    }

    const inventoryId = crypto.randomUUID();
    const invNumber = `INV-${Date.now().toString().slice(-8)}`;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO stock_inventories (
             id, inventory_number, status, note, created_by_user_id, validated_by_user_id,
             validated_at
           ) VALUES (?, ?, 'VALIDATED', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
        )
        .run(inventoryId, invNumber, note?.trim() || null, actorUserId, actorUserId);

      for (const line of lines) {
        const prod = this.db
          .prepare(
            `SELECT p.id, p.weighted_avg_cost_xof AS unitCostXof, COALESCE(sb.quantity_base, 0) AS theoreticalBase
             FROM products p
             LEFT JOIN stock_balances sb ON sb.product_id = p.id
             WHERE p.id = ?`
          )
          .get(line.productId) as
          | { id: string; unitCostXof: number; theoreticalBase: number }
          | undefined;

        if (!prod) {
          throw new AppError('NOT_FOUND', `Produit introuvable dans l'inventaire (${line.productId}).`, 404);
        }

        const varianceBase = line.countedBase - prod.theoreticalBase;

        this.db
          .prepare(
            `INSERT INTO stock_inventory_lines (
               id, inventory_id, product_id, theoretical_base, counted_base, variance_base, unit_cost_xof
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            inventoryId,
            line.productId,
            prod.theoreticalBase,
            line.countedBase,
            varianceBase,
            prod.unitCostXof
          );

        if (varianceBase !== 0) {
          this.db
            .prepare(
              `INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base, updated_at)
               VALUES (?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
               ON CONFLICT(product_id) DO UPDATE SET
                 quantity_base = excluded.quantity_base,
                 updated_at = excluded.updated_at`
            )
            .run(line.productId, line.countedBase);

          this.db
            .prepare(
              `INSERT INTO stock_movements (
                 id, product_id, movement_type, quantity_delta_base, unit_cost_xof,
                 balance_after_base, reference_type, reference_id, note, user_id
               ) VALUES (?, ?, 'INVENTORY_ADJUSTMENT', ?, ?, ?, 'STOCK_INVENTORY', ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              line.productId,
              varianceBase,
              prod.unitCostXof,
              line.countedBase,
              inventoryId,
              note?.trim() || `Inventaire ${invNumber}`,
              actorUserId
            );
        }
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'INVENTORY_VALIDATED', 'stock_inventories', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          inventoryId,
          JSON.stringify({ inventoryNumber: invNumber, linesCount: lines.length })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listInventories().find((i) => i.id === inventoryId)!;
  }
}
