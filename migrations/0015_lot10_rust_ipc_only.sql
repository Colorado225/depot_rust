-- DepotPro CI — Migration 0015 : LOT 10 tranche 4 (95/95, pont HTTP retiré)
--
-- La béquille « sidecar Node / HTTP loopback » décrite en 0013 et conservée
-- transitoirement en 0014 est désormais SUPPRIMÉE de la coquille desktop.
-- Le moteur métier desktop est unique : React → Tauri IPC → services Rust →
-- dépôts SQLx → SQLite. Le backend Node/Express reste uniquement la référence
-- web/preview (Vite), jamais embarqué dans un installateur.
--
-- Aucune donnée commerciale n'est créée, modifiée ou supprimée.
-- app.lot_current reste LOT_9 (dernier lot fonctionnel validé) ;
-- app.lot_in_progress reste LOT_10 jusqu'aux builds natifs signés.
-- Les clés ci-dessous ÉCRASENT celles de 0014 (INSERT OR REPLACE) : les anciennes
-- décisions restent lisibles dans l'historique mais ne font plus foi.

INSERT OR REPLACE INTO system_meta (key, value, category, description) VALUES
  ('adr.desktop_runtime', 'RUST_SQLX_NATIVE_NO_SIDECAR', 'ARCHITECTURE', 'LOT 10 tranche 4 : la logique métier critique du desktop est exécutée et validée exclusivement dans le backend Rust. Aucun binaire Node, aucun serveur HTTP loopback et aucun sidecar ne sont embarqués dans la coquille Tauri.'),
  ('adr.desktop_transport', 'TAURI_IPC_ONLY_95_OF_95', 'ARCHITECTURE', 'LOT 10 : les 95 commandes du registre sont servies par tauriInvoke. Le chemin HTTP relatif de src/lib/ipc.ts est réservé au navigateur / preview web de référence ; il est interdit en mode Tauri, quel que soit le mode de recette.'),
  ('adr.desktop_parity', 'RUST_COMMANDS_LEDGER_95_COMPLETE', 'ARCHITECTURE', 'LOT 10 : src-tauri/parity/commands.json est à 95/95, complete = true, sans statut A_PORTER. Chaque commande possède un handler Rust enregistré dans lib.rs. Cinq commandes de service supplémentaires couvrent les manifestes, téléchargements, imports USB, exports de rapports et diagnostic runtime.'),
  ('adr.desktop_tranche4', 'BACKUPS_AND_EXPORTS_IN_RUST', 'ARCHITECTURE', 'LOT 10 : sauvegardes LOT 9, diagnostics, self-tests, restauration différée, portabilité USB, manifestes SHA-256 et exports CSV/PDF sont portés en Rust. VACUUM INTO, integrity_check, foreign_key_check, copie PRE_RESTORE, migrations sur base séparée et activation avant ouverture du pool restent obligatoires.'),
  ('adr.desktop_binaries', 'NO_EXTERNALBIN_NO_BACKEND_BUNDLE', 'ARCHITECTURE', 'LOT 10 : tauri.conf.json ne déclare plus externalBin ni ressource build-backend/server.mjs. Seules les migrations SQL sont embarquées comme ressources ; le frontend est fourni par frontendDist.'),
  ('adr.desktop_csp', 'NO_LOOPBACK_CONNECT_SRC', 'ARCHITECTURE', 'LOT 10 : la CSP desktop autorise uniquement self, ipc et les protocoles asset/tauri. Aucune origine 127.0.0.1 ou localhost n''est autorisée pour connect-src.'),
  ('adr.desktop_auto_backup', 'RUST_TOKIO_TIMER', 'ARCHITECTURE', 'LOT 10 : la coquille Rust programme elle-même la sauvegarde automatique locale (5 secondes puis toutes les 15 minutes), sans minuteur Node ni appel réseau.'),
  ('app.lot_in_progress', 'LOT_10', 'EXECUTION', 'Lot en cours : port Rust 95/95 achevé ; restent cargo check, cargo test, builds natifs, signature et notarisation. Le dernier lot validé reste LOT_9.');
