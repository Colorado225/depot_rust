-- DepotPro CI — Migration 0008: LOT 6 Gestion des Consignes & Emballages
-- Remarque : aucune instruction PRAGMA dans ce fichier (géré au démarrage SQLite).

CREATE INDEX IF NOT EXISTS idx_consignment_balances_holder
  ON consignment_balances(holder_type, holder_id);

CREATE INDEX IF NOT EXISTS idx_consignment_movements_pkg_date
  ON consignment_movements(packaging_type_id, created_at);

INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('app.lot_current', 'LOT_6', 'EXECUTION', 'Lot courant validé : Gestion des Consignes, Bouteilles & Casiers vides, Retours et Remboursements.');
