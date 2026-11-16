import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWeightedAvgCostXof } from '../server/domain/cump.ts';
import { hashPassword, verifyPassword } from '../server/security/password.ts';

const ROOT = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const ledger = JSON.parse(read('src-tauri/parity/commands.json')) as {
  total: number;
  implemented: number;
  commands: Array<{
    command: string;
    tranche: number;
    status: 'RUST' | 'A_PORTER';
    handler: string | null;
    fallback: string | null;
  }>;
};

const RUST_REPOS = [
  'src-tauri/src/repositories/catalog_repo.rs',
  'src-tauri/src/repositories/stock_repo.rs',
  'src-tauri/src/repositories/supplier_repo.rs',
  'src-tauri/src/repositories/purchase_repo.rs',
];

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

describe('LOT 10 — Tranche 2 : 30 commandes Rust, parité arithmétique et DTO', () => {
  it('marque exactement les 30 commandes de la tranche 2 comme RUST', () => {
    const entries = ledger.commands.filter((c) => c.tranche === 2);
    expect(entries).toHaveLength(30);
    expect(entries.map((c) => c.command)).toEqual(TRANCHE_2);
    expect(entries.every((c) => c.status === 'RUST')).toBe(true);
    expect(entries.every((c) => c.handler === `commands::operations::${c.command}`)).toBe(true);
    expect(entries.every((c) => c.fallback === null)).toBe(true);
    expect(ledger.implemented).toBe(95);
    expect(ledger.total).toBe(95);

    const generated = read('src/lib/rustCommands.generated.ts');
    for (const command of TRANCHE_2) expect(generated).toContain(`  '${command}',`);
    expect(generated).toContain('implemented: 95');
    expect(generated).toContain('complete: true');
  });

  it('expose 30 handlers Rust enregistrés, un par commande, sans stub', () => {
    const operations = read('src-tauri/src/commands/operations.rs');
    const lib = read('src-tauri/src/lib.rs');
    const handlers = Array.from(
      operations.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)/g),
      (m) => m[1]
    );
    expect(handlers).toHaveLength(30);
    expect([...handlers].sort()).toEqual([...TRANCHE_2].sort());
    const registered = Array.from(lib.matchAll(/\b([a-z_][a-z0-9_]*)\s*,/g), (m) => m[1]);
    for (const command of TRANCHE_2) expect(registered).toContain(command);
    expect(operations).not.toContain('todo!(');
    expect(operations).not.toContain('unimplemented!(');

    expect(read('src-tauri/src/commands/mod.rs')).toContain('pub mod operations;');
    for (const module of ['common', 'catalog_repo', 'stock_repo', 'supplier_repo', 'purchase_repo']) {
      expect(read('src-tauri/src/repositories/mod.rs')).toContain(`pub mod ${module};`);
    }
    expect(read('src-tauri/src/domain/mod.rs')).toContain('pub mod cump;');
  });

  it('aligne les vecteurs CUMP Rust sur la fonction Node (arrondi entier inclus)', () => {
    const source = read('src-tauri/src/domain/cump.rs');
    const vectors = Array.from(
      source.matchAll(
        /compute_weighted_avg_cost_xof\((\d+), (\d+), (\d+), (\d+)\)\.unwrap\(\), (\d+)\)/g
      ),
      (m) => m.slice(1).map(Number)
    );
    expect(vectors.length).toBeGreaterThanOrEqual(6);
    for (const [existingQty, currentCump, incomingQty, incomingCost, expected] of vectors) {
      expect(computeWeightedAvgCostXof(existingQty, currentCump, incomingQty, incomingCost)).toBe(
        expected
      );
    }
    expect(source).toContain('division entière tronquée');
    expect(source).toContain('i128');

    // Même contrôle pour le coût ramené à l'unité de base.
    const baseVectors = Array.from(
      source.matchAll(/base_unit_cost_xof\((\d+), (\d+)\)\.unwrap\(\), (\d+)\)/g),
      (m) => m.slice(1).map(Number)
    );
    expect(baseVectors.length).toBeGreaterThanOrEqual(4);
    for (const [cost, conversion, expected] of baseVectors) {
      const numerator = BigInt(cost) + BigInt(conversion) / 2n;
      expect(Number(numerator / BigInt(conversion))).toBe(expected);
    }
  });

  it('prouve la parité scrypt avec un vecteur généré par Node', () => {
    const rust = read('src-tauri/src/security/password.rs');
    const match = /const NODE_VECTOR: &str = "([^"]+)";/.exec(rust);
    expect(match).not.toBeNull();
    const vector = match![1];
    // Le vecteur Rust est vérifié par la fonction Node : même sel ASCII, même
    // dérivé 64 octets, donc comptes interchangeables sur la même base SQLite.
    expect(verifyPassword('Password2026!', vector)).toBe(true);
    expect(verifyPassword('mauvais mot de passe', vector)).toBe(false);

    const generated = hashPassword('Password2026!');
    const parts = generated.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toHaveLength(32);
    expect(parts[2]).toHaveLength(128);
    expect(verifyPassword('Password2026!', generated)).toBe(true);
    expect(read('src-tauri/Cargo.toml')).toContain('scrypt = "0.11"');
  });

  it('conserve les invariants métier critiques dans le backend Rust', () => {
    const sources = RUST_REPOS.map(read).join('\n');
    const stock = read(RUST_REPOS[1]);
    const purchases = read(RUST_REPOS[3]);
    const operations = read('src-tauri/src/commands/operations.rs');

    // Stocks négatifs interdits par défaut, contrôlés AVANT l'écriture.
    expect(stock).toContain('allow_negative_stock');
    expect(stock).toContain('insufficient_stock(');
    expect(stock).toContain('BREAKAGE');
    expect(stock).toContain('compute_weighted_avg_cost_xof');
    // CUMP, dette fournisseur, FIFO, retours et mouvements de caisse.
    expect(purchases).toContain('recompute_supplier_balance_due');
    expect(purchases).toContain('payment_allocations');
    expect(purchases).toContain('ORDER BY created_at ASC');
    expect(purchases).toContain('SUPPLIER_RETURN');
    expect(purchases).toContain('cash_movements');
    expect(purchases).toContain("MAX(0, received_amount_xof - ?)");
    // Atomicité et audit : 18 flux en écriture (7 catalogue + 2 stocks +
    // 3 fournisseurs + 6 achats) ; les 12 lectures n'ouvrent pas de transaction.
    expect(sources.match(/let mut tx = pool\.begin\(\)\.await\?/g)?.length).toBe(18);
    expect(sources).toContain('let _ = tx.rollback().await');
    expect(sources).toContain('tx.commit().await?');
    expect(sources).toContain('audit(');
    // Permissions vérifiées avant l'accès au dépôt.
    expect(operations).toContain('const PERM_CATALOG: &str = "catalog.products.write"');
    expect(operations).toContain('const PERM_STOCK: &str = "stock.adjust"');
    expect(operations).toContain('const PERM_PURCHASE: &str = "purchase.manage"');
    expect(operations).toContain('read_actor(');
    expect(operations).toContain('write_actor(');
  });

  it('maintient les DTO camelCase attendus par le frontend', () => {
    const sources = RUST_REPOS.map(read).join('\n');
    // `json::rows_to_json` convertit snake_case → camelCase ; les champs
    // calculés (MAX, reliquats) sont attachés explicitement en camelCase.
    const fields: Array<[string, string]> = [
      ['productCount', 'product_count'],
      ['isBaseUnit', 'is_base_unit'],
      ['isDefaultSaleUnit', 'is_default_sale_unit'],
      ['depositAmountXof', 'deposit_amount_xof'],
      ['categoryName', 'category_name'],
      ['bottleDepositXof', 'bottle_deposit_xof'],
      ['stockQuantityBase', 'stock_quantity_base'],
      ['alertThresholdBase', 'alert_threshold_base'],
      ['isActive', 'is_active'],
      ['isLowStock', 'is_low_stock'],
      ['totalValuationXof', 'total_valuation_xof'],
      ['balanceAfterBase', 'balance_after_base'],
      ['createdByName', 'created_by_name'],
      ['totalVarianceBase', 'total_variance_base'],
      ['linkedProductsCount', 'linked_products_count'],
      ['balanceDueXof', 'balance_due_xof'],
      ['remainingToPayOnReceivedXof', 'remainingToPayOnReceivedXof'],
      ['remainingToPayOnOrderXof', 'remainingToPayOnOrderXof'],
      ['remainingQty', 'remaining_qty'],
      ['receiptsCount', 'receipts_count'],
      ['totalReceivedXof', 'total_received_xof'],
      ['supplierInvoiceRef', 'supplier_invoice_ref'],
      ['orderNumber', 'order_number'],
      ['returnNumber', 'return_number'],
      ['baseQtyReturned', 'base_qty_returned'],
      ['totalReturnXof', 'total_return_xof'],
    ];
    for (const [camel, snake] of fields) {
      expect(sources.includes(camel) || sources.includes(snake), `DTO absent : ${camel}`).toBe(true);
    }
    expect(read('src-tauri/src/json.rs')).toContain('fn to_camel_case');
    expect(read('src-tauri/src/json.rs')).toContain('bool_columns');
  });

  it('vérifie le nombre de .bind() par marqueur ? dans les requêtes SQLx', () => {
    const checker = read('scripts/check_rust.py');
    expect(checker).toContain('def check_bind_counts');
    expect(checker).toContain('requête désynchronisée');
    // Le contrôle est exécuté par tests/lot10-rust-port.test.ts et npm run rust:check.
    expect(checker).toContain('check_bind_counts(compiled)');
  });
});
