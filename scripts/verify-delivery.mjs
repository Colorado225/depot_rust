/**
 * LOT 10 — Contrôle statique de livraison (exécutable sur n'importe quelle plateforme).
 *
 * Ne remplace PAS les tests d'installation réels sur Windows et macOS : il
 * vérifie que tous les artefacts requis par les installateurs sont présents et
 * cohérents, que les migrations SQL s'appliquent sur une base vierge, et que la
 * coquille desktop n'embarque plus aucun runtime Node / pont HTTP loopback.
 *
 * Usage : npm run delivery:check
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, status: 'OK', detail });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    checks.push({ name, status: 'ECHEC', detail: err.message });
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

console.log('Contrôle de livraison LOT 10 — DepotPro CI');
console.log(`Plateforme courante : ${process.platform}/${process.arch}\n`);

check('Frontend compilé et 100 % hors ligne', () => {
  const html = read('dist/index.html');
  assert(html.includes('<div id="root"></div>'), 'div racine absente');
  assert(!html.includes('https://'), 'ressource distante dans index.html');
  return 'dist/index.html sans URL externe';
});

check('Migrations SQL applicables sur une base vierge', () => {
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert(files.length >= 13, `seulement ${files.length} migrations`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'depotpro-delivery-'));
  const dbPath = path.join(temp, 'verification.db');
  const db = new DatabaseSync(dbPath);
  try {
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
    const integrity = db.prepare('PRAGMA integrity_check').get();
    assert(integrity?.integrity_check === 'ok', 'integrity_check ≠ ok');
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    assert(fk.length === 0, `${fk.length} violations de clés étrangères`);
    const tables = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get().c;
    const lot = db
      .prepare("SELECT value FROM system_meta WHERE key='app.lot_current'")
      .get()?.value;
    const inProgress = db
      .prepare("SELECT value FROM system_meta WHERE key='app.lot_in_progress'")
      .get()?.value;
    const transport = db
      .prepare("SELECT value FROM system_meta WHERE key='adr.desktop_transport'")
      .get()?.value;
    assert(lot === 'LOT_9', `app.lot_current = ${lot} (attendu LOT_9)`);
    assert(inProgress === 'LOT_10', `app.lot_in_progress = ${inProgress}`);
    assert(transport === 'TAURI_IPC_ONLY_95_OF_95', `transport = ${transport}`);
    return `${files.length} migrations, ${tables} tables, integrity ok, FK 0, ${lot} / ${inProgress}, ${transport}`;
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

check('Coquille Tauri : cibles, icônes, capacité, CSP sans loopback', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  for (const target of ['msi', 'nsis', 'dmg', 'app']) {
    assert(config.bundle.targets.includes(target), `cible ${target} absente`);
  }
  for (const icon of config.bundle.icon) {
    assert(exists(path.join('src-tauri', icon)), `icône ${icon} absente`);
  }
  assert(exists('src-tauri/capabilities/default.json'), 'capacité par défaut absente');
  assert(config.build.frontendDist === '../dist', 'frontendDist invalide');
  assert(config.build.devUrl === 'http://localhost:5173', 'devUrl Vite attendu');
  assert(config.build.beforeDevCommand.includes('vite'), 'beforeDevCommand sans Vite');
  assert(!config.build.beforeBuildCommand.includes('backend:build'), 'bundle Node encore construit');
  assert(!config.bundle.externalBin?.length, 'externalBin sidecar encore déclaré');
  assert(
    Object.keys(config.bundle.resources).length === 1 &&
      config.bundle.resources['../migrations/'] === 'migrations/',
    'ressources embarquées excessives (sidecar ou bundle Node)'
  );
  assert(config.app.security.csp.includes('ipc:'), 'CSP sans ipc:');
  assert(config.app.security.csp.includes('connect-src'), 'CSP sans connect-src');
  assert(!config.app.security.csp.includes('127.0.0.1'), 'CSP avec backend loopback');
  assert(!config.app.security.csp.includes('localhost:3000'), 'CSP avec port Node');
  assert(!config.app.security.csp.includes('fonts.googleapis'), 'CSP avec police distante');
  assert(config.app.windows[0].label === 'main', 'fenêtre principale absente');
  return `${config.bundle.targets.join(', ')} — ${config.bundle.icon.length} icônes — CSP IPC seule`;
});

check('Aucun sidecar : moteur desktop 100 % Rust, fichiers binaires portés', () => {
  assert(!exists('src-tauri/src/bridge.rs'), 'bridge.rs encore présent');
  assert(!exists('scripts/build-backend.mjs'), 'script de bundle sidecar encore présent');
  assert(!exists('build-backend/server.mjs'), 'bundle Node encore présent');
  const binaries = path.join(ROOT, 'src-tauri', 'binaries');
  assert(
    !fs.existsSync(binaries) || fs.readdirSync(binaries).length === 0,
    'binaires sidecar encore présents'
  );
  const lib = read('src-tauri/src/lib.rs');
  const ipc = read('src/lib/ipc.ts');
  assert(!lib.includes('bridge::'), 'lib.rs référence encore le pont');
  assert(!lib.includes('start_backend_sidecar'), 'démarrage du sidecar encore présent');
  assert(!lib.includes('get_backend_origin'), 'commande de pont encore enregistrée');
  assert(!ipc.includes('get_backend_origin'), 'client encore branché sur le pont HTTP');
  assert(lib.includes('get_desktop_runtime_status'), 'diagnostic runtime natif absent');
  assert(lib.includes('auto_backup_if_due'), 'minuteur de sauvegarde Rust absent');
  assert(read('src-tauri/src/runtime.rs').includes('TAURI_IPC_ONLY'), 'runtime non IPC seul');
  for (const file of [
    'src-tauri/src/commands/backups.rs',
    'src-tauri/src/repositories/backup_repo.rs',
    'src-tauri/src/repositories/report_export_repo.rs',
    'src-tauri/src/domain/backup.rs',
    'src-tauri/src/domain/pdf_export.rs',
  ]) {
    assert(exists(file), `${file} absent`);
  }
  return 'sidecar supprimé ; 5 fichiers Rust tranche 4 présents';
});

check('Port Rust : registre 95/95, IPC strict, aucun repli HTTP desktop', () => {
  const ledger = JSON.parse(read('src-tauri/parity/commands.json'));
  assert(ledger.total === 95, `registre incomplet : ${ledger.total} commandes`);
  assert(ledger.implemented === 95, `seulement ${ledger.implemented}/95 en Rust`);
  assert(
    ledger.commands.every((c) => c.status === 'RUST' && c.fallback === null),
    'commande A_PORTER ou repli HTTP encore déclaré'
  );
  const generated = read('src/lib/rustCommands.generated.ts');
  assert(generated.includes('implemented: 95'), 'client désynchronisé du registre');
  assert(generated.includes('complete: true'), 'parité non déclarée complète');

  const ipc = read('src/lib/ipc.ts');
  assert(ipc.includes('RUST_COMMAND_SET.has(command)'), 'dispatch Rust d’abord absent');
  assert(ipc.includes('tauriInvoke<T>(command, { input })'), 'appel Tauri structuré absent');
  assert(ipc.includes('NOT_IMPLEMENTED_IN_RUST'), 'garde-fou anti-HTTP absent');
  assert(ipc.includes('invokeRustService'), 'services binaires Rust absents');
  assert(ipc.includes("let rustParityMode: RustParityMode = 'strict'"), 'mode strict par défaut absent');
  assert(!ipc.includes("tauriInvoke<string>('get_backend_origin')"), 'pont transitoire encore appelé');
  for (const command of [
    'reports_export_file', 'backup_download_file', 'backup_import_file', 'backup_get_manifest',
  ]) {
    assert(ipc.includes(command) || read('src-tauri/src/commands/backups.rs').includes(command), `${command} absent`);
  }

  const lib = read('src-tauri/src/lib.rs');
  assert(lib.includes('db::init_sqlite_pool'), 'pool Rust non initialisé');
  assert(lib.includes('pub mod commands;'), 'modules métier Rust non compilés');
  assert(exists('src-tauri/src/commands/operations.rs'), 'handlers de la tranche 2 absents');
  assert(exists('src-tauri/src/commands/commercial.rs'), 'handlers de la tranche 3 absents');
  for (const repo of [
    'customer_repo', 'pos_repo', 'consignment_repo', 'finance_repo', 'reports_repo',
    'backup_repo', 'report_export_repo',
  ]) {
    assert(exists(`src-tauri/src/repositories/${repo}.rs`), `dépôt ${repo} Rust absent`);
  }
  for (const entry of ledger.commands) {
    assert(lib.includes(`${entry.command},`), `${entry.command} non enregistrée dans lib.rs`);
  }
  const cargo = read('src-tauri/Cargo.toml');
  assert(cargo.includes('sqlx'), 'SQLx absent');
  assert(cargo.includes('scrypt'), 'scrypt absent (parité des mots de passe)');
  assert(!cargo.includes('argon2'), 'argon2 incompatible avec le backend Node');
  return '95/95 commandes en Rust, 0 repli HTTP, 5 commandes de service';
});

check('Script de signature et procédure de notarisation fournis', () => {
  assert(exists('scripts/sign-windows.ps1'), 'signature Windows absente');
  assert(exists('scripts/notarize-macos.sh'), 'notarisation macOS absente');
  assert(exists('docs/LOT10_DISTRIBUTION.md'), 'documentation LOT 10 absente');
  assert(exists('docs/LOT10_PORT_RUST.md'), 'rapport de port Rust absent');
  return 'présents, non exécutés ici (certificats/plateformes cibles requis)';
});

const failed = checks.filter((c) => c.status === 'ECHEC');
console.log(`\nRésultat : ${checks.length - failed.length}/${checks.length} contrôles réussis.`);
if (failed.length > 0) {
  console.error('Contrôles en échec : ' + failed.map((c) => c.name).join(', '));
  process.exit(1);
}
console.log('Limite : les installateurs signés et les tests d’installation réels');
console.log('doivent être exécutés sur Windows et macOS (voir docs/LOT10_DISTRIBUTION.md).');
