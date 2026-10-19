/**
 * Data of versions up to 1.2 (SQLite: inventory.db and .db backups) into PostgreSQL.
 *
 * - On the first start of 1.3+ with an empty database, an inventory.db found in the data folder
 *   is copied in automatically: the Windows app and servers keep their data across the update.
 *   The old file is left untouched (a rollback to 1.2 still finds it).
 * - An old .db backup can still be restored (Settings > Backups); it goes through the same path.
 *
 * The file is read from a temporary copy, brought to the last SQLite schema with the old
 * migrations, and turned into backup rows (photos from the uploads folder included).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../../config.js';
import { TABLES, type BackupTables } from '../migrations.js';
import { loadTables, writeBackup } from '../dump.js';
import type { Sql } from '../sql.js';
import { migrations as sqliteMigrations } from './sqliteMigrations.js';

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ς/g, 'σ');

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Unique names in PostgreSQL ignore case for every letter (SQLite only for A-Z): rename clashes. */
const UNIQUE_IGNORING_CASE: [table: string, column: string, scope?: string][] = [
  ['users', 'username'],
  ['categories', 'name'],
  ['suppliers', 'name'],
  ['warehouses', 'code'],
  ['products', 'sku'],
  ['warehouse_locations', 'code', 'warehouse_id'],
];

export class InvalidSqliteFileError extends Error {}

/** True for an SQLite file (first bytes "SQLite format 3"). */
export function isSqliteFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(15);
    fs.readSync(fd, head, 0, 15, 0);
    fs.closeSync(fd);
    return head.toString('latin1') === 'SQLite format 3';
  } catch {
    return false;
  }
}

