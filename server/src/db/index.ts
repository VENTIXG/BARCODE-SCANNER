import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { migrations, type Migration } from './migrations.js';
import { openPglite, openPostgres, type Database, type Sql } from './sql.js';
import { writeBackup } from './dump.js';
import { importLegacyIfPresent } from './legacy/importSqlite.js';

export type DB = Sql;
export type { Database, Sql } from './sql.js';

/** Lower-case and strip accents so "Καφές" matches "καφες" (the database has the same: ims_norm). */
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

export const defaultBackupDir = () => path.join(config.dataDir, 'backups');

/** Same naming as the backups: inventory_2026-10-03_183005_<label><ext> (local time). */
export function stampedName(label?: string, ext = '.json.gz', d = new Date()) {
  const z = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  return `inventory_${stamp}${label ? `_${label}` : ''}${ext}`;
}

export interface OpenOptions {
  /** postgres://... , memory://, or empty for PGlite files in pgliteDir. Default: DATABASE_URL. */
  url?: string;
  pgliteDir?: string;
  quiet?: boolean;
  /** Where the copy before a schema upgrade goes; null: no copy. */
  backupDir?: string | null;
  /** Copy data of versions up to 1.2 (inventory.db) into an empty database. Default: yes. */
  importLegacy?: boolean;
}

export async function connect(opts: Pick<OpenOptions, 'url' | 'pgliteDir'> = {}): Promise<Database> {
  const url = opts.url ?? config.databaseUrl;
  if (/^postgres(ql)?:\/\//i.test(url)) return openPostgres(url);
  if (url === 'memory://') return openPglite();
  if (url) throw new Error(`DATABASE_URL must start with postgres:// (or be empty for the built-in database)`);
  const dir = opts.pgliteDir ?? config.pgliteDir;
  fs.mkdirSync(dir, { recursive: true });
  const release = lockDataDir(dir);
  let db: Database;
  try {
    db = await openPglite(dir);
  } catch (e) {
    release();
    throw e;
  }
  const close = db.close.bind(db);
  return Object.assign(db, {
    close: async () => {
      try {
        await close();
      } finally {
        release();
      }
    },
  });
}

export class DatabaseInUseError extends Error {}

/**
 * The built-in database can be opened by one program at a time (two would damage it):
 * a lock file next to the folder holds the process id of the program using it.
 */
function lockDataDir(dir: string): () => void {
  const lock = `${dir}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.rmSync(lock, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(lock, 'utf8').trim());
      if (pid && pid !== process.pid && isRunning(pid))
        throw new DatabaseInUseError(
          `The database in ${dir} is in use by another program (process ${pid}). Close Warehouse IMS first.`,
        );
      // Left behind by a program that has ended (or by this one, in an earlier container).
      fs.rmSync(lock, { force: true });
    }
  }
  throw new DatabaseInUseError(`Could not lock the database in ${dir}`);
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Open the database, bring its schema up to date and make sure the base data exists. */
export async function openDatabase(opts: OpenOptions = {}): Promise<Database> {
  const db = await connect(opts);
  try {
    const backupDir = opts.backupDir === undefined ? defaultBackupDir() : opts.backupDir;
    await migrate(db, migrations, backupDir);
    if (opts.importLegacy !== false) await importLegacyIfPresent(db, { quiet: opts.quiet, backupDir });
    await ensureBaseData(db, opts.quiet);
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
  return db;
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

export async function schemaVersion(db: Sql): Promise<number> {
  const exists = await db.value<number>(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`);
  return exists ? ((await db.value<number>('SELECT MAX(version) FROM schema_migrations')) ?? 0) : 0;
}

/**
 * Apply pending migrations in order, in one transaction (PostgreSQL changes the schema
 * transactionally, so a failed upgrade leaves nothing half done). An existing database is
 * copied to backupDir first. Two servers starting together are serialised by the write lock.
 */
