-- DepotPro CI — Migration 0013: LOT 10 Décision d'architecture desktop (runtime unique)
-- Aucune donnée commerciale n'est créée, modifiée ou supprimée.
-- app.lot_current reste LOT_9 : c'est le dernier lot VALIDÉ. Le lot en cours est
-- suivi séparément pour ne jamais déclarer un lot terminé avant ses tests.

INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('app.lot_in_progress', 'LOT_10', 'EXECUTION', 'Lot en cours de développement : distribution desktop. Le dernier lot validé reste LOT_9.'),
  ('adr.desktop_runtime', 'SINGLE_NODE_SQLITE_BACKEND_TAURI_SIDECAR', 'ARCHITECTURE', 'LOT 10 : un seul moteur métier (Node/Express + node:sqlite) pour le navigateur ET pour Tauri. La coquille Tauri 2 démarre ce backend en sidecar local et expose uniquement deux commandes de pont (origine du backend, état). Aucune duplication des dépôts métier en Rust/SQLx.'),
  ('adr.desktop_parity', 'HTTP_COMMAND_MAP_SHARED_BY_ALL_RUNTIMES', 'ARCHITECTURE', 'LOT 10 : les 95 commandes de COMMAND_HTTP_MAP sont servies par le même serveur local dans tous les runtimes. La branche __TAURI_INTERNALS__.invoke, qui court-circuitait le pont HTTP vers 21 commandes Rust incomplètes, est supprimée.'),
  ('adr.desktop_migrations', 'NODE_SCHEMA_MIGRATIONS_SINGLE_OWNER', 'ARCHITECTURE', 'LOT 10 : le backend Node est seul propriétaire du schéma (schema_migrations + checksums SHA-256). Le runtime Rust n''exécute plus sqlx::migrate! sur la base applicative, ce qui élimine le double système de migrations identifié au LOT 9.'),
  ('adr.desktop_transport', 'LOCALHOST_LOOPBACK_CSP_CONNECT_SRC', 'ARCHITECTURE', 'LOT 10 : en mode desktop, la webview appelle le backend sur 127.0.0.1 via une origine résolue au démarrage. La CSP autorise explicitement connect-src vers cette origine ; aucun service distant, fonctionnement 100 % hors ligne.');
