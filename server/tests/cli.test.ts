/** Server maintenance commands (src/cli.ts), run as separate processes like the `ims` tool does. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { latestSchemaVersion } from '../src/db/migrations.js';

const serverRoot = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-cli-'));
const dbFile = path.join(dir, 'inventory.db');

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: serverRoot,
    env: { ...process.env, DATA_DIR: dir, VITEST: '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe('server maintenance commands', () => {
  it('reports a missing database clearly', () => {
    const r = cli('schema-version');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/No database/);
  });

  it('reset-password creates the database if needed and prints a temporary password once', () => {
    const r = cli('reset-password', 'admin');
    expect(r.code, r.err).toBe(0);
    const password = r.out.match(/Temporary password for admin: (\S+)/)?.[1];
    expect(password).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
    const db = new Database(dbFile, { readonly: true });
    const row = db.prepare("SELECT password_hash, must_change_password FROM users WHERE username = 'admin'").get() as {
      password_hash: string;
      must_change_password: number;
    };
    db.close();
    expect(bcrypt.compareSync(password!, row.password_hash)).toBe(true);
    expect(row.must_change_password).toBe(1);
    expect(cli('reset-password', 'nobody')).toMatchObject({ code: 2, err: expect.stringMatching(/Administrators: admin/) });
  }, 60_000);

  it('known-schema and schema-version agree on a current database', () => {
    expect(cli('known-schema').out).toBe(String(latestSchemaVersion));
    expect(cli('schema-version').out).toBe(String(latestSchemaVersion));
  }, 60_000);

  let backupName = '';
  it('backup makes a labelled copy in the backups folder', () => {
    const r = cli('backup', 'before-update-v1-2-0');
    expect(r.code, r.err).toBe(0);
    backupName = r.out;
    expect(backupName).toMatch(/^inventory_\d{4}-\d{2}-\d{2}_\d{6}_before-update-v1-2-0\.db$/);
    expect(fs.existsSync(path.join(dir, 'backups', backupName))).toBe(true);
    expect(cli('schema-version', path.join(dir, 'backups', backupName)).out).toBe(String(latestSchemaVersion));
    expect(cli('backup', 'Bad Label').code).toBe(2);
  }, 60_000);

  it('restore brings the copy back and keeps the replaced data as another copy', () => {
    const db = new Database(dbFile);
    db.prepare("INSERT INTO settings (key, value) VALUES ('after_backup', 'x')").run();
    db.close();
    const r = cli('restore', path.join(dir, 'backups', backupName));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Current data saved as inventory_.*_before-restore\.db/);
    const check = new Database(dbFile, { readonly: true });
    expect(check.prepare("SELECT COUNT(*) FROM settings WHERE key = 'after_backup'").pluck().get()).toBe(0);
    check.close();
    expect(cli('restore', path.join(dir, 'nope.db')).code).toBe(2);
  }, 60_000);

  it('an older program refuses a database upgraded by a newer one', () => {
    const db = new Database(dbFile);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (99, 'from_the_future')").run();
    db.close();
    expect(cli('schema-version').out).toBe('99');
    const r = cli('reset-password', 'admin');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/upgraded by a newer version/);
  }, 60_000);
});
