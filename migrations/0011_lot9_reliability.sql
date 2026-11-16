-- DepotPro CI — Migration 0011: LOT 9 Fiabilisation (sauvegardes, restauration, sécurité, performance)
-- Remarque : aucune instruction PRAGMA dans ce fichier (géré au démarrage SQLite).
-- Aucune donnée commerciale n'est créée, modifiée ou supprimée par cette migration :
-- elle n'ajoute que des index, des clés de configuration et des décisions d'architecture.

-- Performance : accélération des contrôles d'audit, de l'historique des sauvegardes
-- et des jointures de rapports encore non indexées.
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON audit_logs(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backup_history_created
  ON backup_history(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backup_history_type_created
  ON backup_history(backup_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_created
  ON payments(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sale_items_product
  ON sale_items(product_id);

CREATE INDEX IF NOT EXISTS idx_cash_movements_created
  ON cash_movements(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment
  ON payment_allocations(payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_target
  ON payment_allocations(target_type, target_id);

-- Configuration locale des sauvegardes (modifiable par le propriétaire via l'API LOT 9).
-- Les valeurs restent des chaînes TEXT : system_meta est un référentiel clé/valeur générique.
INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('backup.auto_enabled', '1', 'BACKUP', 'Sauvegarde automatique locale active (1) ou suspendue (0).'),
  ('backup.auto_interval_hours', '24', 'BACKUP', 'Intervalle en heures entre deux sauvegardes automatiques.'),
  ('backup.retention_count', '7', 'BACKUP', 'Nombre de sauvegardes automatiques conservées (les plus anciennes sont purgées).'),
  ('backup.last_auto_at', '', 'BACKUP', 'Horodatage ISO UTC de la dernière sauvegarde automatique réussie.'),
  ('backup.last_restore_at', '', 'BACKUP', 'Horodatage ISO UTC de la dernière restauration appliquée.'),
  ('adr.backup_strategy', 'VACUUM_INTO_SHA256_VERIFIED_RESTORE', 'ARCHITECTURE', 'Instantané SQLite cohérent avec WAL via VACUUM INTO, empreinte SHA-256, vérification integrity_check + foreign_key_check et restauration sur base séparée avant activation au redémarrage.'),
  ('adr.restore_safety', 'PRE_RESTORE_BACKUP_AND_RESTART', 'ARCHITECTURE', 'Aucune base active écrasée à chaud : sauvegarde préalable obligatoire, confirmation explicite, activation différée au prochain démarrage hors ligne.'),
  ('app.lot_current', 'LOT_9', 'EXECUTION', 'Lot courant : LOT 9 Fiabilisation (sauvegardes, restauration, contrôles de non-régression ; distribution LOT 10 non entamée).');
