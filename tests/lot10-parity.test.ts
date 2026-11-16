import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopCors, isAllowedDesktopOrigin } from '../server/security/desktopCors.ts';
import {
  downloadBackupFile,
  downloadReportExport,
  getBackendOrigin,
  getRustParity,
  getRustParityMode,
  importBackupFile,
  invokeBackend,
  isTauriDesktop,
  resetBackendOriginCache,
  setRustParityMode,
} from '../src/lib/ipc.ts';

const ROOT = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));

function clientCommands(): string[] {
  const source = read('src/lib/ipc.ts');
  const start = source.indexOf('const COMMAND_HTTP_MAP');
  const end = source.indexOf('\n};', start);
  return Array.from(
    source.slice(start, end).matchAll(/^  ([a-z][a-z0-9_]*):/gm),
    (m) => m[1]
  );
}

interface TauriWindow {
  __TAURI_INTERNALS__?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  sessionStorage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };
}

function installWindow(tauri: boolean): { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'reports_export_file') {
      return {
        filename: 'depotpro-margins-2026-11-15.csv',
        mimeType: 'text/csv; charset=utf-8',
        contentBase64: btoa('SKU;Produit\nSKU-1;Bock'),
      };
    }
    if (cmd === 'backup_download_file') {
      return {
        fileName: 'depotpro-sauvegarde.db',
        mimeType: 'application/octet-stream',
        contentBase64: btoa('SQLite format 3'),
      };
    }
    if (cmd === 'backup_import_file') return { id: 'import-1' };
    return { ok: true, command: cmd };
  });
  const win: TauriWindow = {
    sessionStorage: {
      getItem: () => 'jeton-test',
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  if (tauri) win.__TAURI_INTERNALS__ = { invoke: invoke as never };
  (globalThis as unknown as { window?: TauriWindow; isTauri?: boolean }).window = win;
  (globalThis as unknown as { isTauri?: boolean }).isTauri = tauri;
  resetBackendOriginCache();
  return { invoke };
}

function callsOf(mock: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
  return mock.mock.calls as unknown as Array<[string, RequestInit]>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubDownloads(): void {
  vi.stubGlobal('document', {
    createElement: () => ({ href: '', download: '', click: () => undefined, remove: () => undefined }),
    body: { appendChild: () => undefined },
  });
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:depotpro',
    revokeObjectURL: () => undefined,
  });
}

