/**
 * Backup files: every table of the application as JSON rows, gzip-compressed (.json.gz).
 *
 * One format for every engine: a backup of the Windows app (PGlite) restores on a server
 * (PostgreSQL), and the other way round, whatever their PostgreSQL versions. Product photos are
 * included (base64). The schema version is in the file: restoring an older backup upgrades
 * its rows through the migrations; a backup from a newer program is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { appVersion } from '../config.js';
import { TABLES, type BackupTables } from './migrations.js';
import type { Sql } from './sql.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const BACKUP_FORMAT = 'warehouse-ims-backup';

export interface BackupContent {
  format: typeof BACKUP_FORMAT;
  formatVersion: 1;
  /** Schema version of the data (100+: PostgreSQL; 1-4: converted from SQLite). */
  schema: number;
  appVersion: string;
  createdAt: string;
  tables: BackupTables;
}

interface ColumnInfo {
  name: string;
  type: string;
}

/** Columns that can be written (generated columns such as search_text are computed). */
async function columnsOf(db: Sql, table: string): Promise<ColumnInfo[]> {
  return db.all<ColumnInfo>(
    `SELECT column_name AS name, data_type AS type FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ? AND is_generated = 'NEVER'
     ORDER BY ordinal_position`,
    table,
  );
}

const toBase64 = (v: unknown) => Buffer.from(v as Uint8Array).toString('base64');

/** All rows of all tables, in a consistent state (read inside one transaction). */
export async function dumpTables(db: Sql): Promise<{ schema: number; tables: BackupTables }> {
  return db.tx(async (t) => {
    const schema = (await t.value<number>('SELECT MAX(version) FROM schema_migrations')) ?? 0;
    const tables: BackupTables = {};
    for (const table of TABLES) {
      const cols = await columnsOf(t, table);
      if (!cols.length) continue;
      const order = cols.some((c) => c.name === 'id') ? 'id' : cols[0].name;
      const rows = await t.all(`SELECT ${cols.map((c) => `"${c.name}"`).join(', ')} FROM ${table} ORDER BY ${order}`);
      const binary = cols.filter((c) => c.type === 'bytea').map((c) => c.name);
      for (const r of rows) for (const b of binary) if (r[b] != null) r[b] = toBase64(r[b]);
      tables[table] = rows;
    }
    return { schema, tables };
  });
}

export async function encodeBackup(content: Omit<BackupContent, 'format' | 'formatVersion'>): Promise<Buffer> {
  const full: BackupContent = { format: BACKUP_FORMAT, formatVersion: 1, ...content };
  return gzip(Buffer.from(JSON.stringify(full)), { level: 6 });
}

/** Write a backup of the database to `file` (atomically: never a half-written file). */
export async function writeBackup(db: Sql, file: string): Promise<{ size: number }> {
  const { schema, tables } = await dumpTables(db);
  const data = await encodeBackup({ schema, appVersion, createdAt: new Date().toISOString(), tables });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
  return { size: data.length };
}

export class InvalidBackupError extends Error {}

export async function decodeBackup(data: Buffer): Promise<BackupContent> {
  let parsed: BackupContent;
  try {
    parsed = JSON.parse((await gunzip(data)).toString('utf8'));
  } catch {
    throw new InvalidBackupError('This file is not a valid Warehouse IMS backup');
  }
  if (parsed?.format !== BACKUP_FORMAT || typeof parsed.schema !== 'number' || typeof parsed.tables !== 'object')
    throw new InvalidBackupError('This file is not a valid Warehouse IMS backup');
  return parsed;
}

export async function readBackupFile(file: string): Promise<BackupContent> {
  return decodeBackup(fs.readFileSync(file));
}

/**
 * Replace every table's contents with `tables` (rows of the current schema). Must run inside a
 * transaction: on any error nothing changes. Columns the rows do not have get their defaults;
 * columns the database does not have are ignored.
 */
export async function loadTables(t: Sql, tables: BackupTables) {
  await t.exec('SET CONSTRAINTS ALL DEFERRED');
  await t.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  for (const table of TABLES) {
    const rows = tables[table];
    if (!rows?.length) continue;
    const dbCols = await columnsOf(t, table);
    const present = new Set(rows.flatMap((r) => Object.keys(r)));
    const cols = dbCols.filter((c) => present.has(c.name));
    if (!cols.length) continue;
    const binary = new Set(cols.filter((c) => c.type === 'bytea').map((c) => c.name));
    // Stay well below the 65535 parameters of one statement.
    const batch = Math.max(1, Math.floor(30000 / cols.length));
    const identity = dbCols.some((c) => c.name === 'id') ? ' OVERRIDING SYSTEM VALUE' : '';
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch);
      const values: (string | number | null | Uint8Array)[] = [];
      const tuples = chunk.map((r) => {
        const marks = cols.map((c) => {
          let v = r[c.name] as unknown;
          if (v === undefined) return 'DEFAULT';
          if (binary.has(c.name) && v != null) v = typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.from(v as Uint8Array);
          values.push(v as string | number | null | Uint8Array);
          return '?';
        });
        return `(${marks.join(', ')})`;
      });
      await t.run(
        `INSERT INTO ${table} (${cols.map((c) => `"${c.name}"`).join(', ')})${identity} VALUES ${tuples.join(', ')}`,
        ...values,
      );
    }
  }
  // Identity counters continue after the highest loaded id.
  for (const table of TABLES) {
    const hasId = await t.value<number>(
      `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'id' AND is_identity = 'YES'`,
      table,
    );
    if (hasId)
      await t.exec(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`,
      );
  }
  await t.exec('SET CONSTRAINTS ALL IMMEDIATE');
}
