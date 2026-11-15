-- DepotPro CI — Migration 0005: Inventaires de Stock & Enrichissement Fournisseurs (LOT 3)

CREATE TABLE IF NOT EXISTS stock_inventories (
  id TEXT PRIMARY KEY,
  inventory_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'VALIDATED')),
  note TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  validated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stock_inventory_lines (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES stock_inventories(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  theoretical_base INTEGER NOT NULL CHECK (theoretical_base >= 0),
  counted_base INTEGER NOT NULL CHECK (counted_base >= 0),
  variance_base INTEGER NOT NULL,
  unit_cost_xof INTEGER NOT NULL CHECK (unit_cost_xof >= 0),
  UNIQUE (inventory_id, product_id)
);

-- Enrichissement du rôle des fournisseurs dans la base de données
ALTER TABLE suppliers ADD COLUMN supplier_type TEXT NOT NULL DEFAULT 'DISTRIBUTEUR'
  CHECK (supplier_type IN ('BRASSERIE', 'DISTRIBUTEUR', 'IMPORTATEUR', 'AUTRE'));
ALTER TABLE suppliers ADD COLUMN email TEXT;
ALTER TABLE suppliers ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0);
ALTER TABLE suppliers ADD COLUMN notes TEXT;

-- Relation N-N Produit <-> Fournisseur (prix négocié & référence fournisseur)
CREATE TABLE IF NOT EXISTS product_suppliers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_sku TEXT,
  last_unit_cost_xof INTEGER NOT NULL DEFAULT 0 CHECK (last_unit_cost_xof >= 0),
  is_preferred INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (product_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_inventories_created ON stock_inventories(created_at);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);
CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier ON product_suppliers(supplier_id);

UPDATE system_meta
SET value = 'LOT_3',
    description = 'Lot courant : Gestion des stocks, mouvements traçables, inventaires, CUMP et référentiel fournisseurs.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'app.lot_current';
