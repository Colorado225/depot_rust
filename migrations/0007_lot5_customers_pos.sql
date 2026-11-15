-- DepotPro CI — Migration 0007: LOT 5 Clients, Créances, POS & Ventes
-- Remarque : aucune instruction PRAGMA dans ce fichier (géré au démarrage SQLite).

ALTER TABLE customers ADD COLUMN email TEXT;
ALTER TABLE customers ADD COLUMN due_days INTEGER NOT NULL DEFAULT 15 CHECK (due_days >= 0 AND due_days <= 365);
ALTER TABLE customers ADD COLUMN notes TEXT;

ALTER TABLE sales ADD COLUMN due_at TEXT;
ALTER TABLE sales ADD COLUMN note TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_type_active ON customers(customer_type, is_active);
CREATE INDEX IF NOT EXISTS idx_sales_status_created ON sales(status, created_at);

INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('app.lot_current', 'LOT_5', 'EXECUTION', 'Lot courant validé : Clients, Créances, Point de Vente POS, Paiements multi-canaux et Tickets.');
