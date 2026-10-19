/** Server maintenance commands (src/cli.ts), run as separate processes like the `ims` tool does. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { connect, type Database } from '../src/db/index.js';
import { latestSchemaVersion } from '../src/db/migrations.js';
import { makeLegacyDb } from './helpers.js';

const serverRoot = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-cli-'));
// The commands run in other processes: the built-in database is then a folder (not memory).
const url = process.env.DATABASE_URL === 'memory://' ? '' : (process.env.DATABASE_URL ?? '');
const builtIn = url === '';

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: serverRoot,
    env: { ...process.env, DATA_DIR: dir, DATABASE_URL: url, VITEST: '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = await connect({ url, pgliteDir: path.join(dir, 'pgdata') });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

describe('server maintenance commands', () => {
  it('reports an empty database clearly', () => {
    expect(cli('schema-version')).toMatchObject({ code: 0, out: '0' });
    const r = cli('backup');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/empty/);
  }, 60_000);

  it('reset-password creates the database if needed and prints a temporary password once', async () => {
    const r = cli('reset-password', 'admin');
    expect(r.code, r.err).toBe(0);
    const password = r.out.match(/Temporary password for admin: (\S+)/)?.[1];
    expect(password).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
    const row = await withDb((db) =>
      db.get<{ password_hash: string; must_change_password: number }>(
        "SELECT password_hash, must_change_password FROM users WHERE username = 'admin'",
      ),
    );
    expect(bcrypt.compareSync(password!, row!.password_hash)).toBe(true);
    expect(row!.must_change_password).toBe(1);
    expect(cli('reset-password', 'nobody')).toMatchObject({ code: 2, err: expect.stringMatching(/Administrators: admin/) });
  }, 60_000);

  it('known-schema and schema-version agree on a current database', () => {
    expect(cli('known-schema').out).toBe(String(latestSchemaVersion));
    expect(cli('schema-version').out).toBe(String(latestSchemaVersion));
  }, 60_000);

  let backupName = '';
  it('backup makes a labelled copy in the backups folder', () => {
    const r = cli('backup', 'before-update-v1-3-0');
    expect(r.code, r.err).toBe(0);
    backupName = r.out;
    expect(backupName).toMatch(/^inventory_\d{4}-\d{2}-\d{2}_\d{6}_before-update-v1-3-0\.json\.gz$/);
    expect(fs.existsSync(path.join(dir, 'backups', backupName))).toBe(true);
    expect(cli('schema-version', path.join(dir, 'backups', backupName)).out).toBe(String(latestSchemaVersion));
    expect(cli('backup', 'Bad Label').code).toBe(2);
  }, 60_000);

  it('restore brings the copy back and keeps the replaced data as another copy', async () => {
    await withDb((db) => db.run("INSERT INTO settings (key, value) VALUES ('after_backup', 'x')"));
    const r = cli('restore', path.join(dir, 'backups', backupName));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Current data saved as inventory_.*_before-restore\.json\.gz/);
    expect(await withDb((db) => db.value("SELECT COUNT(*) FROM settings WHERE key = 'after_backup'"))).toBe(0);
    expect(cli('restore', path.join(dir, 'nope.json.gz')).code).toBe(2);
    fs.writeFileSync(path.join(dir, 'junk.json.gz'), 'not a backup');
    expect(cli('restore', path.join(dir, 'junk.json.gz'))).toMatchObject({ code: 2, err: expect.stringMatching(/not a valid/) });
  }, 60_000);

  it('restores a .db backup of version 1.2 and reports its schema', async () => {
    const file = path.join(dir, 'old.db');
    const db = makeLegacyDb(file);
    db.exec(`INSERT INTO warehouses (id, code, name, is_default) VALUES (1, 'MAIN', 'Main', 1);
             INSERT INTO users (id, username, full_name, password_hash, role) VALUES (1, 'admin', 'A', 'x', 'ADMIN');
             INSERT INTO products (id, sku, name) VALUES (1, 'FROM-1-2', 'Old');`);
    db.close();
    expect(cli('schema-version', file).out).toBe('4');
    const r = cli('restore', file);
    expect(r.code, r.err).toBe(0);
    expect(await withDb((d) => d.column('SELECT sku::text FROM products'))).toEqual(['FROM-1-2']);
  }, 60_000);

  it('an older program refuses a database upgraded by a newer one; restore --reset replaces it', async () => {
    await withDb((db) => db.run("INSERT INTO schema_migrations (version, name) VALUES (999, 'from_the_future')"));
    expect(cli('schema-version').out).toBe('999');
    const r = cli('reset-password', 'admin');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/upgraded by a newer version/);
    expect(cli('restore', path.join(dir, 'backups', backupName))).toMatchObject({ code: 2, err: expect.stringMatching(/--reset/) });
    const reset = cli('restore', path.join(dir, 'backups', backupName), '--reset');
    expect(reset.code, reset.err).toBe(0);
    expect(cli('schema-version').out).toBe(String(latestSchemaVersion));
    expect(await withDb((db) => db.value("SELECT COUNT(*) FROM users WHERE username = 'admin'"))).toBe(1);
  }, 60_000);

  it.skipIf(!builtIn)('the built-in database is never opened by two programs at once', async () => {
    await withDb(async () => {
      const r = cli('backup');
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/in use by another program/);
    });
    expect(cli('backup').code).toBe(0);
  }, 60_000);
});
