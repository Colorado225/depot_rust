import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));

interface LedgerEntry {
  command: string;
  tranche: number;
  status: 'RUST' | 'A_PORTER';
  handler: string | null;
  fallback: string | null;
}

const ledger = JSON.parse(read('src-tauri/parity/commands.json')) as {
  total: number;
  implemented: number;
  commands: LedgerEntry[];
};

const TRANCHE_3 = [
  'customers_list', 'customers_statement', 'customers_create', 'customers_update',
  'customers_toggle_active', 'customers_record_payment',
  'pos_list_sales', 'pos_create_sale', 'pos_cancel_sale',
  'consignments_summary', 'consignments_balances', 'consignments_movements',
  'consignments_customer_return', 'consignments_customer_operation',
  'consignments_supplier_operation', 'consignments_depot_operation',
  'finance_overview', 'finance_list_registers', 'finance_list_sessions',
  'finance_session_detail', 'finance_open_session', 'finance_manual_movement',
  'finance_close_session', 'finance_override_session',
  'finance_list_expense_categories', 'finance_create_expense_category',
  'finance_list_expenses', 'finance_record_expense', 'finance_list_payments',
  'reports_overview', 'reports_product_margins', 'reports_snapshot', 'reports_daily',
];

const REPOS = [
  'src-tauri/src/repositories/customer_repo.rs',
  'src-tauri/src/repositories/pos_repo.rs',
  'src-tauri/src/repositories/consignment_repo.rs',
  'src-tauri/src/repositories/finance_repo.rs',
  'src-tauri/src/repositories/reports_repo.rs',
];

const WRITE_PERMISSIONS: Record<string, string> = {
  'pos.sale.create': 'PERM_SALE_CREATE',
  'pos.sale.cancel': 'PERM_SALE_CANCEL',
  'pos.discount.apply': 'PERM_DISCOUNT',
  'consignment.manage': 'PERM_CONSIGNMENT',
  'cash.session.operate': 'PERM_CASH_OPERATE',
  'cash.session.override': 'PERM_CASH_OVERRIDE',
  'expense.write': 'PERM_EXPENSE_WRITE',
  'reports.view': 'PERM_REPORTS_VIEW',
};

/** Division euclidienne BigInt (comportement de `i128::div_euclid`). */
function divEuclid(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
}