/** Rows of every table of an SQLite database of versions up to 1.2. */
export function readSqliteFile(file: string, uploadsDir = config.uploadsDir): { tables: BackupTables; renamed: string[] } {
  if (!isSqliteFile(file)) throw new InvalidSqliteFileError('This file is not a valid Warehouse IMS backup');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-legacy-'));
  const copy = path.join(tmpDir, 'legacy.db');
  fs.copyFileSync(file, copy);
  // A database closed without a checkpoint keeps recent changes in its -wal file.
  if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
  let db: Database.Database | null = null;
  try {
    db = new Database(copy);
    db.pragma('foreign_keys = OFF');
    db.function('ims_norm', { deterministic: true }, (v: unknown) => (v == null ? null : norm(String(v))));
    const has = (t: string) => Boolean(db!.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    if (!has('products') || !has('users') || !has('inventory_transactions'))
      throw new InvalidSqliteFileError('This file is not a valid Warehouse IMS backup');

    // Bring the file to the last SQLite schema (1.2).
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]);
    for (const m of [...sqliteMigrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      db.transaction(() => {
        db!.exec(m.sql);
        db!.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      })();
    }

    const tables: BackupTables = {};
    for (const table of TABLES) {
      if (table === 'product_images' || !has(table)) continue;
      tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
    }

    // Photos were files in the uploads folder; now they go into the database.
    const images: Record<string, unknown>[] = [];
    for (const p of tables.products ?? []) {
      const name = p.image_path as string | null;
      if (!name) continue;
      const src = path.join(uploadsDir, path.basename(name));
      const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
      if (type && fs.existsSync(src)) images.push({ name, product_id: p.id, content_type: type, data: fs.readFileSync(src) });
      else p.image_path = null;
    }
    tables.product_images = images;

    const renamed = renameCaseClashes(tables);
    return { tables, renamed };
  } finally {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function renameCaseClashes(tables: BackupTables): string[] {
  const renamed: string[] = [];
  for (const [table, column, scope] of UNIQUE_IGNORING_CASE) {
    const seen = new Set<string>();
    for (const row of tables[table] ?? []) {
      const value = row[column];
      if (typeof value !== 'string') continue;
      const key = (r: string) => `${scope ? row[scope] : ''}|${r.toLowerCase()}`;
      if (!seen.has(key(value))) {
        seen.add(key(value));
        continue;
      }
      let n = 2;
      while (seen.has(key(`${value}-${n}`))) n++;
      row[column] = `${value}-${n}`;
      seen.add(key(row[column] as string));
      renamed.push(`${table}.${column}: "${value}" -> "${row[column]}"`);
    }
  }
  return renamed;
}

interface LegacyMark {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** Size and time of the old file and its -wal: a quick check whether the old version wrote to it. */
function quickMark(file: string): Omit<LegacyMark, 'sha256'> {
  let size = 0;
  let mtimeMs = 0;
  for (const f of [file, `${file}-wal`]) {
    if (!fs.existsSync(f)) continue;
    const st = fs.statSync(f);
    size += st.size;
    mtimeMs = Math.max(mtimeMs, Math.round(st.mtimeMs));
  }
  return { size, mtimeMs };
}

function contentHash(file: string): string {
  const h = crypto.createHash('sha256');
  for (const f of [file, `${file}-wal`]) if (fs.existsSync(f)) h.update(fs.readFileSync(f));
  return h.digest('hex');
}

/**
 * The data of version 1.2 (inventory.db) into PostgreSQL:
 *  - first start after the update, empty database: copied;
 *  - the old version wrote to its file after that copy (it ran again after a rollback, and
 *    was used): its data is the newer one, so it is copied again, after a backup of the
 *    current data (label before-reimport).
 * Each copy runs in one transaction: if anything fails, nothing is kept and the next start
 * tries again. The old file itself is never changed.
 */
export async function importLegacyIfPresent(db: Sql, opts: { quiet?: boolean; backupDir?: string | null } = {}) {
  const file = config.legacyDbFile;
  if (!fs.existsSync(file)) return;
  const quick = quickMark(file);
  let mark: LegacyMark | null = null;
  if (((await db.value<number>('SELECT COUNT(*) FROM users')) ?? 0) > 0) {
    const saved = await db.value<string>("SELECT value FROM settings WHERE key = 'legacy_import'");
    // A database that was never filled from the old file is not touched.
    if (!saved) return;
    mark = JSON.parse(saved) as LegacyMark;
    if (mark.size === quick.size && mark.mtimeMs === quick.mtimeMs) return;
    const sha256 = contentHash(file);
    if (sha256 === mark.sha256) {
      await saveMark(db, { ...quick, sha256 });
      return;
    }
    console.warn(`[import] ${file} was changed by the previous version after it was copied: copying its data again.`);
    const dir = (await db.value<string>("SELECT value FROM settings WHERE key = 'backup_dir'"))?.trim() || opts.backupDir;
    if (dir) {
      const { stampedName } = await import('../index.js');
      const copy = path.join(dir, stampedName('before-reimport'));
      await writeBackup(db, copy);
      console.warn(`[import] The data until now was saved as ${copy}`);
    }
  }
  const sha256 = contentHash(file);
  const { tables, renamed } = readSqliteFile(file);
  await db.tx(async (t) => {
    await loadTables(t, tables);
    await t.run(
      `INSERT INTO settings (key, value) VALUES ('legacy_imported_from', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      `${file} (${new Date().toISOString()})`,
    );
    await saveMark(t, { ...quick, sha256 });
    // Sessions of the replaced data are not valid any more.
    if (mark) await t.run('UPDATE users SET token_version = token_version + 1');
  });
  if (!opts.quiet) {
    const counts = TABLES.filter((t) => tables[t]?.length).map((t) => `${t} ${tables[t].length}`);
    console.log(`[import] Copied the data of the previous version (${file}) into PostgreSQL: ${counts.join(', ')}`);
    for (const r of renamed) console.warn(`[import] Renamed a duplicate that differed only in letter case: ${r}`);
  }
}

async function saveMark(db: Sql, mark: LegacyMark) {
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('legacy_import', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(mark),
  );
}
