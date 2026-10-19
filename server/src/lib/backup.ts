/**
 * Database backups.
 *
 * - Automatic: once a day (checked every 30 minutes while the app runs).
 * - Manual: "Back up now" in Settings.
 * - Restore: from a listed backup or an uploaded file. The current data is backed up first,
 *   then replaced in one transaction (all or nothing); everyone is signed out because the
 *   user table may have changed.
 *
 * A backup is a .json.gz file with every table (db/dump.ts), read inside one transaction, so it
 * is consistent while the app is in use and restores on any PostgreSQL (server, hosted, or the
 * Windows app). Backups of versions up to 1.2 (.db, SQLite) can still be restored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { defaultBackupDir, getDb, getSetting, nowIso, putSetting, stampedName, type DB } from '../db/index.js';
import { InvalidBackupError, readBackupFile, writeBackup } from '../db/dump.js';
import { latestSchemaVersion, migrations, type BackupTables } from '../db/migrations.js';
import { loadTables } from '../db/dump.js';
import { InvalidSqliteFileError, isSqliteFile, readSqliteFile } from '../db/legacy/importSqlite.js';
import { badRequest } from './errors.js';

export { defaultBackupDir };

/**
 * inventory_2026-10-03_183005_manual.json.gz (and .db for backups of versions up to 1.2),
 * optionally without a label.
 */
export const BACKUP_FILE_RE = /^inventory_\d{4}-\d{2}-\d{2}_\d{6}(?:_[a-z0-9-]+)?\.(?:json\.gz|db)$/;

const DEFAULT_KEEP = 30;
const DAY_MS = 24 * 3600 * 1000;

export async function backupDir(db: DB = getDb()): Promise<string> {
  return (await getSetting('backup_dir', db)).trim() || defaultBackupDir();
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

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
}

export function listBackupsIn(dir: string): BackupFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => BACKUP_FILE_RE.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export async function listBackups(db: DB = getDb()): Promise<BackupFile[]> {
  return listBackupsIn(await backupDir(db));
}

/** Delete the oldest backups beyond the configured number to keep. */
async function prune(db: DB) {
  const keep = Math.max(1, Number(await getSetting('backup_keep', db)) || DEFAULT_KEEP);
  const dir = await backupDir(db);
  for (const f of listBackupsIn(dir).slice(keep)) fs.rmSync(path.join(dir, f.name), { force: true });
}

let running: Promise<BackupFile> | null = null;

export type BackupLabel = 'auto' | 'manual' | 'before-restore' | 'before-demo' | 'before-update';

const listeners: ((file: BackupFile) => void)[] = [];

/** Run `listener` after every successful backup (used for the cloud copies). */
export function onBackup(listener: (file: BackupFile) => void) {
  listeners.push(listener);
}

export function runBackup(label: BackupLabel = 'auto', db: DB = getDb()): Promise<BackupFile> {
  // Never run two backups at the same time.
  if (running) return running;
  running = (async () => {
    const dir = await backupDir(db);
    const problem = checkWritableDir(dir);
    if (problem) throw badRequest(problem, 'BACKUP_DIR');
    const name = stampedName(label);
    const { size } = await writeBackup(db, path.join(dir, name));
    await putSetting(db, 'last_backup_at', nowIso());
    await prune(db);
    const result = { name, size, createdAt: nowIso() };
    for (const l of listeners) {
      try {
        l(result);
      } catch (e) {
        console.error('[backup] listener failed:', e);
      }
    }
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

export interface BackupData {
  /** Rows of every table, in the shape of the current schema. */
  tables: BackupTables;
  /** Schema version the file was made with. */
  schema: number;
  /** Duplicates that differed only in letter case and were renamed (old .db backups). */
  renamed: string[];
}

/**
 * Read a backup file (.json.gz, or .db of versions up to 1.2) and bring its rows to the current
 * schema. Throws a 400 if it is not a Warehouse IMS backup or was made by a newer version.
 */
export async function readBackupData(file: string, uploadsDir = config.uploadsDir): Promise<BackupData> {
  try {
    if (isSqliteFile(file)) {
      const { tables, renamed } = readSqliteFile(file, uploadsDir);
      return { tables, schema: 0, renamed };
    }
    const content = await readBackupFile(file);
    if (content.schema > latestSchemaVersion)
      throw badRequest(
        `This backup was made by a newer version of Warehouse IMS (database schema ${content.schema}; this version knows up to ${latestSchemaVersion}). Update the app first, then restore it.`,
        'BACKUP_TOO_NEW',
      );
    let tables = content.tables;
    for (const m of [...migrations].sort((a, b) => a.version - b.version))
      if (m.version > content.schema && m.upgradeBackup) tables = m.upgradeBackup(tables);
    return { tables, schema: content.schema, renamed: [] };
  } catch (e) {
    if (e instanceof InvalidBackupError || e instanceof InvalidSqliteFileError)
      throw badRequest('This file is not a valid Warehouse IMS backup', 'INVALID_BACKUP');
    throw e;
  }
}

/** Throws if the file is not a backup this version can restore. */
export async function validateBackupFile(file: string) {
  await readBackupData(file);
}

/** Replace all data with `data` in one transaction, and sign everyone out. */
export async function loadBackupData(db: DB, data: BackupData) {
  if (!data.tables.users?.length) throw badRequest('This backup has no users', 'INVALID_BACKUP');
  await db.tx(async (t) => {
    await loadTables(t, data.tables);
    // Sessions refer to user ids of the previous data.
    await t.run('UPDATE users SET token_version = token_version + 1');
  });
}

/**
 * Replace the live data with a backup. The current data is saved first (label
 * "before-restore"), so a restore can itself be undone.
 */
export async function restoreFrom(source: string): Promise<{ safetyBackup: string; renamed: string[] }> {
  const data = await readBackupData(source);
  const db = getDb();
  const safety = await runBackup('before-restore', db);
  try {
    await loadBackupData(db, data);
  } catch (e) {
    console.error('[backup] restore failed, nothing was changed:', e);
    throw badRequest(`The backup could not be restored; nothing was changed. ${(e as Error).message}`, 'RESTORE_FAILED');
  }
  return { safetyBackup: safety.name, renamed: data.renamed };
}

// ---- Scheduler -------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

export async function backupDue(db: DB = getDb()): Promise<boolean> {
  if ((await getSetting('backup_enabled', db)) !== 'true') return false;
  const last = Date.parse(await getSetting('last_backup_at', db));
  return !Number.isFinite(last) || Date.now() - last >= DAY_MS;
}

export function startBackupScheduler() {
  if (timer) return;
  const tick = async () => {
    try {
      if (await backupDue()) await runBackup('auto');
    } catch (e) {
      console.error('[backup] failed:', (e as Error)?.message ?? e);
    }
  };
  setTimeout(() => void tick(), 60_000).unref();
  timer = setInterval(() => void tick(), 30 * 60_000);
  timer.unref();
}

export function stopBackupScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
