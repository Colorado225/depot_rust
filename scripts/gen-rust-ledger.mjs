/**
 * LOT 10 — Génère le registre de parité des commandes Tauri (source de vérité).
 *
 * Lit les 95 commandes de `src/lib/ipc.ts`, attribue un domaine et une tranche,
 * puis écrit :
 *   - src-tauri/parity/commands.json      (contrat Rust, lu par les tests)
 *   - src/lib/rustCommands.generated.ts   (liste des commandes servies par Rust)
 *
 * Règle : une commande ne peut passer au statut RUST que si un handler
 * `#[tauri::command]` du même nom existe ET est enregistré dans lib.rs.
 * `tests/lot10-rust-port.test.ts` vérifie cette assertion.
 *
 * Usage : node scripts/gen-rust-ledger.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IPC = path.join(ROOT, 'src/lib/ipc.ts');
const LEDGER = path.join(ROOT, 'src-tauri/parity/commands.json');
const TS = path.join(ROOT, 'src/lib/rustCommands.generated.ts');

const DOMAINS = [
  ['check_system_health|get_migrations_status|get_architectural_decisions|get_license_state|update_local_license|reset_local_license|trigger_integrity_check|run_foundation_self_test', 'Fondations', 1],
  ['auth_|settings_', 'Authentification & paramètres', 1],
  ['catalog_', 'Catalogue', 2],
  ['stock_|suppliers_', 'Stocks & fournisseurs', 2],
  ['purchases_', 'Achats & réceptions', 2],
  ['customers_|pos_', 'Clients & point de vente', 3],
  ['consignments_', 'Consignes', 3],
  ['finance_', 'Caisse & trésorerie', 3],
  ['reports_', 'Rapports & exports', 3],
  ['backup_', 'Sauvegardes & restauration (LOT 9)', 4],
];

/** Tranche 1 : handlers Rust réellement implémentés et enregistrés. */
const TRANCHE_1 = [
  'check_system_health', 'get_migrations_status', 'get_architectural_decisions',
  'get_license_state', 'update_local_license', 'reset_local_license',
  'trigger_integrity_check', 'run_foundation_self_test',
  'auth_bootstrap_status', 'auth_initialize_depot', 'auth_login', 'auth_logout',
  'auth_me', 'auth_change_password', 'auth_list_users', 'auth_create_user',
  'auth_toggle_user_status', 'auth_unlock_user', 'auth_update_user_role',
  'auth_list_roles', 'auth_list_login_logs',
  'settings_get', 'settings_update',
];

/** Tranche 2 : catalogue, stocks, fournisseurs, achats et réceptions. */
const TRANCHE_2 = [
  'catalog_list_categories', 'catalog_create_category', 'catalog_list_brands',
  'catalog_create_brand', 'catalog_list_units', 'catalog_list_packaging',
  'catalog_create_packaging', 'catalog_update_packaging', 'catalog_list_products',
  'catalog_create_product', 'catalog_update_product', 'catalog_toggle_product_active',
  'stock_list_balances', 'stock_list_movements', 'stock_record_movement',
  'stock_list_inventories', 'stock_validate_inventory',
  'suppliers_list', 'suppliers_create', 'suppliers_update', 'suppliers_toggle_active',
  'purchases_list_orders', 'purchases_create_order', 'purchases_validate_order',
  'purchases_cancel_order', 'purchases_receive_order', 'purchases_list_receipts',
  'purchases_list_payments', 'purchases_record_payment', 'purchases_record_return',
];

/** Tranche 3 : clients, POS, consignes, caisse et rapports. */
const TRANCHE_3 = [
  'customers_list', 'customers_statement', 'customers_create', 'customers_update',
  'customers_toggle_active', 'customers_record_payment', 'pos_list_sales', 'pos_create_sale',
  'pos_cancel_sale', 'consignments_summary', 'consignments_balances', 'consignments_movements',
  'consignments_customer_return', 'consignments_customer_operation', 'consignments_supplier_operation', 'consignments_depot_operation',
  'finance_overview', 'finance_list_registers', 'finance_list_sessions', 'finance_session_detail',
  'finance_open_session', 'finance_manual_movement', 'finance_close_session', 'finance_override_session',
  'finance_list_expense_categories', 'finance_create_expense_category', 'finance_list_expenses', 'finance_record_expense',
  'finance_list_payments', 'reports_overview', 'reports_product_margins', 'reports_snapshot',
  'reports_daily',
];

