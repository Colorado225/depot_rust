-- DepotPro CI — Migration 0010: LOT 8 Rapports analytiques, Marges CUMP & Exports
-- Remarque : aucune instruction PRAGMA dans ce fichier (géré au démarrage SQLite).

CREATE INDEX IF NOT EXISTS idx_sales_status_created
  ON sales(status, created_at);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale_product
  ON sale_items(sale_id, product_id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_type_date
  ON stock_movements(movement_type, created_at);

INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('app.lot_current', 'LOT_8', 'EXECUTION', 'Lot courant validé : Rapports analytiques, Marges CUMP réelles, Créances/Dettes/Consignes et Exports CSV/PDF.');