afterEach(() => {
  delete (globalThis as unknown as { window?: TauriWindow }).window;
  delete (globalThis as unknown as { isTauri?: boolean }).isTauri;
  resetBackendOriginCache();
  setRustParityMode('strict');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LOT 10 — Transport desktop : IPC Rust seul, preview web de référence', () => {
  it('inventorie les 95 commandes et vérifie l’absence de pont HTTP desktop', () => {
    const commands = clientCommands();
    expect(commands.length).toBe(95);
    expect(new Set(commands).size).toBe(commands.length);

    const source = read('src/lib/ipc.ts');
    expect(source).not.toContain('isTauriDesktop() && window.__TAURI_INTERNALS__');
    expect(source).not.toContain('__TAURI_INTERNALS__');
    expect(source).toContain("import { invoke as tauriInvoke, isTauri }");
    expect(source).toContain('RUST_COMMAND_SET.has(command)');
    expect(source).toContain('tauriInvoke<T>(command, { input })');
    expect(source).toContain('NOT_IMPLEMENTED_IN_RUST');
    expect(source).toContain('invokeRustService');
    expect(source).not.toContain("tauriInvoke<string>('get_backend_origin')");
    expect(source).not.toContain('get_backend_origin');
    expect(source).toContain("let rustParityMode: RustParityMode = 'strict'");

    // Les quatre fetch relatifs restent exclusivement pour le navigateur/preview.
    expect(source.match(/const origin = await getBackendOrigin\(\);/g)?.length).toBe(4);
    expect(source.match(/fetch\(`\$\{origin\}/g)?.length).toBe(4);

    for (const prefix of [
      'check_system_health', 'auth_login', 'catalog_create_product',
      'stock_record_movement', 'purchases_receive_order', 'pos_create_sale',
      'consignments_customer_return', 'finance_close_session', 'reports_daily',
      'backup_restore',
    ]) {
      expect(commands).toContain(prefix);
    }
  });

  it('vérifie la coquille Rust native : 95/95, runtime IPC, aucun sidecar', () => {
    const lib = read('src-tauri/src/lib.rs');
    const runtime = read('src-tauri/src/runtime.rs');

    expect(lib).toContain('pub mod commands;');
    expect(lib).toContain('pub mod db;');
    expect(lib).toContain('pub mod runtime;');
    expect(lib).toContain('pub mod repositories;');
    expect(lib).toContain('db::init_sqlite_pool');
    expect(lib).toContain('auth_bootstrap_status');
    expect(lib).toContain('backup_restore');
    expect(lib).toContain('get_desktop_runtime_status');
    expect(lib).toContain('auto_backup_if_due');
    expect(lib).toContain('generate_handler!');
    expect(lib).not.toContain('sqlx::migrate!');
    expect(lib).not.toContain('bridge::');
    expect(lib).not.toContain('start_backend_sidecar');
    expect(lib).not.toContain('get_backend_origin');
    expect(exists('src-tauri/src/bridge.rs')).toBe(false);
    expect(exists('scripts/build-backend.mjs')).toBe(false);
    expect(runtime).toContain('TAURI_IPC_ONLY');
    expect(runtime).toContain('"sidecar": false');
    expect(exists('src-tauri/src/commands/backups.rs')).toBe(true);
    expect(exists('src-tauri/src/repositories/backup_repo.rs')).toBe(true);
    expect(exists('src-tauri/src/repositories/report_export_repo.rs')).toBe(true);
    expect(exists('src-tauri/src/domain/pdf_export.rs')).toBe(true);
  });

  it('valide la configuration Tauri : CSP IPC seule, aucune ressource Node, cibles et capacité', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      build: { beforeBuildCommand: string; beforeDevCommand: string; frontendDist: string; devUrl: string };
      app: { security: { csp: string }; windows: Array<{ label: string }> };
      bundle: {
        externalBin?: string[];
        resources: Record<string, string>;
        targets: string[];
        icon: string[];
      };
    };
    expect(config.build.beforeBuildCommand).toBe('npm run build');
    expect(config.build.beforeBuildCommand).not.toContain('backend:build');
    expect(config.build.beforeDevCommand).toContain('vite');
    expect(config.build.frontendDist).toBe('../dist');
    expect(config.build.devUrl).toBe('http://localhost:5173');
    expect(config.bundle.externalBin ?? []).toHaveLength(0);
    expect(Object.keys(config.bundle.resources)).toEqual(['../migrations/']);
    expect(config.bundle.resources['../migrations/']).toBe('migrations/');
    expect(config.app.security.csp).toContain('connect-src');
    expect(config.app.security.csp).toContain('ipc:');
    expect(config.app.security.csp).not.toContain('127.0.0.1');
    expect(config.app.security.csp).not.toContain('localhost:3000');
    expect(config.app.security.csp).not.toContain('fonts.googleapis.com');
    expect(config.app.windows[0].label).toBe('main');
    expect(config.bundle.targets).toEqual(['msi', 'nsis', 'dmg', 'app']);
    for (const icon of config.bundle.icon) {
      expect(exists(path.join('src-tauri', icon))).toBe(true);
    }
    expect(exists('src-tauri/capabilities/default.json')).toBe(true);
    const capability = JSON.parse(read('src-tauri/capabilities/default.json')) as {
      permissions: string[];
    };
    expect(capability.permissions).toContain('core:default');

    expect(read('index.html')).not.toContain('https://');
    const decision1 = read('migrations/0013_lot10_desktop_runtime.sql');
    expect(decision1).toContain('SINGLE_NODE_SQLITE_BACKEND_TAURI_SIDECAR');
    expect(decision1).toContain("n''exécute");
    const decision2 = read('migrations/0014_lot10_rust_native.sql');
    expect(decision2).toContain('RUST_SQLX_NATIVE');
    expect(decision2).toContain('TAURI_IPC_PRIMARY');
    expect(decision2).toContain('SCHEMA_MIGRATIONS_SHA256_SINGLE_OWNER');
    const decision3 = read('migrations/0015_lot10_rust_ipc_only.sql');
    expect(decision3).toContain('RUST_SQLX_NATIVE_NO_SIDECAR');
    expect(decision3).toContain('TAURI_IPC_ONLY_95_OF_95');
    expect(decision3).toContain('NO_EXTERNALBIN_NO_BACKEND_BUNDLE');
  });

  it('en mode Tauri, une commande est servie par le handler Rust (pas par HTTP)', async () => {
    const { invoke } = installWindow(true);
    expect(isTauriDesktop()).toBe(true);

    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await invokeBackend('auth_login', { username: 'patron', password: 'Password2026!' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('auth_login');
    expect(invoke.mock.calls[0][1]).toEqual({
      input: {
        username: 'patron',
        password: 'Password2026!',
        token: 'jeton-test',
      },
    });
  });

  it('en mode Tauri, les 95 commandes passent par IPC et le pont HTTP est impossible', async () => {
    const { invoke } = installWindow(true);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(getRustParityMode()).toBe('strict');
    expect(getRustParity()).toEqual({ total: 95, implemented: 95, complete: true });
    expect(await getBackendOrigin()).toBe('');

    await invokeBackend('backup_overview', {});
    await invokeBackend('backup_verify', { id: 'backup-123' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'backup_overview',
      'backup_verify',
    ]);
    expect(invoke.mock.calls.every((call) => !String(call[0]).startsWith('get_backend_'))).toBe(true);

    await expect(invokeBackend('commande_inconnue', {})).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED_IN_RUST',
    });
    // Même en mode « transitional » de recette, aucun repli HTTP n'est réactivé.
    setRustParityMode('transitional');
    await expect(invokeBackend('autre_inconnue', {})).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED_IN_RUST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('conserve les URL relatives en navigateur et route les fichiers par IPC en Tauri', async () => {
    installWindow(false);
    expect(isTauriDesktop()).toBe(false);
    expect(await getBackendOrigin()).toBe('');

    const browserFetch = vi.fn(async () => {
      const response = new Response(new Blob(['a;b']), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="fichier.csv"' },
      });
      return response;
    });
    vi.stubGlobal('fetch', browserFetch);
    stubDownloads();
    await invokeBackend('check_system_health');
    expect(callsOf(browserFetch)[0][0]).toBe('/api/system/health');
    const browserName = await downloadReportExport({ format: 'csv', dataset: 'margins' });
    expect(browserName).toBe('fichier.csv');
    expect(String(callsOf(browserFetch)[1][0])).toContain('/api/reports/export/csv?dataset=margins');

    installWindow(true);
    const desktopFetch = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', desktopFetch);
    stubDownloads();
    const exportName = await downloadReportExport({ format: 'pdf', dataset: 'sales' });
    expect(exportName).toBe('depotpro-margins-2026-11-15.csv');
    const backupName = await downloadBackupFile('backup-9');
    expect(backupName).toBe('depotpro-sauvegarde.db');
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'sauvegarde.db');
    const imported = await importBackupFile(file);
    expect(imported).toEqual({ id: 'import-1' });
    expect(desktopFetch).not.toHaveBeenCalled();
  });

  it('cadre le CORS du preview web : origines locales, préflight, refus des origines tierces', () => {
    expect(read('server.ts')).toContain('app.use(desktopCors());');

    for (const origin of [
      'tauri://localhost', 'http://tauri.localhost', 'http://localhost:3000',
      'http://127.0.0.1:3107', 'https://3000-idmqs1od0hxkr6akpujk1.e2b.app',
    ]) {
      expect(isAllowedDesktopOrigin(origin, '127.0.0.1:3000')).toBe(true);
    }
    expect(isAllowedDesktopOrigin('https://site-tiers.example', '127.0.0.1:3000')).toBe(false);
    expect(isAllowedDesktopOrigin('null', '127.0.0.1:3000')).toBe(false);
    expect(isAllowedDesktopOrigin('https://192.168.1.50:3000', '192.168.1.50:3000')).toBe(true);

    const fakeRes = () => {
      const state: {
        headers: Record<string, string>;
        status: number;
        ended: boolean;
        body?: unknown;
      } = { headers: {}, status: 200, ended: false };
      const res = {
        setHeader: (key: string, value: string) => {
          state.headers[key] = value;
        },
        status: (code: number) => {
          state.status = code;
          return res;
        },
        json: (payload: unknown) => {
          state.body = payload;
          return res;
        },
        end: () => {
          state.ended = true;
          return res;
        },
      };
      return { res, state };
    };

    const preflight = fakeRes();
    const preflightNext = vi.fn();
    desktopCors()(
      {
        method: 'OPTIONS',
        headers: {
          origin: 'tauri://localhost',
          host: '127.0.0.1:3000',
          'access-control-request-private-network': 'true',
        },
      } as never,
      preflight.res as never,
      preflightNext as never
    );
    expect(preflight.state.status).toBe(204);
    expect(preflight.state.ended).toBe(true);
    expect(preflight.state.headers['Access-Control-Allow-Origin']).toBe('tauri://localhost');
    expect(preflight.state.headers['Access-Control-Allow-Private-Network']).toBe('true');
    expect(preflight.state.headers['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(preflight.state.headers['Access-Control-Allow-Headers']).toContain(
      'X-DepotPro-Source-Checksum'
    );
    expect(preflight.state.headers).not.toHaveProperty('Access-Control-Allow-Credentials');
    expect(preflightNext).not.toHaveBeenCalled();

    const refused = fakeRes();
    const refusedNext = vi.fn();
    desktopCors()(
      { method: 'GET', headers: { origin: 'https://site-tiers.example', host: '127.0.0.1:3000' } } as never,
      refused.res as never,
      refusedNext as never
    );
    expect(refused.state.status).toBe(403);
    expect((refused.state.body as { code: string }).code).toBe('ORIGIN_NOT_ALLOWED');
    expect(refusedNext).not.toHaveBeenCalled();

    const plainNext = vi.fn();
    desktopCors()({ method: 'GET', headers: { host: '127.0.0.1:3000' } } as never, fakeRes().res as never, plainNext as never);
    expect(plainNext).toHaveBeenCalledTimes(1);
  });
});
