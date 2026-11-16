import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));

interface LedgerEntry {
  command: string;
  domain: string;
  tranche: number;
  status: 'RUST' | 'A_PORTER';
  handler: string | null;
  fallback: string | null;
}

const ledger = JSON.parse(read('src-tauri/parity/commands.json')) as {
  version: number;
  architecture: string;
  total: number;
  implemented: number;
  tranches: Record<string, string>;
  commands: LedgerEntry[];
};

function clientCommands(): string[] {
  const source = read('src/lib/ipc.ts');
  const start = source.indexOf('const COMMAND_HTTP_MAP');
  const end = source.indexOf('\n};', start);
  return Array.from(source.slice(start, end).matchAll(/^  ([a-z][a-z0-9_]*):/gm), (m) => m[1]);
}

const SERVICE_COMMANDS = new Set([
  'backup_get_manifest',
  'backup_download_file',
  'backup_import_file',
  'reports_export_file',
]);

function rustHandlers(): string[] {
  const files = [
    'src-tauri/src/commands/foundation.rs',
    'src-tauri/src/commands/operations.rs',
    'src-tauri/src/commands/commercial.rs',
    'src-tauri/src/commands/backups.rs',
  ];
  return files
    .flatMap((file) =>
      Array.from(
        read(file).matchAll(
          /#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)/g
        ),
        (m) => m[1]
      )
    )
    .filter((handler) => !SERVICE_COMMANDS.has(handler))
    .sort();
}

function registeredHandlers(): string[] {
  const source = read('src-tauri/src/lib.rs');
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
  return Array.from(block.matchAll(/\b([a-z_][a-z0-9_]*)\s*,/g), (m) => m[1]).sort();
}

