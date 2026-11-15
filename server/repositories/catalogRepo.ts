import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertNonNegativeXof } from '../domain/money.ts';
import { AppError } from '../error.ts';

export interface CategoryDTO {
  id: string;
  name: string;
  description: string | null;
  productCount: number;
  createdAt: string;
}

export interface BrandDTO {
  id: string;
  name: string;
  productCount: number;
  createdAt: string;
}

export interface UnitDTO {
  id: string;
  code: string;
  name: string;
  isBaseUnit: boolean;
}

export interface PackagingTypeDTO {
  id: string;
  code: string;
  name: string;
  kind: 'BOTTLE' | 'CRATE' | 'OTHER';
  depositAmountXof: number;
  createdAt: string;
}

export interface ProductUnitDTO {
  id: string;
  productId: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  conversionToBase: number;
  wholesalePriceXof: number;
  retailPriceXof: number;
  barcode: string | null;
  isDefaultSaleUnit: boolean;
}

export interface ProductDTO {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  brandId: string | null;
  brandName: string | null;
  preferredSupplierId: string | null;
  preferredSupplierName: string | null;
  formatLabel: string | null;
  baseUnitId: string;
  baseUnitName: string;
  bottlePackagingTypeId: string | null;
  bottlePackagingName: string | null;
  bottleDepositXof: number;
  cratePackagingTypeId: string | null;
  cratePackagingName: string | null;
  crateDepositXof: number;
  purchasePriceXof: number;
  weightedAvgCostXof: number;
  wholesalePriceXof: number;
  retailPriceXof: number;
  alertThresholdBase: number;
  stockQuantityBase: number;
  isActive: boolean;
  units: ProductUnitDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductUnitInput {
  unitId: string;
  conversionToBase: number;
  wholesalePriceXof: number;
  retailPriceXof: number;
  barcode?: string | null;
  isDefaultSaleUnit?: boolean;
}

export interface SaveProductInput {
  sku: string;
  barcode?: string | null;
  name: string;
  categoryId?: string | null;
  brandId?: string | null;
  preferredSupplierId?: string | null;
  formatLabel?: string | null;
  baseUnitId: string;
  bottlePackagingTypeId?: string | null;
  cratePackagingTypeId?: string | null;
  purchasePriceXof: number;
  wholesalePriceXof: number;
  retailPriceXof: number;
  alertThresholdBase: number;
  units: ProductUnitInput[];
}

export interface ProductFilter {
  search?: string;
  categoryId?: string;
  brandId?: string;
  includeInactive?: boolean;
}

export class CatalogRepository {
  constructor(private readonly db: DatabaseSync) {}

  listCategories(): CategoryDTO[] {
    return this.db
      .prepare(
        `SELECT c.id, c.name, c.description, c.created_at AS createdAt,
                (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS productCount
         FROM categories c
         ORDER BY c.name ASC`
      )
      .all() as unknown as CategoryDTO[];
  }

  createCategory(actorUserId: string, name: string, description?: string | null): CategoryDTO {
    const cleanName = name.trim();
    const existing = this.db
      .prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)')
      .get(cleanName);
    if (existing) {
      throw new AppError('CONFLICT', `La catégorie « ${cleanName} » existe déjà.`, 409);
    }

