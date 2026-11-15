pub mod commands;
pub mod db;
pub mod domain;
pub mod error;
pub mod models;
pub mod repositories;
pub mod security;

use commands::auth::{
    auth_bootstrap_status, auth_change_password, auth_check_permission, auth_create_user,
    auth_get_current_session, auth_initialize_depot, auth_login, auth_logout, auth_unlock_user,
    settings_get,
};
use commands::finance::{open_cash_session, record_expense};
use commands::purchases::{
    purchase_create_order, purchase_receive_partial, purchase_record_supplier_payment,
    purchase_validate_supplier_invoice,
};
use commands::system::{
    check_system_health, get_architectural_decisions, get_license_state, trigger_integrity_check,
    update_local_license, AppState,
};
use db::init_sqlite_pool;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Impossible de résoudre le dossier de données applicatives");
            let db_path = app_data_dir.join("depotpro.db");

            let pool = tauri::async_runtime::block_on(init_sqlite_pool(&db_path))
                .expect("Échec d'initialisation de la base SQLite locale");

            app.manage(AppState { pool, db_path });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_system_health,
            get_architectural_decisions,
            get_license_state,
            update_local_license,
            trigger_integrity_check,
            auth_bootstrap_status,
            auth_initialize_depot,
            auth_login,
            auth_logout,
            auth_check_permission,
            auth_get_current_session,
            auth_change_password,
            auth_create_user,
            auth_unlock_user,
            settings_get,
            purchase_create_order,
            purchase_receive_partial,
            purchase_validate_supplier_invoice,
            purchase_record_supplier_payment,
            open_cash_session,
            record_expense,
        ])
        .run(tauri::generate_context!())
        .expect("Erreur fatale au démarrage de DepotPro CI");
}