describe('LOT 10 — Port Rust natif : registre 95/95, tranches 1-4 et parité des données', () => {
  it('couvre exactement les 95 commandes du client, sans doublon ni statut ambigu', () => {
    const client = clientCommands();
    expect(client).toHaveLength(95);
    expect(ledger.version).toBe(1);
    expect(ledger.architecture).toBe('REACT_UI_TO_TAURI_COMMANDS_TO_RUST_DOMAIN_TO_SQLX_TO_SQLITE');
    expect(ledger.total).toBe(95);
    expect(ledger.commands).toHaveLength(95);
    expect(new Set(ledger.commands.map((c) => c.command)).size).toBe(95);
    expect(ledger.commands.map((c) => c.command).sort()).toEqual([...client].sort());

    const rust = ledger.commands.filter((c) => c.status === 'RUST');
    const pending = ledger.commands.filter((c) => c.status === 'A_PORTER');
    // Tranches 1 (23), 2 (30), 3 (33) et 4 (9) portées : 95/95.
    expect(ledger.implemented).toBe(95);
    expect(rust).toHaveLength(95);
    expect(pending).toHaveLength(0);
    expect(ledger.commands.filter((c) => c.tranche === 1 && c.status === 'RUST')).toHaveLength(23);
    expect(ledger.commands.filter((c) => c.tranche === 2 && c.status === 'RUST')).toHaveLength(30);
    expect(ledger.commands.filter((c) => c.tranche === 3 && c.status === 'RUST')).toHaveLength(33);
    expect(ledger.commands.filter((c) => c.tranche === 4 && c.status === 'RUST')).toHaveLength(9);
    for (const entry of rust) {
      const module = ['foundation', 'operations', 'commercial', 'backups'][entry.tranche - 1];
      expect([1, 2, 3, 4]).toContain(entry.tranche);
      expect(entry.handler).toBe(`commands::${module}::${entry.command}`);
      expect(entry.fallback).toBeNull();
    }
    // Les 9 commandes de sauvegarde LOT 9 sont portées en tranche 4, sans repli.
    expect(ledger.commands.filter((c) => c.command.startsWith('backup_')).every((c) => c.tranche === 4))
      .toBe(true);
  });

  it('vérifie que chaque commande RUST a un handler Rust réel et enregistré', () => {
    const expected = ledger.commands.filter((c) => c.status === 'RUST').map((c) => c.command).sort();
    const handlers = rustHandlers();
    const registered = registeredHandlers();
    expect(handlers).toEqual(expected);
    for (const command of expected) {
      expect(registered).toContain(command);
    }
    for (const service of SERVICE_COMMANDS) expect(registered).toContain(service);
    expect(registered).toContain('get_desktop_runtime_status');
    expect(registered).toHaveLength(100);
    expect(registered).not.toContain('get_backend_origin');
    expect(registered).not.toContain('get_backend_status');

    const compiledCommands = [
      read('src-tauri/src/commands/foundation.rs'),
      read('src-tauri/src/commands/operations.rs'),
      read('src-tauri/src/commands/commercial.rs'),
      read('src-tauri/src/commands/backups.rs'),
    ].join('\n');
    // Aucun handler factice du squelette historique n'est exposé.
    expect(compiledCommands).not.toContain('Signature prête');
    expect(compiledCommands).not.toContain('todo!(');
    expect(compiledCommands).not.toContain('unimplemented!(');
    expect(compiledCommands).toContain('PERM_ADMIN');
    expect(compiledCommands).toContain('PERM_CATALOG');
    expect(compiledCommands).toContain('PERM_STOCK');
    expect(compiledCommands).toContain('PERM_PURCHASE');
    expect(compiledCommands).toContain('PERM_SALE_CREATE');
    expect(compiledCommands).toContain('PERM_DISCOUNT');
    expect(compiledCommands).toContain('PERM_CONSIGNMENT');
    expect(compiledCommands).toContain('PERM_CASH_OVERRIDE');
    expect(compiledCommands).toContain('PERM_REPORTS_VIEW');
    expect(compiledCommands).toContain('PERM_BACKUP_MANAGE');
    const mods = read('src-tauri/src/commands/mod.rs');
    expect(mods).toContain('pub mod foundation;');
    expect(mods).toContain('pub mod operations;');
    expect(mods).toContain('pub mod commercial;');
    expect(mods).toContain('pub mod backups;');
    expect(mods).not.toMatch(/^pub mod (auth|finance|purchases|system);/m);
  });

  it('garantit un seul propriétaire du schéma : schema_migrations + SHA-256, restaurations LOT 9', () => {
    const dbMod = read('src-tauri/src/db/mod.rs');
    const restore = read('src-tauri/src/db/restore.rs');
    const compiled = [
      dbMod,
      restore,
      read('src-tauri/src/repositories/foundation_repo.rs'),
      read('src-tauri/src/repositories/system_repo.rs'),
      read('src-tauri/src/commands/foundation.rs'),
      read('src-tauri/src/lib.rs'),
    ].join('\n');
    expect(compiled).not.toContain('sqlx::migrate!(');
    expect(compiled).not.toMatch(/FROM\s+_sqlx_migrations/i);
    expect(dbMod).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(dbMod).toContain('Sha256::digest');
    expect(dbMod).toContain('Somme de contrôle modifiée');
    expect(dbMod).toContain('rollback()');
    expect(dbMod).toContain('apply_pending_restore(db_path)');
    // La restauration est appliquée AVANT l'ouverture du pool.
    expect(dbMod.indexOf('apply_pending_restore(db_path)')).toBeLessThan(
      dbMod.indexOf('connect_with(options)')
    );

    expect(restore).toContain('RESTORE_CONFIRMATION');
    expect(restore).toContain('sha256_file');
    expect(restore).toContain('PRAGMA integrity_check');
    expect(restore).toContain('PRAGMA foreign_key_check');
    expect(restore).toContain('wal_checkpoint(TRUNCATE)');
    expect(restore).toContain('pre-restore');
    expect(restore).toContain('Base courante restaurée');
    expect(restore).toContain('BACKUP_RESTORE_APPLIED');

    const cargo = read('src-tauri/Cargo.toml');
    expect(cargo).toContain('sqlx');
    expect(cargo).toContain('runtime-tokio');
    expect(cargo).not.toMatch(/features\s*=\s*\[[^\]]*"migrate"/);
  });

  it('assure la parité des mots de passe scrypt avec le backend Node', () => {
    const password = read('src-tauri/src/security/password.rs');
    const nodePassword = read('server/security/password.ts');
    const cargo = read('src-tauri/Cargo.toml');

    expect(nodePassword).toContain('scryptSync');
    expect(nodePassword).toContain('SCRYPT_KEYLEN = 64');
    expect(password).toContain('scrypt:{salt_hex}');
    expect(password).toContain('Params::new(LOG_N, R, P, KEY_LEN)');
    expect(password).toContain('LOG_N: u8 = 14');
    expect(password).toContain('R: u32 = 8');
    expect(password).toContain('P: u32 = 1');
    expect(password).toContain('KEY_LEN: usize = 64');
    expect(password).toContain('SALT_HEX_LEN: usize = 32');
    // Le sel est la CHAÎNE hex (32 octets ASCII), comme Node.
    expect(password).toContain('salt_hex.as_bytes()');
    expect(password).toContain('constant_time_eq');
    expect(cargo).toContain('scrypt = "0.11"');
    expect(cargo).not.toContain('argon2');
  });

  it('conserve les DTO camelCase et les règles métier dans le dépôt Rust', () => {
    const repo = read('src-tauri/src/repositories/foundation_repo.rs');
    const jsonHelper = read('src-tauri/src/json.rs');
    expect(jsonHelper).toContain('fn to_camel_case');
    expect(jsonHelper).toContain('bool_columns');
    expect(repo).toContain('XofAmount::non_negative');
    expect(repo).toContain('defaultCashFloatXof');
    expect(repo).toContain('allowNegativeStock');
    expect(repo).toContain('Impossible de désactiver le dernier compte Propriétaire actif');
    expect(repo).toContain('Impossible de rétrograder le dernier Propriétaire actif');
    expect(repo).toContain('PASSWORD_CHANGED');
    expect(repo).toContain('DEPOT_SETTINGS_UPDATED');
    expect(repo).toContain('PRAGMA quick_check');
    expect(repo).toContain('sqlite-tx-rollback');
    expect(repo).toContain('runtime": "TAURI_RUST_SQLX');
    // Les 8 commandes système et 15 commandes auth/settings ont un corps SQL.
    expect(repo.match(/pub async fn /g)?.length).toBeGreaterThanOrEqual(23);
  });

  it('aligne le client TypeScript sur le registre (Rust d’abord, repli transitoire, mode strict)', () => {
    const generated = read('src/lib/rustCommands.generated.ts');
    const expected = ledger.commands.filter((c) => c.status === 'RUST').map((c) => c.command);
    for (const command of expected) {
      expect(generated).toContain(`  '${command}',`);
    }
    expect(generated).toContain(`total: ${ledger.total}`);
    expect(generated).toContain(`implemented: ${ledger.implemented}`);
    expect(generated).toContain('complete: true');

    const ipc = read('src/lib/ipc.ts');
    expect(ipc).toContain('RUST_COMMAND_SET.has(command)');
    expect(ipc).toContain('tauriInvoke<T>(command, { input })');
    expect(ipc).toContain("type RustParityMode = 'transitional' | 'strict'");
    expect(ipc).toContain('setRustParityMode');
    expect(ipc).toContain('NOT_IMPLEMENTED_IN_RUST');
    expect(ipc).not.toContain('get_backend_origin');
    expect(ipc).toContain('invokeRustService');
    expect(ipc).toContain("let rustParityMode: RustParityMode = 'strict'");
    expect(read('src/types/errors.ts')).toContain('NOT_IMPLEMENTED_IN_RUST');
  });

  it('trace la révocation de la décision « sidecar Node » dans la migration 0014', () => {
    const first = read('migrations/0013_lot10_desktop_runtime.sql');
    const second = read('migrations/0014_lot10_rust_native.sql');
    expect(first).toContain('SINGLE_NODE_SQLITE_BACKEND_TAURI_SIDECAR');
    expect(second).toContain('RÉVOQUÉ');
    expect(second).toContain("'adr.desktop_runtime', 'RUST_SQLX_NATIVE'");
    expect(second).toContain("'adr.desktop_migrations', 'SCHEMA_MIGRATIONS_SHA256_SINGLE_OWNER'");
    expect(second).toContain("'adr.rust_port_ledger'");
    expect(second).toContain("'app.lot_in_progress', 'LOT_10'");
    expect(second).not.toContain("'app.lot_current'");

    const third = read('migrations/0015_lot10_rust_ipc_only.sql');
    expect(third).toContain('RUST_SQLX_NATIVE_NO_SIDECAR');
    expect(third).toContain('TAURI_IPC_ONLY_95_OF_95');
    expect(third).toContain('RUST_COMMANDS_LEDGER_95_COMPLETE');
    expect(third).toContain('NO_EXTERNALBIN_NO_BACKEND_BUNDLE');
    expect(third).toContain('NO_LOOPBACK_CONNECT_SRC');
    expect(third).not.toContain("'app.lot_current'");

    const lib = read('src-tauri/src/lib.rs');
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      bundle: { externalBin?: string[]; resources: Record<string, string> };
      app: { security: { csp: string } };
    };
    expect(exists('src-tauri/src/bridge.rs')).toBe(false);
    expect(exists('scripts/build-backend.mjs')).toBe(false);
    expect(lib).not.toContain('bridge::');
    expect(lib).not.toContain('start_backend_sidecar');
    expect(config.bundle.externalBin ?? []).toHaveLength(0);
    expect(Object.keys(config.bundle.resources)).toEqual(['../migrations/']);
    expect(config.app.security.csp).not.toContain('127.0.0.1');
    expect(read('src-tauri/src/runtime.rs')).toContain('TAURI_IPC_ONLY');
  });

  it('exécute le contrôle statique Rust (tree-sitter) et le générateur de registre à jour', () => {
    expect(exists('scripts/check_rust.py')).toBe(true);
    expect(exists('scripts/gen-rust-ledger.mjs')).toBe(true);
    const checker = spawnSync('python3', ['scripts/check_rust.py'], { cwd: ROOT, encoding: 'utf8' });
    expect(checker.status, `${checker.stdout}\n${checker.stderr}`).toBe(0);
    expect(checker.stdout).toContain('Syntaxe et cohérence du port : OK');
    expect(checker.stdout).toContain('95/95 commandes en Rust');

    const ledgerCheck = spawnSync('node', ['scripts/gen-rust-ledger.mjs', '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(ledgerCheck.status, `${ledgerCheck.stdout}\n${ledgerCheck.stderr}`).toBe(0);
  });
});
