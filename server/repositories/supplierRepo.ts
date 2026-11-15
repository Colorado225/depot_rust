import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertNonNegativeXof } from '../domain/money.ts';
import { AppError } from '../error.ts';

export type SupplierType = 'BRASSERIE' | 'DISTRIBUTEUR' | 'IMPORTATEUR' | 'AUTRE';

export interface SupplierDTO {
  id: string;
  name: string;
  supplierType: SupplierType;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxId: string | null;
  paymentTermsDays: number;
  notes: string | null;
  balanceDueXof: number;
  linkedProductsCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveSupplierInput {
  name: string;
  supplierType: SupplierType;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxId?: string | null;
  paymentTermsDays: number;
  notes?: string | null;
}

export class SupplierRepository {
  constructor(private readonly db: DatabaseSync) {}

  listSuppliers(filter: { search?: string; includeInactive?: boolean } = {}): SupplierDTO[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (!filter.includeInactive) {
      clauses.push('s.is_active = 1');
    }
    if (filter.search?.trim()) {
      const q = `%${filter.search.trim().toLowerCase()}%`;
      clauses.push("(LOWER(s.name) LIKE ? OR LOWER(COALESCE(s.phone, '')) LIKE ? OR LOWER(COALESCE(s.tax_id, '')) LIKE ?)");
      params.push(q, q, q);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.supplier_type AS supplierType, s.phone, s.email, s.address,
                s.tax_id AS taxId, s.payment_terms_days AS paymentTermsDays, s.notes,
                s.balance_due_xof AS balanceDueXof,
                (SELECT COUNT(*) FROM products p WHERE p.preferred_supplier_id = s.id AND p.is_active = 1) AS linkedProductsCount,
                s.is_active AS isActive, s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM suppliers s
         ${whereSql}
         ORDER BY s.name ASC`
      )
      .all(...params) as Array<Omit<SupplierDTO, 'isActive'> & { isActive: number }>;

    return rows.map((r) => ({
      ...r,
      isActive: r.isActive === 1,
    }));
  }

  createSupplier(actorUserId: string, input: SaveSupplierInput): SupplierDTO {
    const cleanName = input.name.trim();
    const existing = this.db
      .prepare('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?)')
      .get(cleanName);
    if (existing) {
      throw new AppError('CONFLICT', `Un fournisseur nommé « ${cleanName} » existe déjà.`, 409);
    }

    const terms = assertNonNegativeXof(input.paymentTermsDays, 'Délai de paiement');
    const id = crypto.randomUUID();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `INSERT INTO suppliers (
             id, name, supplier_type, phone, email, address, tax_id, payment_terms_days, notes, balance_due_xof, is_active
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`
        )
        .run(
          id,
          cleanName,
          input.supplierType,
          input.phone?.trim() || null,
          input.email?.trim() || null,
          input.address?.trim() || null,
          input.taxId?.trim() || null,
          terms,
          input.notes?.trim() || null
        );

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'SUPPLIER_CREATED', 'suppliers', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          id,
          JSON.stringify({ name: cleanName, supplierType: input.supplierType })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listSuppliers({ includeInactive: true }).find((s) => s.id === id)!;
  }

  updateSupplier(actorUserId: string, supplierId: string, input: SaveSupplierInput): SupplierDTO {
    const existing = this.db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
    if (!existing) {
      throw new AppError('NOT_FOUND', 'Fournisseur introuvable.', 404);
    }

    const cleanName = input.name.trim();
    const dup = this.db
      .prepare('SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND id != ?')
      .get(cleanName, supplierId);
    if (dup) {
      throw new AppError('CONFLICT', `Un autre fournisseur porte déjà le nom « ${cleanName} ».`, 409);
    }

    const terms = assertNonNegativeXof(input.paymentTermsDays, 'Délai de paiement');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE suppliers
           SET name = ?, supplier_type = ?, phone = ?, email = ?, address = ?,
               tax_id = ?, payment_terms_days = ?, notes = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(
          cleanName,
          input.supplierType,
          input.phone?.trim() || null,
          input.email?.trim() || null,
          input.address?.trim() || null,
          input.taxId?.trim() || null,
          terms,
          input.notes?.trim() || null,
          supplierId
        );

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'SUPPLIER_UPDATED', 'suppliers', ?, ?)`
        )
        .run(crypto.randomUUID(), actorUserId, supplierId, JSON.stringify({ name: cleanName }));

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listSuppliers({ includeInactive: true }).find((s) => s.id === supplierId)!;
  }

  toggleSupplierActive(actorUserId: string, supplierId: string, isActive: boolean): SupplierDTO {
    const existing = this.db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
    if (!existing) {
      throw new AppError('NOT_FOUND', 'Fournisseur introuvable.', 404);
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(
          `UPDATE suppliers SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), sync_version = sync_version + 1 WHERE id = ?`
        )
        .run(isActive ? 1 : 0, supplierId);

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, ?, 'suppliers', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          isActive ? 'SUPPLIER_RESTORED' : 'SUPPLIER_ARCHIVED',
          supplierId,
          JSON.stringify({ isActive })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.listSuppliers({ includeInactive: true }).find((s) => s.id === supplierId)!;
  }
}
