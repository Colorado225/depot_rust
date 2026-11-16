-- DepotPro CI — Migration 0014 : LOT 10 Décision n°2 (port Rust natif)
--
-- Le pont « backend Node sidecar » de la migration 0013 est RÉVOQUÉ sur décision
-- utilisateur du 15/11/2026 : « engage le port Rust complet avant d'aller plus
-- loin sur la distribution ». L'architecture cible redevient celle du §3 :
--   React UI → Tauri Commands → Domain Services Rust → Repositories SQLx → SQLite.
--
-- Aucune donnée commerciale n'est créée, modifiée ou supprimée.
-- app.lot_current reste LOT_9 (dernier lot validé) ; app.lot_in_progress = LOT_10.
-- Les clés ci-dessous ÉCRASENT celles de 0013 (INSERT OR REPLACE) : les anciennes
-- décisions restent lisibles dans l'historique des migrations mais ne font plus foi.

INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('adr.desktop_runtime', 'RUST_SQLX_NATIVE', 'ARCHITECTURE', 'LOT 10 décision n°2 : la logique métier critique est exécutée et validée dans le backend Rust (Tauri Commands, services de domaine, dépôts SQLx). Le backend Node reste disponible uniquement pour le preview web et comme béquille transitoire pendant le port.'),
  ('adr.desktop_parity', 'RUST_COMMANDS_LEDGER_95', 'ARCHITECTURE', 'LOT 10 : le registre src-tauri/parity/commands.json fait foi pour les 95 commandes. Chaque commande doit avoir un handler #[tauri::command] enregistré dans lib.rs. Le pont HTTP local est une béquille de migration, retirée à 95/95.'),
  ('adr.desktop_migrations', 'SCHEMA_MIGRATIONS_SHA256_SINGLE_OWNER', 'ARCHITECTURE', 'LOT 10 : le runtime Rust applique lui-même les migrations SQL versionnées dans la table schema_migrations avec sommes de contrôle SHA-256, à l''identique du LOT 9. sqlx::migrate! et _sqlx_migrations sont interdits : un seul propriétaire du schéma.'),
  ('adr.desktop_transport', 'TAURI_IPC_PRIMARY', 'ARCHITECTURE', 'LOT 10 : en mode desktop, invokeBackend() appelle prioritairement la commande Tauri du même nom. Les commandes non encore portées utilisent le pont HTTP local transitoire, jamais un service distant.'),
  ('adr.rust_port_ledger', 'src-tauri/parity/commands.json', 'ARCHITECTURE', 'LOT 10 : registre de parité versionné, généré par scripts/gen-rust-ledger.mjs et vérifié par tests/lot10-rust-port.test.ts. Statuts : RUST (implémenté et enregistré), A_PORTER (tranche planifiée + repli transitoire).'),
  ('adr.rust_port_restore', 'PENDING_RESTORE_APPLIED_BEFORE_POOL_OPEN', 'ARCHITECTURE', 'LOT 10 : cohérence LOT 9 préservée. Le runtime Rust applique restore-pending.json AVANT l''ouverture du pool applicatif, avec vérification SHA-256, integrity_check, foreign_key_check, copie pré-restore et rollback fichier.'),
  ('app.lot_in_progress', 'LOT_10', 'EXECUTION', 'Lot en cours : port Rust complet (tranche 1 engagée). Le dernier lot validé reste LOT_9.');
