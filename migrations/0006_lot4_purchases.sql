-- DepotPro CI — Migration 0006: Achats, Réceptions, Retours & Règlements Fournisseurs (LOT 4)

ALTER TABLE purchase_orders ADD COLUMN received_amount_xof INTEGER NOT NULL DEFAULT 0 CHECK (received_amount_xof >= 0);
ALTER TABLE purchase_orders ADD COLUMN note TEXT;

ALTER TABLE goods_receipts ADD COLUMN supplier_invoice_ref TEXT;

CREATE TABLE IF NOT EXISTS supplier_returns (
  id TEXT PRIMARY KEY,
  return_number TEXT NOT NULL UNIQUE,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  total_return_xof INTEGER NOT NULL DEFAULT 0 CHECK (total_return_xof >= 0),
  note TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS supplier_return_items (
  id TEXT PRIMARY KEY,
  supplier_return_id TEXT NOT NULL REFERENCES supplier_returns(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  returned_qty INTEGER NOT NULL CHECK (returned_qty >= 1),
  base_qty INTEGER NOT NULL CHECK (base_qty >= 1),
  unit_cost_xof INTEGER NOT NULL CHECK (unit_cost_xof >= 0),
  line_total_xof INTEGER NOT NULL CHECK (line_total_xof >= 0)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id, created_at);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_po ON goods_receipts(purchase_order_id, received_at);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_po ON supplier_returns(purchase_order_id, created_at);

UPDATE system_meta
SET value = 'LOT_4',
    description = 'Lot courant : Achats fournisseurs, réceptions partielles/complètes, CUMP automatique et règlements dettes.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'app.lot_current';
