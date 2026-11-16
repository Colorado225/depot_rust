-- DepotPro CI — Migration 0012: LOT 9 Portabilité des sauvegardes (import support amovible)
-- Aucune donnée commerciale n'est créée, modifiée ou supprimée.
-- ALTER TABLE ... ADD COLUMN est non destructif : les lignes existantes reçoivent 'LOCAL'.
-- Les apostrophes sont doublées (SQL standard) : aucun backslash dans les libellés.

ALTER TABLE backup_history ADD COLUMN origin TEXT NOT NULL DEFAULT 'LOCAL'
  CHECK (origin IN ('LOCAL', 'IMPORTED'));

CREATE INDEX IF NOT EXISTS idx_backup_history_origin_created
  ON backup_history(origin, created_at DESC);

INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('adr.restore_portability', 'IMPORT_DB_SHA256_MANIFEST_VERIFIED', 'ARCHITECTURE', 'Une sauvegarde .db déposée depuis une clé USB est importée sous un nom généré côté serveur, contrôlée (magic SQLite, integrity_check, foreign_key_check, SHA-256) et accompagnée d''un manifeste JSON vérifiable hors ligne avant toute restauration.'),
  ('backup.import_max_bytes', '268435456', 'BACKUP', 'Taille maximale autorisée pour l''import d''une sauvegarde externe (256 Mo).');
