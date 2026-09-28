import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { migrations } from './migrations.js';

export type DB = Database.Database;

/** Lower-case and strip accents so "Καφές" matches "καφες" (also used for FTS). */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ς/g, 'σ');
}

export const DEFAULT_SETTINGS: Record<string, string> = {
  company_name: 'My Company',
  currency: 'EUR',
  allow_negative_stock: 'false',
  default_unit: 'pcs',
};

export function openDatabase(file: string = config.dbFile): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.function('ims_norm', { deterministic: true }, (v: unknown) => (v == null ? null : normalizeText(String(v))));
  migrate(db);
  ensureBaseData(db);
  return db;
}

function migrate(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[],
  );
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    })();
  }
}

/** Default warehouse, default settings and a first admin account. */
function ensureBaseData(db: DB) {
  db.transaction(() => {
    const wh = db.prepare('SELECT id FROM warehouses WHERE is_default = 1').get();
    if (!wh) {
      const any = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get() as { id: number } | undefined;
      if (any) db.prepare('UPDATE warehouses SET is_default = 1 WHERE id = ?').run(any.id);
      else
        db.prepare(`INSERT INTO warehouses (code, name, is_default) VALUES ('MAIN', 'Main Warehouse', 1)`).run();
    }
    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

    const users = db.prepare('SELECT COUNT(*) FROM users').pluck().get() as number;
    if (users === 0) {
      const password = process.env.ADMIN_PASSWORD ?? 'admin123';
      db.prepare(
        `INSERT INTO users (username, full_name, password_hash, role) VALUES ('admin', 'Administrator', ?, 'ADMIN')`,
      ).run(bcrypt.hashSync(password, 10));
      if (!process.env.VITEST)
        console.log(`[setup] Created initial admin user: admin / ${password} — change this password after first login.`);
    }
  })();
}

let instance: DB | null = null;

export function getDb(): DB {
  if (!instance) instance = openDatabase();
  return instance;
}

/** For tests: swap the active database. */
export function setDb(db: DB) {
  instance = db;
}

export function getDefaultWarehouseId(db: DB = getDb()): number {
  return db.prepare('SELECT id FROM warehouses WHERE is_default = 1').pluck().get() as number;
}

export function getSetting(key: string, db: DB = getDb()): string {
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
  return v ?? DEFAULT_SETTINGS[key] ?? '';
}

export const nowIso = () => new Date().toISOString();