export async function migrate(db: Database, list: Migration[] = migrations, backupDir: string | null = defaultBackupDir()) {
  await db.tx((t) => t.exec(MIGRATIONS_TABLE));
  const applied = new Set(await db.column<number>('SELECT version FROM schema_migrations'));
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

  if (applied.size > 0 && backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    const file = path.join(backupDir, stampedName(`before-migrate-v${pending[0].version}`));
    await writeBackup(db, file);
    console.log(`[migrate] Saved a copy before upgrading: ${file}`);
  }

  await db.tx(async (t) => {
    const done = new Set(await t.column<number>('SELECT version FROM schema_migrations'));
    for (const m of pending) {
      if (done.has(m.version)) continue;
      await t.exec(m.sql);
      await t.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', m.version, m.name);
    }
  });
}

/** Default warehouse, default settings and a first admin account. */
async function ensureBaseData(db: Database, quiet = false) {
  await db.tx(async (t) => {
    const wh = await t.get('SELECT id FROM warehouses WHERE is_default = 1');
    if (!wh) {
      const any = await t.value<number>('SELECT id FROM warehouses ORDER BY id LIMIT 1');
      if (any) await t.run('UPDATE warehouses SET is_default = 1 WHERE id = ?', any);
      else await t.run(`INSERT INTO warehouses (code, name, is_default) VALUES ('MAIN', 'Main Warehouse', 1)`);
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS))
      await t.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', k, v);

    const users = await t.value<number>('SELECT COUNT(*) FROM users');
    if (users === 0) {
      const password = process.env.ADMIN_PASSWORD ?? 'admin123';
      if (config.requireAdminPassword && (!process.env.ADMIN_PASSWORD || password === 'admin123' || password.length < 12)) {
        throw new Error(
          'First start needs ADMIN_PASSWORD (at least 12 characters, not the default). Set it in the environment and start again.',
        );
      }
      // A first admin with the built-in default password must change it after signing in (the
      // server refuses everything else until then). A password set in ADMIN_PASSWORD was chosen.
      const builtIn = !process.env.ADMIN_PASSWORD;
      await t.run(
        `INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES ('admin', 'Administrator', ?, 'ADMIN', ?)`,
        bcrypt.hashSync(password, 10),
        builtIn ? 1 : 0,
      );
      // Never print the password: logs are often shared or kept.
      if (!quiet && !process.env.VITEST)
        console.log(
          builtIn
            ? "[setup] Created initial admin user 'admin' with the default password. Change it after the first login."
            : "[setup] Created initial admin user 'admin' with the password from ADMIN_PASSWORD.",
        );
    }
  });
}

let instance: Database | null = null;
let opening: Promise<Database> | null = null;

/** Open the application's database once (server start, CLI, tests). */
export function initDb(opts?: OpenOptions): Promise<Database> {
  if (instance) return Promise.resolve(instance);
  opening ??= openDatabase(opts)
    .then((db) => (instance = db))
    .finally(() => {
      opening = null;
    });
  return opening;
}

/** The open database (initDb() must have run). Inside db.tx() it joins that transaction. */
export function getDb(): Database {
  if (!instance) throw new Error('The database is not open yet: call initDb() first');
  return instance;
}

export const isDbOpen = () => instance !== null;

/** For tests and restore: use another open database. */
export function setDb(db: Database | null) {
  instance = db;
}

/** Close the database; the next initDb() opens it again. */
export async function closeDb() {
  const db = instance;
  instance = null;
  await db?.close();
}

export async function getDefaultWarehouseId(db: Sql = getDb()): Promise<number> {
  return (await db.value<number>('SELECT id FROM warehouses WHERE is_default = 1')) as number;
}

export async function getSetting(key: string, db: Sql = getDb()): Promise<string> {
  const v = await db.value<string>('SELECT value FROM settings WHERE key = ?', key);
  return v ?? DEFAULT_SETTINGS[key] ?? '';
}

export async function putSetting(db: Sql, key: string, value: string) {
  await db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    nowIso(),
  );
}

export const nowIso = () => new Date().toISOString();
