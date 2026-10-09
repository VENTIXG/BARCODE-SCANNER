import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { migrations, type Migration } from './migrations.js';
import { defaultBackupDir, stampedName } from '../lib/backup.js';
import fs from 'node:fs';
import path from 'node:path';

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
  backup_enabled: 'true',
  backup_dir: '',
  backup_keep: '30',
  last_backup_at: '',
};

export function openDatabase(file: string = config.dbFile, opts: { quiet?: boolean; backupDir?: string | null } = {}): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.function('ims_norm', { deterministic: true }, (v: unknown) => (v == null ? null : normalizeText(String(v))));
  migrate(db, migrations, opts.backupDir === undefined ? defaultBackupDir() : opts.backupDir);
  ensureBaseData(db, opts.quiet);
  return db;
}

/**
 * Apply pending migrations in order, each in its own transaction.
 * When an existing database is about to be upgraded, a copy is saved first
 * (VACUUM INTO), so a failed upgrade can always be undone from that copy.
 */
export function migrate(db: DB, list: Migration[] = migrations, backupDir: string | null = defaultBackupDir()) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[],
  );
  // An older program must not touch a database that a newer one has upgraded (after a
  // rollback, for example): it could misread or damage data it does not know about.
  const known = Math.max(0, ...list.map((m) => m.version));
  const newest = Math.max(0, ...applied);
  if (newest > known) {
    throw new Error(
      `This database was upgraded by a newer version of Warehouse IMS (database schema ${newest}; this version knows up to ${known}). ` +
        'Install the newer version again, or restore a backup made before the upgrade.',
    );
  }
  const pending = list.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  if (!pending.length) return;

  // Only an upgrade of an existing database needs a copy; a brand-new one has no data.
  const isUpgrade = applied.size > 0;
  if (isUpgrade && backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    const file = path.join(backupDir, stampedName(`before-migrate-v${pending[0].version}`));
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`[migrate] Saved a copy before upgrading: ${file}`);
  }

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    })();
  }
}

/** Default warehouse, default settings and a first admin account. */
function ensureBaseData(db: DB, quiet = false) {
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
      if (config.requireAdminPassword && (!process.env.ADMIN_PASSWORD || password === 'admin123' || password.length < 12)) {
        throw new Error(
          'First start needs ADMIN_PASSWORD (at least 12 characters, not the default). Set it in the environment and start again.',
        );
      }
      // A first admin with the well-known default password must change it after signing in.
      db.prepare(
        `INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES ('admin', 'Administrator', ?, 'ADMIN', ?)`,
      ).run(bcrypt.hashSync(password, 10), password === 'admin123' ? 1 : 0);
      // Never print the password: logs are often shared or kept.
      if (!quiet && !process.env.VITEST)
        console.log(
          password === 'admin123'
            ? "[setup] Created initial admin user 'admin' with the default password. Change it after the first login."
            : "[setup] Created initial admin user 'admin' with the password from ADMIN_PASSWORD.",
        );
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

/** Close the active connection; the next getDb() reopens the database file. */
export function closeDb() {
  if (instance?.open) instance.close();
  instance = null;
}

export function getDefaultWarehouseId(db: DB = getDb()): number {
  return db.prepare('SELECT id FROM warehouses WHERE is_default = 1').pluck().get() as number;
}

export function getSetting(key: string, db: DB = getDb()): string {
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
  return v ?? DEFAULT_SETTINGS[key] ?? '';
}

export const nowIso = () => new Date().toISOString();