/** Tranche 4 : sauvegardes LOT 9, diagnostics, restauration, exports natifs. */
const TRANCHE_4 = [
  'backup_overview', 'backup_config_update', 'backup_create', 'backup_auto_run',
  'backup_diagnostics', 'backup_self_test', 'backup_cancel_restore',
  'backup_verify', 'backup_restore',
];

const IMPLEMENTED = [...TRANCHE_1, ...TRANCHE_2, ...TRANCHE_3, ...TRANCHE_4];
const HANDLER_MODULES = {
  1: 'commands::foundation',
  2: 'commands::operations',
  3: 'commands::commercial',
  4: 'commands::backups',
};

function clientCommands() {
  const source = fs.readFileSync(IPC, 'utf8');
  const start = source.indexOf('const COMMAND_HTTP_MAP');
  const end = source.indexOf('\n};', start);
  return Array.from(
    source.slice(start, end).matchAll(/^  ([a-z][a-z0-9_]*):/gm),
    (m) => m[1],
  );
}

function classify(command) {
  for (const [pattern, domain, tranche] of DOMAINS) {
    if (pattern.split('|').some((p) => (p.endsWith('_') ? command.startsWith(p) : command === p))) {
      return { domain, tranche };
    }
  }
  return { domain: 'Divers', tranche: 4 };
}

function main() {
  const commands = clientCommands();
  if (commands.length === 0) throw new Error('Aucune commande trouvée dans ipc.ts');
  const unknown = IMPLEMENTED.filter((c) => !commands.includes(c));
  if (unknown.length) throw new Error(`Commandes déclarées RUST absentes du client : ${unknown.join(', ')}`);

  const entries = commands.map((command) => {
    const { domain, tranche } = classify(command);
    const rust = IMPLEMENTED.includes(command);
    return {
      command,
      domain,
      tranche,
      status: rust ? 'RUST' : 'A_PORTER',
      handler: rust ? `${HANDLER_MODULES[tranche]}::${command}` : null,
      // 95/95 : plus aucun repli HTTP en mode desktop. La table HTTP reste
      // uniquement la référence web/preview servie par Express + Vite.
      fallback: null,
    };
  });

  const ledger = {
    version: 1,
    architecture: 'REACT_UI_TO_TAURI_COMMANDS_TO_RUST_DOMAIN_TO_SQLX_TO_SQLITE',
    total: entries.length,
    implemented: entries.filter((e) => e.status === 'RUST').length,
    tranches: {
      1: 'Fondations, migrations, restauration différée, authentification/RBAC, paramètres',
      2: 'Catalogue, stocks, fournisseurs, achats et réceptions (PORTÉ)',
      3: 'Clients, POS, consignes, caisse, rapports (PORTÉ)',
      4: 'Sauvegardes, portabilité USB, diagnostics LOT 9, exports et retrait du pont HTTP (PORTÉ)',
    },
    commands: entries,
  };

  const ts = `// GÉNÉRÉ par scripts/gen-rust-ledger.mjs — ne pas modifier à la main.
// LOT 10 : commandes dont la logique métier est exécutée dans le backend Rust.
// 95/95 : le desktop n'utilise plus aucun pont HTTP local.
export const RUST_COMMAND_SET: ReadonlySet<string> = new Set([
${entries.filter((e) => e.status === 'RUST').map((e) => `  '${e.command}',`).join('\n')}
]);

export const RUST_PARITY = {
  total: ${ledger.total},
  implemented: ${ledger.implemented},
  complete: ${ledger.implemented === ledger.total},
} as const;
`;

  if (process.argv.includes('--check')) {
    const current = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    const currentTs = fs.readFileSync(TS, 'utf8');
    if (JSON.stringify(current) !== JSON.stringify(ledger) || currentTs !== ts) {
      throw new Error('Registre de parité périmé : relancer npm run rust:ledger');
    }
    console.log(`Registre à jour : ${ledger.implemented}/${ledger.total} commandes en Rust.`);
    return;
  }

  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.writeFileSync(TS, ts);
  console.log(`Registre généré : ${ledger.implemented}/${ledger.total} commandes en Rust.`);
}

main();
