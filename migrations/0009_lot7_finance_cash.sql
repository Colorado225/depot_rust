-- DepotPro CI — Migration 0009: LOT 7 Finances, Caisse, Dépenses & Réconciliation multi-canaux
-- Remarque : aucune instruction PRAGMA dans ce fichier (géré au démarrage SQLite).

CREATE INDEX IF NOT EXISTS idx_cash_sessions_status_opened
  ON cash_sessions(status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_session_method
  ON payments(cash_session_id, payment_method, direction);

CREATE INDEX IF NOT EXISTS idx_expenses_date_category
  ON expenses(expense_date DESC, category_id);

CREATE INDEX IF NOT EXISTS idx_expenses_session
  ON expenses(cash_session_id);

INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('app.lot_current', 'LOT_7', 'EXECUTION', 'Lot courant validé : Finances, Sessions de caisse, Dépenses, Écarts & Réconciliation multi-canaux.');
