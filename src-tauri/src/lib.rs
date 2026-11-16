//! DepotPro CI — Coquille desktop Tauri 2 (LOT 10, 95/95 en Rust natif).
//!
//! Architecture cible (`Implementtion.md` §3) :
//!   React UI → Tauri Commands → Domain Services Rust → Repositories SQLx → SQLite
//!
//! Le pont HTTP / sidecar Node de la phase 1 est RETIRÉ. Le backend Node/Express
//! reste uniquement la référence web/preview (Vite), jamais le moteur métier du
//! desktop. Toutes les commandes du registre `src-tauri/parity/commands.json`
//! sont servies par `tauriInvoke` ; les fichiers binaires (exports, sauvegardes,
//! imports USB) passent par des commandes de service Rust, sans HTTP loopback.
//!
//! Un SEUL propriétaire du schéma : `db::init_sqlite_pool()` applique les
//! migrations dans `schema_migrations` (SHA-256), jamais `_sqlx_migrations`.
//! La restauration différée LOT 9 est appliquée AVANT l'ouverture du pool.

pub mod commands;
pub mod db;
pub mod domain;
pub mod error;
pub mod json;
pub mod models;
pub mod repositories;
pub mod runtime;
pub mod security;

use commands::foundation::{
    check_system_health, get_migrations_status, get_architectural_decisions, get_license_state,
    update_local_license, reset_local_license, trigger_integrity_check,
    run_foundation_self_test, auth_bootstrap_status, auth_initialize_depot, auth_login,
    auth_logout, auth_me, auth_change_password, auth_list_users, auth_create_user,
    auth_toggle_user_status, auth_unlock_user, auth_update_user_role, auth_list_roles,
    auth_list_login_logs, settings_get, settings_update,
};
use commands::operations::{
    catalog_list_categories, catalog_create_category, catalog_list_brands, catalog_create_brand,
    catalog_list_units, catalog_list_packaging, catalog_create_packaging,
    catalog_update_packaging, catalog_list_products, catalog_create_product,
    catalog_update_product, catalog_toggle_product_active, stock_list_balances,
    stock_list_movements, stock_record_movement, stock_list_inventories,
    stock_validate_inventory, suppliers_list, suppliers_create, suppliers_update,
    suppliers_toggle_active, purchases_list_orders, purchases_create_order,
    purchases_validate_order, purchases_cancel_order, purchases_receive_order,
    purchases_list_receipts, purchases_list_payments, purchases_record_payment,
    purchases_record_return,
};
use commands::commercial::{
    customers_list, customers_statement, customers_create, customers_update,
    customers_toggle_active, customers_record_payment, pos_list_sales, pos_create_sale,
    pos_cancel_sale, consignments_summary, consignments_balances, consignments_movements,
    consignments_customer_return, consignments_customer_operation,
    consignments_supplier_operation, consignments_depot_operation, finance_overview,
    finance_list_registers, finance_list_sessions, finance_session_detail, finance_open_session,
    finance_manual_movement, finance_close_session, finance_override_session,
    finance_list_expense_categories, finance_create_expense_category, finance_list_expenses,
    finance_record_expense, finance_list_payments, reports_overview, reports_product_margins,
    reports_snapshot, reports_daily,
};
use commands::backups::{
    backup_overview, backup_config_update, backup_create, backup_auto_run, backup_diagnostics,
    backup_self_test, backup_cancel_restore, backup_verify, backup_restore,
    backup_get_manifest, backup_download_file, backup_import_file, reports_export_file,
};
use runtime::get_desktop_runtime_status;
use db::AppState;
use repositories::backup_repo;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join("depotpro.db");

            // En release, les migrations SQL sont une ressource embarquée. En
            // développement, `resolve_migrations_dir()` retombe sur le dépôt.
            if let Ok(resource_dir) = app.path().resource_dir() {
                let migrations = resource_dir.join("migrations");
                if migrations.is_dir() {
                    std::env::set_var("DEPOTPRO_MIGRATIONS_DIR", &migrations);
                }
            }

            let pool = tauri::async_runtime::block_on(db::init_sqlite_pool(&db_path))
                .map_err(|err| -> Box<dyn std::error::Error> {
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        String::from(err),
                    ))
                })?;

            app.manage(AppState { pool: pool.clone(), db_path: db_path.clone() });

            // LOT 9 : sauvegarde automatique locale, sans réseau ni sidecar.
            // Premier contrôle après 5 s, puis toutes les 15 minutes ; le dépôt
            // décide lui-même si l'intervalle configuré est écoulé.
            let auto_pool = pool.clone();
            let auto_path = db_path.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                loop {
                    if let Err(err) = backup_repo::auto_backup_if_due(&auto_pool, &auto_path).await {
                        eprintln!("[DepotPro CI] Sauvegarde automatique ignorée : {err}");
                    }
                    tokio::time::sleep(tokio::time::Duration::from_secs(15 * 60)).await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Tranche 1 : 23 commandes — exécutées en Rust.
            check_system_health, get_migrations_status, get_architectural_decisions,
            get_license_state, update_local_license, reset_local_license,
            trigger_integrity_check, run_foundation_self_test, auth_bootstrap_status,
            auth_initialize_depot, auth_login, auth_logout, auth_me, auth_change_password,
            auth_list_users, auth_create_user, auth_toggle_user_status, auth_unlock_user,
            auth_update_user_role, auth_list_roles, auth_list_login_logs, settings_get,
            settings_update,
            // Tranche 2 : 30 commandes — exécutées en Rust.
            catalog_list_categories, catalog_create_category, catalog_list_brands,
            catalog_create_brand, catalog_list_units, catalog_list_packaging,
            catalog_create_packaging, catalog_update_packaging, catalog_list_products,
            catalog_create_product, catalog_update_product, catalog_toggle_product_active,
            stock_list_balances, stock_list_movements, stock_record_movement,
            stock_list_inventories, stock_validate_inventory, suppliers_list, suppliers_create,
            suppliers_update, suppliers_toggle_active, purchases_list_orders,
            purchases_create_order, purchases_validate_order, purchases_cancel_order,
            purchases_receive_order, purchases_list_receipts, purchases_list_payments,
            purchases_record_payment, purchases_record_return,
            // Tranche 3 : 33 commandes — exécutées en Rust.
            customers_list, customers_statement, customers_create, customers_update,
            customers_toggle_active, customers_record_payment, pos_list_sales, pos_create_sale,
            pos_cancel_sale, consignments_summary, consignments_balances,
            consignments_movements, consignments_customer_return,
            consignments_customer_operation, consignments_supplier_operation,
            consignments_depot_operation, finance_overview, finance_list_registers,
            finance_list_sessions, finance_session_detail, finance_open_session,
            finance_manual_movement, finance_close_session, finance_override_session,
            finance_list_expense_categories, finance_create_expense_category,
            finance_list_expenses, finance_record_expense, finance_list_payments,
            reports_overview, reports_product_margins, reports_snapshot, reports_daily,
            // Tranche 4 : 9 commandes (sauvegardes LOT 9) — exécutées en Rust.
            backup_overview, backup_config_update, backup_create, backup_auto_run,
            backup_diagnostics, backup_self_test, backup_cancel_restore, backup_verify,
            backup_restore,
            // Services binaires et diagnostic : hors registre des 95 commandes.
            backup_get_manifest, backup_download_file, backup_import_file, reports_export_file,
            get_desktop_runtime_status,
        ])
        .run(tauri::generate_context!())
        .expect("Erreur fatale au démarrage de DepotPro CI");
}