describe('LOT 10 — Tranche 3 : 33 commandes Rust (clients, POS, consignes, caisse, rapports)', () => {
  it('marque exactement les 33 commandes de la tranche 3 comme RUST', () => {
    const entries = ledger.commands.filter((c) => c.tranche === 3);
    expect(entries).toHaveLength(33);
    expect(entries.map((c) => c.command)).toEqual(TRANCHE_3);
    expect(entries.every((c) => c.status === 'RUST')).toBe(true);
    expect(entries.every((c) => c.handler === `commands::commercial::${c.command}`)).toBe(true);
    expect(entries.every((c) => c.fallback === null)).toBe(true);
    expect(ledger.implemented).toBe(95);
    expect(ledger.total).toBe(95);

    const pending = ledger.commands.filter((c) => c.status === 'A_PORTER');
    expect(pending).toHaveLength(0);
    const tranche4 = ledger.commands.filter((c) => c.tranche === 4);
    expect(tranche4).toHaveLength(9);
    expect(tranche4.every((c) => c.status === 'RUST' && c.command.startsWith('backup_'))).toBe(true);

    const generated = read('src/lib/rustCommands.generated.ts');
    for (const command of TRANCHE_3) expect(generated).toContain(`  '${command}',`);
    expect(generated).toContain('implemented: 95');
    expect(generated).toContain('total: 95');
    expect(generated).toContain('complete: true');
  });

  it('expose 33 handlers Rust enregistrés, un par commande, sans stub', () => {
    const commercial = read('src-tauri/src/commands/commercial.rs');
    const lib = read('src-tauri/src/lib.rs');
    const handlers = Array.from(
      commercial.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)/g),
      (m) => m[1]
    );
    expect(handlers).toHaveLength(33);
    expect([...handlers].sort()).toEqual([...TRANCHE_3].sort());
    const registered = Array.from(lib.matchAll(/\b([a-z_][a-z0-9_]*)\s*,/g), (m) => m[1]);
    for (const command of TRANCHE_3) expect(registered).toContain(command);
    expect(commercial).not.toContain('todo!(');
    expect(commercial).not.toContain('unimplemented!(');
    expect(commercial).not.toContain('Signature prête');

    expect(read('src-tauri/src/commands/mod.rs')).toContain('pub mod commercial;');
    for (const module of [
      'customer_repo', 'pos_repo', 'consignment_repo', 'finance_repo', 'reports_repo',
    ]) {
      expect(exists(`src-tauri/src/repositories/${module}.rs`)).toBe(true);
      expect(read('src-tauri/src/repositories/mod.rs')).toContain(`pub mod ${module};`);
    }
    expect(read('scripts/check_rust.py')).toContain('"commercial": "commercial.rs"');
    expect(read('scripts/verify-delivery.mjs')).toContain('commands/commercial.rs');
  });

  it('applique les mêmes permissions RBAC que les routes Express de référence', () => {
    const commercial = read('src-tauri/src/commands/commercial.rs');
    const routes = [
      read('server/routes/customers.ts'),
      read('server/routes/pos.ts'),
      read('server/routes/consignments.ts'),
      read('server/routes/finance.ts'),
      read('server/routes/reports.ts'),
      // La permission de remise est vérifiée dans le dépôt POS, pas la route.
      read('server/repositories/posRepo.ts'),
    ].join('\n');
    for (const [permission, constant] of Object.entries(WRITE_PERMISSIONS)) {
      expect(routes).toContain(`'${permission}'`);
      expect(commercial).toContain(`const ${constant}: &str = "${permission}"`);
    }
    // 20 écritures protégées, 13 lectures avec session valide uniquement.
    expect(commercial.match(/write_actor\(&state\.pool/g)?.length).toBe(20);
    expect(commercial.match(/read_actor\(&state\.pool/g)?.length).toBe(13);
    expect(commercial).toContain('session::actor(pool, input, permission)');
    expect(commercial).toContain('validate_session_token(pool');
    // La remise POS n'est autorisée que si la session possède le droit dédié.
    expect(commercial).toContain('permission == PERM_DISCOUNT');
  });

  it('conserve les invariants métier critiques dans les dépôts Rust', () => {
    const sources = REPOS.map(read).join('\n');
    const customers = read(REPOS[0]);
    const pos = read(REPOS[1]);
    const consignments = read(REPOS[2]);
    const finance = read(REPOS[3]);
    const reports = read(REPOS[4]);

    // Double clic POS : idempotence AVANT toute écriture.
    expect(pos).toContain('SELECT id FROM sales WHERE idempotency_key = ?');
    expect(pos).toContain('RÈGLE 13');
    // Stock disponible cumulé par produit, jamais de stock négatif par défaut.
    expect(pos).toContain('requested_base_by_product');
    expect(pos).toContain('allow_negative_stock');
    expect(pos).toContain('insufficient_stock(');
    // Plafond de crédit + annulation par écritures compensatoires.
    expect(pos).toContain('Plafond de crédit dépassé');
    expect(pos).toContain("'SALE_CANCEL'");
    // Règlement FIFO, dette recalculée, caisse et audit.
    expect(customers).toContain('ORDER BY created_at ASC');
    expect(customers).toContain('commercial_debt_xof');
    expect(customers).toContain('cash_movements');
    // Consignes : soldes jamais négatifs, remboursement atomique.
    expect(consignments).toContain('Solde d\'emballages insuffisant');
    expect(consignments).toContain('consignment_balances');
    expect(consignments).toContain('CONSIGNMENT_REFUND');
    // Caisse : écart, correction justifiée, dépenses, réconciliation par canal.
    expect(finance).toContain('CLOSING_ADJUSTMENT');
    expect(finance).toContain('CASH_SESSION_OVERRIDE');
    expect(finance).toContain('netTreasuryXof');
    // Rapports : arithmétique XOF en Rust, zéro flottant dans le SQL de calcul.
    expect(reports).toContain('margin_rate_tenths');
    expect(reports).toContain('mul_xof');
    expect(reports).toContain('normalize_date');
    expect(reports).not.toContain('as f64');
    // Atomicité et audit sur tous les flux d'écriture de la tranche 3.
    expect(sources.match(/let mut tx = pool\.begin\(\)\.await\?/g)?.length).toBe(16);
    expect(sources).toContain('let _ = tx.rollback().await');
    expect(sources).toContain('tx.commit().await?');
    expect(sources).toContain('audit(');
  });

  it('aligne le taux de marge Rust sur Math.round de reportsRepo.ts, sans flottant', () => {
    const common = read('src-tauri/src/repositories/common.rs');
    const node = read('server/repositories/reportsRepo.ts');
    expect(node).toContain('Math.round((marginXof * 1000) / revenueXof)');
    expect(common).toContain('pub fn margin_rate_tenths');
    expect(common).toContain('i128::from(margin_xof) * 1000');
    expect(common).toContain('div_euclid(2 * revenue)');
    expect(common).toContain('if revenue_xof <= 0');

    const vectors: Array<[number, number]> = [
      [10_000, 2_500], [10_000, 0], [0, 2_500], [3, 1], [7, 2], [1_001, 500],
      [1_000, -49], [10_000, -495], [100_000, 33_333],
    ];
    for (const [revenue, margin] of vectors) {
      const js = revenue <= 0 ? 0 : Math.round((margin * 1000) / revenue);
      const scaled = BigInt(margin) * 1000n;
      const rust = revenue <= 0
        ? 0n
        : divEuclid(2n * scaled + BigInt(revenue), 2n * BigInt(revenue));
      expect(Number(rust)).toBe(js);
      expect(Number(rust)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
    // Validation des dates AAAA-MM-JJ, identique à normalizeDate() Node.
    expect(common).toContain('AAAA-MM-JJ');
    expect(common).toContain('is_ascii_digit');
    expect(node).toContain('/^\\d{4}-\\d{2}-\\d{2}$/');
  });

  it('vérifie les 241 requêtes SQL des tranches 2-4 et leurs .bind()', () => {
    const sqlTest = read('tests/lot10-rust-sql.test.ts');
    for (const repo of REPOS) expect(sqlTest).toContain(`'${repo}'`);
    expect(sqlTest).toContain('expect(prepared).toBe(241)');
    expect(sqlTest).toContain('sqlx::query(?:_as)?');

    // Contrôle indépendant : #? == #.bind() sur les littéraux de la tranche 3.
    const mismatches: string[] = [];
    const terminator = /\.execute\(|\.fetch_(?:all|one|optional)\(/;
    for (const file of REPOS) {
      const source = read(file);
      for (const match of source.matchAll(/sqlx::query(?:_as)?\(\s*"([^"]*)"/gs)) {
        const placeholders = (match[1].match(/\?/g) ?? []).length;
        const tail = source.slice(match.index! + match[0].length);
        const end = terminator.exec(tail);
        const chain = end ? tail.slice(0, end.index) : tail;
        const binds = (chain.match(/\.bind\(/g) ?? []).length;
        if (binds !== placeholders) {
          mismatches.push(`${file} : ${placeholders} ? pour ${binds} .bind()`);
        }
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('confirme le retrait du pont HTTP et la clôture du registre 95/95', () => {
    const ipc = read('src/lib/ipc.ts');
    expect(ipc).toContain('RUST_COMMAND_SET.has(command)');
    expect(ipc).not.toContain('get_backend_origin');
    expect(ipc).toContain("let rustParityMode: RustParityMode = 'strict'");
    const report = read('docs/LOT10_PORT_RUST.md');
    expect(report).toContain('95/95');
    expect(report).toContain('pont HTTP retiré');
    expect(read('src/modules/foundations/components/LotRoadmapVerificationView.tsx')).toContain(
      '95/95'
    );
    // Le LOT 10 n'est pas déclaré terminé : cargo check/test et builds natifs restent.
    expect(report).toContain('LOT 10 reste ouvert');
  });
});
