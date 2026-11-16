import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));

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

const TRANCHE_4 = [
  'backup_overview', 'backup_config_update', 'backup_create', 'backup_auto_run',
  'backup_diagnostics', 'backup_self_test', 'backup_cancel_restore',
  'backup_verify', 'backup_restore',
];

const SERVICE_COMMANDS = [
  'backup_get_manifest', 'backup_download_file', 'backup_import_file',
  'reports_export_file', 'get_desktop_runtime_status',
];

function migratedDatabase(): { db: DatabaseSync; files: string[] } {
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    execution_ms INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`);
  for (const file of files) db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  return { db, files };
}

describe('LOT 10 — Tranche 4 : sauvegardes Rust, exports natifs, pont HTTP retiré', () => {
  it('porte les 9 commandes LOT 9 et clôt le registre à 95/95', () => {
    expect(ledger.total).toBe(95);
    expect(ledger.implemented).toBe(95);
    expect(ledger.commands.filter((c) => c.status === 'A_PORTER')).toHaveLength(0);
    const entries = ledger.commands.filter((c) => c.tranche === 4);
    expect(entries).toHaveLength(9);
    expect(entries.map((c) => c.command)).toEqual(TRANCHE_4);
    for (const entry of entries) {
      expect(entry.status).toBe('RUST');
      expect(entry.fallback).toBeNull();
      expect(entry.handler).toBe(`commands::backups::${entry.command}`);
    }
    const generated = read('src/lib/rustCommands.generated.ts');
    expect(generated).toContain('implemented: 95');
    expect(generated).toContain('complete: true');
  });

  it('expose 9 handlers de registre + 4 services binaires, tous protégés et enregistrés', () => {
    const handlers = Array.from(
      read('src-tauri/src/commands/backups.rs').matchAll(
        /#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)/g
      ),
      (m) => m[1]
    );
    expect(handlers).toHaveLength(13);
    for (const command of [...TRANCHE_4, ...SERVICE_COMMANDS.slice(0, 4)]) {
      expect(handlers).toContain(command);
    }
    const lib = read('src-tauri/src/lib.rs');
    const block = /generate_handler!\[([\s\S]*?)\]/.exec(lib)?.[1] ?? '';
    const registered = Array.from(block.matchAll(/\b([a-z_][a-z0-9_]*)\s*,/g), (m) => m[1]);
    for (const command of [...TRANCHE_4, ...SERVICE_COMMANDS]) {
      expect(registered).toContain(command);
    }
    expect(registered).toHaveLength(100);
    const source = read('src-tauri/src/commands/backups.rs');
    expect(source).toContain('const PERM_BACKUP_MANAGE: &str = "backup.manage"');
    expect(source).toContain('const PERM_REPORTS_VIEW: &str = "reports.view"');
    expect(source).not.toContain('todo!(');
    expect(source).not.toContain('unimplemented!(');
  });

  it('reproduit les invariants LOT 9 dans le dépôt Rust des sauvegardes', () => {
    const repo = read('src-tauri/src/repositories/backup_repo.rs');
    const domain = read('src-tauri/src/domain/backup.rs');
    for (const token of [
      'VACUUM INTO ?', 'sha256_file', 'write_manifest', 'inspect_manifest',
      'RESTORE_CONFIRMATION', 'PRE_RESTORE', 'apply_migrations',
      'snapshot_rows', 'write_pending_restore', 'cancel_pending_restore',
      'journal_mode = DELETE', 'read_backup_file', 'import_external_backup',
    ]) {
      expect(repo.includes(token) || domain.includes(token), `Invariant absent : ${token}`).toBe(true);
    }
    expect(domain).toContain('SQLITE_MAGIC');
    expect(domain).toContain('write_private_bytes');
    expect(domain).toContain('base64_decode');
    expect(domain).toContain('inspect_sqlite_file');
    for (const id of [
      'wal-fk', 'integrity-check', 'foreign-key-check', 'schema-tables',
      'migration-checksums', 'currency-xof', 'xof-integers', 'no-negative-stock',
      'backup-rbac', 'backup-history', 'tx-rollback', 'offline-ready',
    ]) {
      expect(repo).toContain(`"${id}"`);
    }
  });

  it('produit les exports CSV/PDF en Rust, sans générateur Node', () => {
    const exportsRepo = read('src-tauri/src/repositories/report_export_repo.rs');
    const pdf = read('src-tauri/src/domain/pdf_export.rs');
    for (const dataset of [
      'margins', 'sales', 'receivables', 'payables', 'expenses', 'consignments',
    ]) {
      expect(exportsRepo).toContain(`"${dataset}"`);
    }
    expect(exportsRepo).toContain('REPORT_EXPORTED');
    expect(exportsRepo).toContain('\\u{FEFF}');
    expect(exportsRepo).toContain('build_tabular_pdf');
    expect(pdf).toContain('%PDF-1.4');
    expect(pdf).toContain('xref');
    expect(pdf).toContain('startxref');
    expect(pdf).toContain('WinAnsiEncoding');
    expect(pdf).toContain('pub fn build_tabular_pdf');
  });

  it('supprime le sidecar, le loopback et le bundle Node de la distribution', () => {
    expect(exists('src-tauri/src/bridge.rs')).toBe(false);
    expect(exists('scripts/build-backend.mjs')).toBe(false);
    expect(exists('build-backend/server.mjs')).toBe(false);
    const binaries = path.join(ROOT, 'src-tauri', 'binaries');
    expect(!fs.existsSync(binaries) || fs.readdirSync(binaries).length === 0).toBe(true);

    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      build: { beforeBuildCommand: string };
      app: { security: { csp: string } };
      bundle: { externalBin?: string[]; resources: Record<string, string> };
    };
    expect(config.build.beforeBuildCommand).toBe('npm run build');
    expect(config.bundle.externalBin ?? []).toHaveLength(0);
    expect(Object.keys(config.bundle.resources)).toEqual(['../migrations/']);
    expect(config.app.security.csp).not.toContain('127.0.0.1');
    expect(config.app.security.csp).not.toContain('localhost:3000');

    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['backend:build']).toBeUndefined();
    expect(packageJson.scripts['backend:check']).toBeUndefined();
    expect(packageJson.scripts['delivery:check']).not.toContain('backend:build');

    const ipc = read('src/lib/ipc.ts');
    expect(ipc).not.toContain('get_backend_origin');
    expect(ipc).toContain('invokeRustService');
    expect(ipc).toContain("let rustParityMode: RustParityMode = 'strict'");
    expect(read('src-tauri/src/runtime.rs')).toContain('TAURI_IPC_ONLY');
  });

  it('applique la migration 0015 sur une base vierge sans casser le LOT 9', () => {
    const { db, files } = migratedDatabase();
    try {
      expect(files).toHaveLength(15);
      expect(files.at(-1)).toBe('0015_lot10_rust_ipc_only.sql');
      const integrity = db.prepare('PRAGMA integrity_check').get() as
        | { integrity_check: string }
        | undefined;
      expect(integrity?.integrity_check).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      const tables = db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .get() as { c: number } | undefined;
      expect(tables?.c).toBe(43);
      const meta = (key: string) =>
        (db.prepare('SELECT value FROM system_meta WHERE key = ?').get(key) as
          | { value: string }
          | undefined)?.value;
      expect(meta('app.lot_current')).toBe('LOT_9');
      expect(meta('app.lot_in_progress')).toBe('LOT_10');
      expect(meta('adr.desktop_runtime')).toBe('RUST_SQLX_NATIVE_NO_SIDECAR');
      expect(meta('adr.desktop_transport')).toBe('TAURI_IPC_ONLY_95_OF_95');
      expect(meta('adr.desktop_parity')).toBe('RUST_COMMANDS_LEDGER_95_COMPLETE');
      expect(meta('adr.desktop_csp')).toBe('NO_LOOPBACK_CONNECT_SRC');
    } finally {
      db.close();
    }
  });

  it('conserve le garde-fou du rapport : LOT 10 ouvert tant que cargo et les builds natifs manquent', () => {
    const report = read('docs/LOT10_PORT_RUST.md');
    expect(report).toContain('95/95');
    expect(report).toContain('pont HTTP retiré');
    expect(report).toContain('LOT 10 reste ouvert');
    expect(report).toContain('cargo check');
    expect(report).toContain('NON EXÉCUTÉ');
    expect(read('src/modules/foundations/components/LotRoadmapVerificationView.tsx')).toContain(
      '95/95'
    );
    expect(exists('Cargo.lock')).toBe(false);
    expect(exists('src-tauri/Cargo.lock')).toBe(false);
  });
});
