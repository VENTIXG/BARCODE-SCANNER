/**
 * Maintenance commands for servers. The `ims` tool (deploy/server/ims) runs them inside the
 * app container; admins can run them too:  docker compose exec app node server/dist/cli.js <command>
 *
 * Keep the command names and their output stable: during an update or a rollback the `ims`
 * tool of one version calls the program of another.
 *
 *   backup [label]            consistent copy into the backups folder; prints the file name
 *   schema-version [file]     newest schema version of the database (or of a backup file)
 *   known-schema              newest schema version this program knows
 *   restore <file>            replace the database with a backup (stop the app first)
 *   reset-password <user>     sets a new temporary password and prints it once
 *   offsite-status            cloud backup settings and last upload
 *   offsite-test              write, read and delete a test file in the cloud storage
 *   offsite-sync              upload the backups that are not in the cloud yet
 *   offsite-list              copies in the cloud storage
 *   offsite-download <name>   fetch a copy into the backups folder (decrypted)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { latestSchemaVersion } from './db/migrations.js';
import { audit } from './lib/audit.js';
import { backupDir, stampedName, validateBackupFile } from './lib/backup.js';
import { downloadRemote, listRemote, offsiteStatus, syncOffsite, testOffsite } from './lib/offsite.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

class UsageError extends Error {}

function readOnly(file = config.dbFile) {
  if (!fs.existsSync(file)) throw new UsageError(`No database at ${file}`);
  return new Database(file, { readonly: true, fileMustExist: true });
}

function schemaVersionOf(file: string): number {
  const db = readOnly(file);
  try {
    const has = db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").pluck().get();
    return has ? ((db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number | null) ?? 0) : 0;
  } finally {
    db.close();
  }
}

/** A copy made through SQLite's backup API: consistent even while the app is writing. */
async function backup(label: string): Promise<string> {
  if (!/^[a-z0-9-]{1,48}$/.test(label)) throw new UsageError('The label may contain only a-z, 0-9 and -');
  const db = readOnly();
  try {
    const dir = backupDir(db);
    fs.mkdirSync(dir, { recursive: true });
    const name = stampedName(label);
    await db.backup(path.join(dir, name));
    return name;
  } finally {
    db.close();
  }
}

async function restore(source: string) {
  const file = path.resolve(source);
  if (!fs.existsSync(file)) throw new UsageError(`No file ${file}`);
  validateBackupFile(file);
  if (fs.existsSync(config.dbFile)) out(`Current data saved as ${await backup('before-restore')}`);
  const tmp = `${config.dbFile}.restoring`;
  fs.copyFileSync(file, tmp);
  for (const f of [`${config.dbFile}-wal`, `${config.dbFile}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(tmp, config.dbFile);
  // Opening upgrades a backup from an older version; then everyone signs in again.
  const db = openDatabase(config.dbFile, { quiet: true });
  db.prepare('UPDATE users SET token_version = token_version + 1').run();
  audit(db, null, { action: 'BACKUP.RESTORE', entityType: 'backup', description: `Backup ${path.basename(file)} was restored from the server console.` });
  db.close();
  out(`Restored ${path.basename(file)}`);
}

/** Easy to read out and type: no 0/O, 1/l/I. */
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

function resetPassword(username: string) {
  const db = openDatabase(config.dbFile, { quiet: true });
  try {
    const user = db.prepare('SELECT id, username, is_active FROM users WHERE username = ?').get(username) as
      | { id: number; username: string; is_active: number }
      | undefined;
    if (!user) {
      const admins = db.prepare("SELECT username FROM users WHERE role = 'ADMIN' ORDER BY id").pluck().all() as string[];
      throw new UsageError(`No user "${username}". Administrators: ${admins.join(', ') || 'none'}`);
    }
    const password = temporaryPassword();
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 1, is_active = 1, token_version = token_version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(bcrypt.hashSync(password, 10), user.id);
    audit(db, null, {
      action: 'USER.PASSWORD_RESET',
      entityType: 'user',
      entityId: user.id,
      description: `The password of ${user.username} was reset from the server console.`,
    });
    out(`Temporary password for ${user.username}: ${password}`);
    out('It must be changed at the next sign-in. All sessions of this user were signed out.');
    if (!user.is_active) out('The account was disabled and has been enabled again.');
  } finally {
    db.close();
  }
}

async function main(argv: string[]) {
  const [command, arg] = argv;
  switch (command) {
    case 'backup':
      out(await backup(arg ?? 'manual'));
      return;
    case 'schema-version':
      out(String(schemaVersionOf(arg ? path.resolve(arg) : config.dbFile)));
      return;
    case 'known-schema':
      out(String(latestSchemaVersion));
      return;
    case 'restore':
      if (!arg) throw new UsageError('Usage: restore <backup file>');
      await restore(arg);
      return;
    case 'reset-password':
      if (!arg) throw new UsageError('Usage: reset-password <username>');
      resetPassword(arg);
      return;
    case 'offsite-status': {
      const db = readOnly();
      try {
        out(JSON.stringify(offsiteStatus(db), null, 2));
      } finally {
        db.close();
      }
      return;
    }
    case 'offsite-test': {
      const r = await testOffsite();
      out(`OK: ${r.host}, bucket ${r.bucket} (${r.ms} ms)`);
      return;
    }
    case 'offsite-sync': {
      const db = openDatabase(config.dbFile, { quiet: true });
      try {
        const r = await syncOffsite(db);
        out(r.uploaded.length ? `Uploaded: ${r.uploaded.join(', ')}` : 'Nothing new to upload');
      } finally {
        db.close();
      }
      return;
    }
    case 'offsite-list':
      for (const r of await listRemote()) out(`${r.name}\t${(r.size / 1024 / 1024).toFixed(1)} MB\t${r.createdAt}${r.encrypted ? '\tencrypted' : ''}`);
      return;
    case 'offsite-download': {
      if (!arg) throw new UsageError('Usage: offsite-download <name>');
      const db = readOnly();
      try {
        out(await downloadRemote(arg, db));
      } finally {
        db.close();
      }
      return;
    }
    default:
      throw new UsageError(
        'Commands: backup [label] | schema-version [file] | known-schema | restore <file> | reset-password <user> | ' +
          'offsite-status | offsite-test | offsite-sync | offsite-list | offsite-download <name>',
      );
  }
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(e instanceof UsageError ? 2 : 1);
});
