import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const REPOS = [
  'src-tauri/src/repositories/common.rs',
  'src-tauri/src/repositories/catalog_repo.rs',
  'src-tauri/src/repositories/stock_repo.rs',
  'src-tauri/src/repositories/supplier_repo.rs',
  'src-tauri/src/repositories/purchase_repo.rs',
  'src-tauri/src/repositories/customer_repo.rs',
  'src-tauri/src/repositories/pos_repo.rs',
  'src-tauri/src/repositories/consignment_repo.rs',
  'src-tauri/src/repositories/finance_repo.rs',
  'src-tauri/src/repositories/reports_repo.rs',
  'src-tauri/src/repositories/backup_repo.rs',
  'src-tauri/src/repositories/report_export_repo.rs',
  'src-tauri/src/domain/backup.rs',
];

/** Extrait les littéraux SQL passés à sqlx::query / sqlx::query_as. */
function rustQueries(source: string): string[] {
  return Array.from(
    source.matchAll(/sqlx::query(?:_as)?\(\s*"([^"]*)"/gs),
    (m) => m[1]
  );
}

/** Applique les 15 migrations sur une base vierge, comme verify-delivery.mjs. */
function migratedDatabase(): DatabaseSync {
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
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
  return db;
}

describe('LOT 10 — SQL des dépôts Rust compilé contre le schéma SQLite réel', () => {
  it('prépare toutes les requêtes des tranches 2-4 sans erreur de table ou de colonne', () => {
    const db = migratedDatabase();
    const failures: string[] = [];
    let prepared = 0;
    try {
      for (const file of REPOS) {
        for (const sql of rustQueries(read(file))) {
          try {
            // prepare() compile la requête : résout tables, colonnes, alias,
            // ON CONFLICT, fonctions et nombre de marqueurs ?, sans l'exécuter.
            db.prepare(sql);
            prepared += 1;
          } catch (error) {
            failures.push(`${file} → ${String(error)} :: ${sql.slice(0, 90).replace(/\s+/g, ' ')}`);
          }
        }
      }
    } finally {
      db.close();
    }
    expect(failures, failures.join('\n')).toEqual([]);
    expect(prepared).toBe(241);
  });

  it('vérifie que chaque requête a autant de .bind() que de marqueurs ?', () => {
    const terminator = /\.execute\(|\.fetch_(?:all|one|optional)\(/;
    const mismatches: string[] = [];
    for (const file of REPOS) {
      const source = read(file);
      for (const match of source.matchAll(/sqlx::query(?:_as)?\(\s*"([^"]*)"/gs)) {
        const placeholders = (match[1].match(/\?/g) ?? []).length;
        const end = terminator.exec(source.slice(match.index! + match[0].length));
        const chain = source.slice(
          match.index! + match[0].length,
          end ? match.index! + match[0].length + end.index : source.length
        );
        const binds = (chain.match(/\.bind\(/g) ?? []).length;
        if (binds !== placeholders) {
          mismatches.push(`${file} : ${placeholders} ? pour ${binds} .bind()`);
        }
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('applique les 15 migrations sans casser la non-régression LOT 9', () => {
    const db = migratedDatabase();
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as
        | { integrity_check: string }
        | undefined;
      expect(integrity?.integrity_check).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      const counts = db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .get() as { c: number } | undefined;
      expect(counts?.c).toBe(43);
      const lot = db
        .prepare("SELECT value FROM system_meta WHERE key='app.lot_current'")
        .get() as { value: string } | undefined;
      expect(lot?.value).toBe('LOT_9');
    } finally {
      db.close();
    }
    // Le dossier temporaire n'est pas utilisé (base en mémoire) : garde-fou
    // explicite pour éviter toute écriture de données de test dans data/.
    expect(fs.existsSync(path.join(os.tmpdir(), 'depotpro-rust-sql-probe'))).toBe(false);
  });
});
