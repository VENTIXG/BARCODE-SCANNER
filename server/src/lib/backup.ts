/**
 * Database backups.
 *
 * - Automatic: once a day (checked every 30 minutes while the app runs).
 * - Manual: "Back up now" in Settings.
 * - Restore: from a listed backup or an uploaded .db file. The current
 *   database is backed up first, then replaced in place; everyone is signed
 *   out because the user table may have changed.
 *
 * Backups use SQLite's online backup API, so they are consistent while the
 * app is in use.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { closeDb, getDb, getSetting, nowIso, type DB } from '../db/index.js';
import { badRequest } from './errors.js';

/** inventory_2026-10-03_183005.db, optionally with a label: inventory_2026-10-03_183005_manual.db */
export const BACKUP_FILE_RE = /^inventory_\d{4}-\d{2}-\d{2}_\d{6}(?:_[a-z-]+)?\.db$/;

const DEFAULT_KEEP = 30;
const DAY_MS = 24 * 3600 * 1000;

export const defaultBackupDir = () => path.join(config.dataDir, 'backups');

export function backupDir(db: DB = getDb()): string {
  return getSetting('backup_dir', db).trim() || defaultBackupDir();
}

/** Make sure a folder exists and is writable; returns an error message or null. */
export function checkWritableDir(dir: string): string | null {
  if (!path.isAbsolute(dir)) return 'The backup folder must be a full path, e.g. D:\\Backups';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.ims-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return null;
  } catch {
    return `The folder ${dir} cannot be created or is not writable`;
  }
}

function stamp(d = new Date()) {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
}

export function listBackups(db: DB = getDb()): BackupFile[] {
  const dir = backupDir(db);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => BACKUP_FILE_RE.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Delete the oldest backups beyond the configured number to keep. */
function prune(db: DB) {
  const keep = Math.max(1, Number(getSetting('backup_keep', db)) || DEFAULT_KEEP);
  const dir = backupDir(db);
  for (const f of listBackups(db).slice(keep)) fs.rmSync(path.join(dir, f.name), { force: true });
}

let running: Promise<BackupFile> | null = null;

export function runBackup(label: 'auto' | 'manual' | 'before-restore' = 'auto', db: DB = getDb()): Promise<BackupFile> {
  // Never run two backups at the same time.
  if (running) return running;
  running = (async () => {
    const dir = backupDir(db);
    const problem = checkWritableDir(dir);
    if (problem) throw badRequest(problem, 'BACKUP_DIR');
    const name = `inventory_${stamp()}_${label}.db`;
    const file = path.join(dir, name);
    await db.backup(file);
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('last_backup_at', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(nowIso(), nowIso());
    prune(db);
    return { name, size: fs.statSync(file).size, createdAt: nowIso() };
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Throws if the file is not a readable Warehouse IMS database. */
export function validateBackupFile(file: string) {
  let check: Database.Database | null = null;
  try {
    check = new Database(file, { readonly: true, fileMustExist: true });
    const tables = check
      .prepare(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('products', 'inventory_transactions', 'users')`)
      .pluck()
      .get() as number;
    if (tables !== 3) throw new Error('missing tables');
    const ok = check.pragma('quick_check', { simple: true });
    if (ok !== 'ok') throw new Error('damaged');
  } catch {
    throw badRequest('This file is not a valid Warehouse IMS backup', 'INVALID_BACKUP');
  } finally {
    check?.close();
  }
}

/**
 * Replace the live database with a backup. The current data is saved first
 * (label "before-restore"), so a restore can itself be undone.
 */
export async function restoreFrom(source: string): Promise<{ safetyBackup: string }> {
  validateBackupFile(source);
  const safety = await runBackup('before-restore');

  const tmp = `${config.dbFile}.restoring`;
  fs.copyFileSync(source, tmp);
  closeDb();
  for (const f of [`${config.dbFile}-wal`, `${config.dbFile}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(tmp, config.dbFile);

  // Reopening runs migrations, so backups from older versions are upgraded.
  const db = getDb();
  // Sessions refer to user ids of the previous data: sign everyone out.
  db.prepare('UPDATE users SET token_version = token_version + 1').run();
  return { safetyBackup: safety.name };
}

// ---- Scheduler -------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

export function backupDue(db: DB = getDb()): boolean {
  if (getSetting('backup_enabled', db) !== 'true') return false;
  const last = Date.parse(getSetting('last_backup_at', db));
  return !Number.isFinite(last) || Date.now() - last >= DAY_MS;
}

export function startBackupScheduler() {
  if (timer) return;
  const tick = () => {
    try {
      if (backupDue()) runBackup('auto').catch((e) => console.error('[backup] failed:', e?.message ?? e));
    } catch (e) {
      console.error('[backup] check failed:', e);
    }
  };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, 30 * 60_000);
  timer.unref();
}

export function stopBackupScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