    const id = crypto.randomUUID();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare('INSERT INTO categories (id, name, description) VALUES (?, ?, ?)')
        .run(id, cleanName, description?.trim() || null);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'CATEGORY_CREATED', 'categories', ?, ?)`
        )
        .run(crypto.randomUUID(), actorUserId, id, JSON.stringify({ name: cleanName }));

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listCategories().find((c) => c.id === id)!;
  }

  listBrands(): BrandDTO[] {
    return this.db
      .prepare(
        `SELECT b.id, b.name, b.created_at AS createdAt,
                (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id AND p.is_active = 1) AS productCount
         FROM brands b
         ORDER BY b.name ASC`
      )
      .all() as unknown as BrandDTO[];
  }

  createBrand(actorUserId: string, name: string): BrandDTO {
    const cleanName = name.trim();
    const existing = this.db
      .prepare('SELECT id FROM brands WHERE LOWER(name) = LOWER(?)')
      .get(cleanName);
    if (existing) {
      throw new AppError('CONFLICT', `La marque « ${cleanName} » existe déjà.`, 409);
    }

    const id = crypto.randomUUID();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('INSERT INTO brands (id, name) VALUES (?, ?)').run(id, cleanName);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'BRAND_CREATED', 'brands', ?, ?)`
        )
        .run(crypto.randomUUID(), actorUserId, id, JSON.stringify({ name: cleanName }));

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listBrands().find((b) => b.id === id)!;
  }

  listUnits(): UnitDTO[] {
    const rows = this.db
      .prepare('SELECT id, code, name, is_base_unit AS isBaseUnit FROM units ORDER BY is_base_unit DESC, name ASC')
      .all() as Array<{ id: string; code: string; name: string; isBaseUnit: number }>;

    return rows.map((u) => ({
      ...u,
      isBaseUnit: u.isBaseUnit === 1,
    }));
  }

  listPackagingTypes(): PackagingTypeDTO[] {
    return this.db
      .prepare(
        `SELECT id, code, name, kind, deposit_amount_xof AS depositAmountXof, created_at AS createdAt
         FROM packaging_types
         ORDER BY kind ASC, name ASC`
      )
      .all() as unknown as PackagingTypeDTO[];
  }

  createPackagingType(
    actorUserId: string,
    input: { code: string; name: string; kind: 'BOTTLE' | 'CRATE' | 'OTHER'; depositAmountXof: number }
  ): PackagingTypeDTO {
    const cleanCode = input.code.trim().toUpperCase();
    const cleanName = input.name.trim();
    const deposit = assertNonNegativeXof(input.depositAmountXof, 'Montant de consigne');

    const existing = this.db
      .prepare('SELECT id FROM packaging_types WHERE UPPER(code) = ?')
      .get(cleanCode);
    if (existing) {
      throw new AppError('CONFLICT', `Le code emballage « ${cleanCode} » existe déjà.`, 409);
    }

    const id = crypto.randomUUID();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          'INSERT INTO packaging_types (id, code, name, kind, deposit_amount_xof) VALUES (?, ?, ?, ?, ?)'
        )
        .run(id, cleanCode, cleanName, input.kind, deposit);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'PACKAGING_TYPE_CREATED', 'packaging_types', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          id,
          JSON.stringify({ code: cleanCode, depositAmountXof: deposit })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listPackagingTypes().find((p) => p.id === id)!;
  }

  updatePackagingType(
    actorUserId: string,
    id: string,
    input: { name: string; kind: 'BOTTLE' | 'CRATE' | 'OTHER'; depositAmountXof: number }
  ): PackagingTypeDTO {
    const existing = this.db.prepare('SELECT id FROM packaging_types WHERE id = ?').get(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', 'Type d’emballage introuvable.', 404);
    }

    const deposit = assertNonNegativeXof(input.depositAmountXof, 'Montant de consigne');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE packaging_types
           SET name = ?, kind = ?, deposit_amount_xof = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(input.name.trim(), input.kind, deposit, id);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'PACKAGING_TYPE_UPDATED', 'packaging_types', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          id,
          JSON.stringify({ name: input.name.trim(), depositAmountXof: deposit })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listPackagingTypes().find((p) => p.id === id)!;
  }

  listProducts(filter: ProductFilter = {}): ProductDTO[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (!filter.includeInactive) {
      clauses.push('p.is_active = 1');
    }
    if (filter.categoryId) {
      clauses.push('p.category_id = ?');
      params.push(filter.categoryId);
    }
    if (filter.brandId) {
      clauses.push('p.brand_id = ?');
      params.push(filter.brandId);
    }
    if (filter.search && filter.search.trim()) {
      const q = `%${filter.search.trim().toLowerCase()}%`;
      clauses.push(
        `(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(COALESCE(p.barcode, '')) LIKE ? OR EXISTS (SELECT 1 FROM product_units pu2 WHERE pu2.product_id = p.id AND LOWER(COALESCE(pu2.barcode, '')) LIKE ?))`
      );
      params.push(q, q, q, q);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT p.id, p.sku, p.barcode, p.name,
                p.category_id AS categoryId, c.name AS categoryName,
                p.brand_id AS brandId, b.name AS brandName,
                p.preferred_supplier_id AS preferredSupplierId,
                sp.name AS preferredSupplierName,
                p.format_label AS formatLabel,
                p.base_unit_id AS baseUnitId, u.name AS baseUnitName,
                p.bottle_packaging_type_id AS bottlePackagingTypeId,
                bp.name AS bottlePackagingName,
                COALESCE(bp.deposit_amount_xof, 0) AS bottleDepositXof,
                p.crate_packaging_type_id AS cratePackagingTypeId,
                cp.name AS cratePackagingName,
                COALESCE(cp.deposit_amount_xof, 0) AS crateDepositXof,
                p.purchase_price_xof AS purchasePriceXof,
                p.weighted_avg_cost_xof AS weightedAvgCostXof,
                p.wholesale_price_xof AS wholesalePriceXof,
                p.retail_price_xof AS retailPriceXof,
                p.alert_threshold_base AS alertThresholdBase,
                COALESCE(sb.quantity_base, 0) AS stockQuantityBase,
                p.is_active AS isActive,
                p.created_at AS createdAt,
                p.updated_at AS updatedAt
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN suppliers sp ON sp.id = p.preferred_supplier_id
         JOIN units u ON u.id = p.base_unit_id
         LEFT JOIN packaging_types bp ON bp.id = p.bottle_packaging_type_id
         LEFT JOIN packaging_types cp ON cp.id = p.crate_packaging_type_id
         LEFT JOIN stock_balances sb ON sb.product_id = p.id
         ${whereSql}
         ORDER BY p.name ASC`
      )
      .all(...params) as Array<Omit<ProductDTO, 'isActive' | 'units'> & { isActive: number }>;

    const unitStmt = this.db.prepare(
      `SELECT pu.id, pu.product_id AS productId, pu.unit_id AS unitId,
              u.code AS unitCode, u.name AS unitName,
              pu.conversion_to_base AS conversionToBase,
              pu.wholesale_price_xof AS wholesalePriceXof,
              pu.retail_price_xof AS retailPriceXof,
              pu.barcode,
              pu.is_default_sale_unit AS isDefaultSaleUnit
       FROM product_units pu
       JOIN units u ON u.id = pu.unit_id
       WHERE pu.product_id = ?
       ORDER BY pu.conversion_to_base ASC`
    );

    return rows.map((row) => {
      const unitRows = unitStmt.all(row.id) as Array<
        Omit<ProductUnitDTO, 'isDefaultSaleUnit'> & { isDefaultSaleUnit: number }
      >;
      return {
        ...row,
        isActive: row.isActive === 1,
        units: unitRows.map((u) => ({
          ...u,
          isDefaultSaleUnit: u.isDefaultSaleUnit === 1,
        })),
      };
    });
  }

  getProductById(productId: string): ProductDTO {
    const found = this.listProducts({ includeInactive: true }).find((p) => p.id === productId);
    if (!found) {
      throw new AppError('NOT_FOUND', 'Produit introuvable.', 404);
    }
    return found;
  }

  createProduct(actorUserId: string, input: SaveProductInput): ProductDTO {
    const validated = this.validateProductInput(input, null);
    const productId = crypto.randomUUID();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO products (
             id, sku, barcode, name, category_id, brand_id, preferred_supplier_id, format_label,
             base_unit_id, packaging_type_id, bottle_packaging_type_id, crate_packaging_type_id,
             purchase_price_xof, weighted_avg_cost_xof, wholesale_price_xof, retail_price_xof,
             alert_threshold_base, is_active
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          productId,
          validated.sku,
          validated.barcode,
          validated.name,
          validated.categoryId,
          validated.brandId,
          validated.preferredSupplierId,
          validated.formatLabel,
          validated.baseUnitId,
          validated.cratePackagingTypeId ?? validated.bottlePackagingTypeId,
          validated.bottlePackagingTypeId,
          validated.cratePackagingTypeId,
          validated.purchasePriceXof,
          validated.purchasePriceXof,
          validated.wholesalePriceXof,
          validated.retailPriceXof,
          validated.alertThresholdBase
        );

      const insertUnitStmt = this.db.prepare(
        `INSERT INTO product_units (
           id, product_id, unit_id, conversion_to_base, wholesale_price_xof,
           retail_price_xof, barcode, is_default_sale_unit
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const unit of validated.units) {
        insertUnitStmt.run(
          crypto.randomUUID(),
          productId,
          unit.unitId,
          unit.conversionToBase,
          unit.wholesalePriceXof,
          unit.retailPriceXof,
          unit.barcode,
          unit.isDefaultSaleUnit ? 1 : 0
        );
      }

      this.db
        .prepare(
          'INSERT INTO stock_balances (product_id, quantity_base, damaged_quantity_base) VALUES (?, 0, 0)'
        )
        .run(productId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'PRODUCT_CREATED', 'products', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          productId,
          JSON.stringify({ sku: validated.sku, name: validated.name, unitsCount: validated.units.length })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getProductById(productId);
  }

  updateProduct(actorUserId: string, productId: string, input: SaveProductInput): ProductDTO {
    const existing = this.db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (!existing) {
      throw new AppError('NOT_FOUND', 'Produit introuvable.', 404);
    }

    const validated = this.validateProductInput(input, productId);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE products
           SET sku = ?, barcode = ?, name = ?, category_id = ?, brand_id = ?, preferred_supplier_id = ?, format_label = ?,
               base_unit_id = ?, packaging_type_id = ?, bottle_packaging_type_id = ?, crate_packaging_type_id = ?,
               purchase_price_xof = ?, wholesale_price_xof = ?, retail_price_xof = ?,
               alert_threshold_base = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(
          validated.sku,
          validated.barcode,
          validated.name,
          validated.categoryId,
          validated.brandId,
          validated.preferredSupplierId,
          validated.formatLabel,
          validated.baseUnitId,
          validated.cratePackagingTypeId ?? validated.bottlePackagingTypeId,
          validated.bottlePackagingTypeId,
          validated.cratePackagingTypeId,
          validated.purchasePriceXof,
          validated.wholesalePriceXof,
          validated.retailPriceXof,
          validated.alertThresholdBase,
          productId
        );

      // Mise à jour sûre des conditionnements sans casser d'éventuelles références
      const existingUnits = this.db
        .prepare('SELECT id, unit_id AS unitId FROM product_units WHERE product_id = ?')
        .all(productId) as Array<{ id: string; unitId: string }>;

      const existingByUnitId = new Map(existingUnits.map((u) => [u.unitId, u.id]));
      const incomingUnitIds = new Set(validated.units.map((u) => u.unitId));

      for (const old of existingUnits) {
        if (!incomingUnitIds.has(old.unitId)) {
          this.db.prepare('DELETE FROM product_units WHERE id = ?').run(old.id);
        }
      }

      const updateUnitStmt = this.db.prepare(
        `UPDATE product_units
         SET conversion_to_base = ?, wholesale_price_xof = ?, retail_price_xof = ?,
             barcode = ?, is_default_sale_unit = ?
         WHERE id = ?`
      );
      const insertUnitStmt = this.db.prepare(
        `INSERT INTO product_units (
           id, product_id, unit_id, conversion_to_base, wholesale_price_xof,
           retail_price_xof, barcode, is_default_sale_unit
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const u of validated.units) {
        const existingId = existingByUnitId.get(u.unitId);
        if (existingId) {
          updateUnitStmt.run(
            u.conversionToBase,
            u.wholesalePriceXof,
            u.retailPriceXof,
            u.barcode,
            u.isDefaultSaleUnit ? 1 : 0,
            existingId
          );
        } else {
          insertUnitStmt.run(
            crypto.randomUUID(),
            productId,
            u.unitId,
            u.conversionToBase,
            u.wholesalePriceXof,
            u.retailPriceXof,
            u.barcode,
            u.isDefaultSaleUnit ? 1 : 0
          );
        }
      }

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'PRODUCT_UPDATED', 'products', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          productId,
          JSON.stringify({ sku: validated.sku, name: validated.name })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getProductById(productId);
  }

  toggleProductActive(actorUserId: string, productId: string, isActive: boolean): ProductDTO {
    const existing = this.db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (!existing) {
      throw new AppError('NOT_FOUND', 'Produit introuvable.', 404);
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE products SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), sync_version = sync_version + 1 WHERE id = ?`
        )
        .run(isActive ? 1 : 0, productId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, ?, 'products', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          isActive ? 'PRODUCT_RESTORED' : 'PRODUCT_ARCHIVED',
          productId,
          JSON.stringify({ isActive })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getProductById(productId);
  }

  private validateProductInput(input: SaveProductInput, currentProductId: string | null) {
    const sku = input.sku.trim().toUpperCase();
    const name = input.name.trim();
    const barcode = input.barcode?.trim() || null;

    if (!sku) throw new AppError('VALIDATION_ERROR', 'La référence SKU est obligatoire.', 400);
    if (name.length < 2) {
      throw new AppError('VALIDATION_ERROR', 'La désignation du produit est obligatoire.', 400);
    }

    const purchasePriceXof = assertNonNegativeXof(input.purchasePriceXof, "Prix d'achat");
    const wholesalePriceXof = assertNonNegativeXof(input.wholesalePriceXof, 'Prix de gros');
    const retailPriceXof = assertNonNegativeXof(input.retailPriceXof, 'Prix de détail');
    const alertThresholdBase = assertNonNegativeXof(input.alertThresholdBase, "Seuil d'alerte");

    // Unicité SKU
    const skuRow = this.db
      .prepare("SELECT id FROM products WHERE UPPER(sku) = ? AND id != COALESCE(?, '')")
      .get(sku, currentProductId);
    if (skuRow) {
      throw new AppError('CONFLICT', `La référence SKU « ${sku} » est déjà utilisée.`, 409);
    }

    // Vérification existence unité de base, catégorie, marque, emballages
    const baseUnit = this.db.prepare('SELECT id FROM units WHERE id = ?').get(input.baseUnitId);
    if (!baseUnit) {
      throw new AppError('NOT_FOUND', 'Unité de base introuvable.', 404);
    }

    const categoryId = input.categoryId?.trim() || null;
    if (categoryId && !this.db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)) {
      throw new AppError('NOT_FOUND', 'Catégorie introuvable.', 404);
    }

    const brandId = input.brandId?.trim() || null;
    if (brandId && !this.db.prepare('SELECT id FROM brands WHERE id = ?').get(brandId)) {
      throw new AppError('NOT_FOUND', 'Marque introuvable.', 404);
    }

    const preferredSupplierId = input.preferredSupplierId?.trim() || null;
    if (
      preferredSupplierId &&
      !this.db.prepare('SELECT id FROM suppliers WHERE id = ?').get(preferredSupplierId)
    ) {
      throw new AppError('NOT_FOUND', 'Fournisseur principal introuvable.', 404);
    }

    const bottlePackagingTypeId = input.bottlePackagingTypeId?.trim() || null;
    if (
      bottlePackagingTypeId &&
      !this.db.prepare('SELECT id FROM packaging_types WHERE id = ?').get(bottlePackagingTypeId)
    ) {
      throw new AppError('NOT_FOUND', 'Emballage bouteille introuvable.', 404);
    }

    const cratePackagingTypeId = input.cratePackagingTypeId?.trim() || null;
    if (
      cratePackagingTypeId &&
      !this.db.prepare('SELECT id FROM packaging_types WHERE id = ?').get(cratePackagingTypeId)
    ) {
      throw new AppError('NOT_FOUND', 'Emballage casier introuvable.', 404);
    }

    // Normalisation & validation des unités de vente configurées PAR PRODUIT
    const seenUnits = new Set<string>();
    const seenBarcodes = new Set<string>();

    if (barcode) {
      this.assertBarcodeAvailable(barcode, currentProductId);
      seenBarcodes.add(barcode);
    }

    const normalizedUnits: Array<{
      unitId: string;
      conversionToBase: number;
      wholesalePriceXof: number;
      retailPriceXof: number;
      barcode: string | null;
      isDefaultSaleUnit: boolean;
    }> = [];

    for (const u of input.units) {
      if (seenUnits.has(u.unitId)) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Une même unité de vente ne peut pas être déclarée deux fois pour le même produit.',
          400
        );
      }
      seenUnits.add(u.unitId);

      const unitRow = this.db.prepare('SELECT id FROM units WHERE id = ?').get(u.unitId);
      if (!unitRow) {
        throw new AppError('NOT_FOUND', `Unité de vente introuvable (${u.unitId}).`, 404);
      }

      if (!Number.isSafeInteger(u.conversionToBase) || u.conversionToBase < 1) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Le facteur de conversion doit être un entier supérieur ou égal à 1.',
          400
        );
      }

      if (u.unitId === input.baseUnitId && u.conversionToBase !== 1) {
        throw new AppError(
          'VALIDATION_ERROR',
          "L'unité de base du produit doit obligatoirement avoir une conversion égale à 1.",
          400
        );
      }

      const unitBarcode = u.barcode?.trim() || null;
      if (unitBarcode) {
        if (seenBarcodes.has(unitBarcode)) {
          throw new AppError(
            'CONFLICT',
            `Le code-barres « ${unitBarcode} » est dupliqué sur le même produit.`,
            409
          );
        }
        seenBarcodes.add(unitBarcode);
        this.assertBarcodeAvailable(unitBarcode, currentProductId);
      }

      normalizedUnits.push({
        unitId: u.unitId,
        conversionToBase: u.conversionToBase,
        wholesalePriceXof: assertNonNegativeXof(u.wholesalePriceXof, 'Prix de gros unité'),
        retailPriceXof: assertNonNegativeXof(u.retailPriceXof, 'Prix de détail unité'),
        barcode: unitBarcode,
        isDefaultSaleUnit: Boolean(u.isDefaultSaleUnit),
      });
    }

    // Garantit la présence de l'unité de base (conversion = 1)
    if (!seenUnits.has(input.baseUnitId)) {
      normalizedUnits.unshift({
        unitId: input.baseUnitId,
        conversionToBase: 1,
        wholesalePriceXof,
        retailPriceXof,
        barcode: null,
        isDefaultSaleUnit: normalizedUnits.every((u) => !u.isDefaultSaleUnit),
      });
    } else if (normalizedUnits.every((u) => !u.isDefaultSaleUnit)) {
      normalizedUnits[0].isDefaultSaleUnit = true;
    }

    return {
      sku,
      barcode,
      name,
      categoryId,
      brandId,
      preferredSupplierId,
      formatLabel: input.formatLabel?.trim() || null,
      baseUnitId: input.baseUnitId,
      bottlePackagingTypeId,
      cratePackagingTypeId,
      purchasePriceXof,
      wholesalePriceXof,
      retailPriceXof,
      alertThresholdBase,
      units: normalizedUnits,
    };
  }

  private assertBarcodeAvailable(barcode: string, currentProductId: string | null) {
    const prodMatch = this.db
      .prepare("SELECT id FROM products WHERE barcode = ? AND id != COALESCE(?, '')")
      .get(barcode, currentProductId);
    if (prodMatch) {
      throw new AppError(
        'CONFLICT',
        `Le code-barres « ${barcode} » est déjà attribué à un autre produit.`,
        409
      );
    }

    const unitMatch = this.db
      .prepare("SELECT product_id AS productId FROM product_units WHERE barcode = ? AND product_id != COALESCE(?, '')")
      .get(barcode, currentProductId);
    if (unitMatch) {
      throw new AppError(
        'CONFLICT',
        `Le code-barres « ${barcode} » est déjà attribué à un conditionnement d'un autre produit.`,
        409
      );
    }
  }
}
