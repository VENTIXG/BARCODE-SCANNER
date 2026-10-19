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
 *   restore <file> [--reset]  replace all data with a backup (.json.gz, or .db of versions up to 1.2);
 *                             --reset: also when a newer version has upgraded the database
 *   reset-password <user>     sets a new temporary password and prints it once
 *   offsite-status            cloud backup settings and last upload
 *   offsite-test              write, read and delete a test file in the cloud storage
 *   offsite-sync              upload the backups that are not in the cloud yet
 *   offsite-list              copies in the cloud storage
 *   offsite-download <name>   fetch a copy into the backups folder (decrypted)
 *
 * With the built-in database (no DATABASE_URL) the app must be stopped first: only one program
 * at a time can open it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { connect, migrate, openDatabase, schemaVersion, stampedName, type Database as Db } from './db/index.js';
import { readBackupFile, writeBackup } from './db/dump.js';
import { isSqliteFile } from './db/legacy/importSqlite.js';
import { latestSchemaVersion } from './db/migrations.js';
import { audit } from './lib/audit.js';
import { backupDir, loadBackupData, readBackupData } from './lib/backup.js';
import { HttpError } from './lib/errors.js';
import { downloadRemote, listRemote, offsiteStatus, syncOffsite, testOffsite } from './lib/offsite.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

class UsageError extends Error {}

/** The database as it is: no upgrade, no first admin (for commands that only read). */
async function existing(): Promise<Db> {
  const db = await connect();
  if ((await schemaVersion(db)) === 0) {
    await db.close();
    throw new UsageError('The database is empty: start the app once first');
  }
  return db;
}

async function using<T>(open: Promise<Db>, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await open;
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** Schema of a backup file: 100+ for .json.gz, 1-4 for .db of versions up to 1.2. */
async function schemaOfFile(file: string): Promise<number> {
  if (!fs.existsSync(file)) throw new UsageError(`No file ${file}`);
  if (isSqliteFile(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const has = db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").pluck().get();
      return has ? ((db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number | null) ?? 0) : 0;
    } finally {
      db.close();
    }
  }
  return (await readBackupFile(file)).schema;
}

/** A copy read inside one transaction: consistent even while the app is writing. */
async function backup(db: Db, label: string): Promise<string> {
  if (!/^[a-z0-9-]{1,48}$/.test(label)) throw new UsageError('The label may contain only a-z, 0-9 and -');
  const dir = await backupDir(db);
  fs.mkdirSync(dir, { recursive: true });
  const name = stampedName(label);
  await writeBackup(db, path.join(dir, name));
  return name;
}

async function restore(source: string, reset: boolean) {
  const file = path.resolve(source);
  if (!fs.existsSync(file)) throw new UsageError(`No file ${file}`);
  // Read and check the file before anything is touched.
  const data = await readBackupData(file);
  await using(connect(), async (db) => {
    const current = await schemaVersion(db);
    if (current > latestSchemaVersion) {
      if (!reset)
        throw new UsageError(
          `The database was upgraded by a newer version (schema ${current}; this version knows up to ${latestSchemaVersion}). ` +
            'Add --reset to replace it completely with the backup.',
        );
      // The newer program's data was saved by `ims` before it switched versions.
      await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      out('The database of the newer version was removed.');
    } else if (current > 0 && ((await db.value<number>('SELECT COUNT(*) FROM users')) ?? 0) > 0) {
      out(`Current data saved as ${await backup(db, 'before-restore')}`);
    }
    // Bring the database to this version's schema (an empty one is created), then load the backup.
    await migrate(db, undefined, null);
    await loadBackupData(db, data);
    await audit(db, null, {
      action: 'BACKUP.RESTORE',
      entityType: 'backup',
      description: `Backup ${path.basename(file)} was restored from the server console.`,
    });
  });
  for (const r of data.renamed) out(`Renamed a duplicate that differed only in letter case: ${r}`);
  out(`Restored ${path.basename(file)}`);
}

/** Easy to read out and type: no 0/O, 1/l/I. */
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

async function resetPassword(username: string) {
  await using(openDatabase({ quiet: true }), async (db) => {
    const user = await db.get<{ id: number; username: string; is_active: number }>(
      'SELECT id, username, is_active FROM users WHERE username = ?',
      username,
    );
    if (!user) {
      const admins = await db.column<string>("SELECT username FROM users WHERE role = 'ADMIN' ORDER BY id");
      throw new UsageError(`No user "${username}". Administrators: ${admins.join(', ') || 'none'}`);
    }
    const password = temporaryPassword();
    await db.run(
      `UPDATE users SET password_hash = ?, must_change_password = 1, is_active = 1, token_version = token_version + 1,
         updated_at = ims_now() WHERE id = ?`,
      await bcrypt.hash(password, 10),
      user.id,
    );
    await audit(db, null, {
      action: 'USER.PASSWORD_RESET',
      entityType: 'user',
      entityId: user.id,
      description: `The password of ${user.username} was reset from the server console.`,
    });
    out(`Temporary password for ${user.username}: ${password}`);
    out('It must be changed at the next sign-in. All sessions of this user were signed out.');
    if (!user.is_active) out('The account was disabled and has been enabled again.');
  });
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const arg = rest.find((a) => !a.startsWith('--'));
  switch (command) {
    case 'backup':
      out(await using(existing(), (db) => backup(db, arg ?? 'manual')));
      return;
    case 'schema-version':
      out(String(arg ? await schemaOfFile(path.resolve(arg)) : await using(connect(), schemaVersion)));
      return;
    case 'known-schema':
      out(String(latestSchemaVersion));
      return;
    case 'restore':
      if (!arg) throw new UsageError('Usage: restore <backup file> [--reset]');
      await restore(arg, flags.has('--reset'));
      return;
    case 'reset-password':
      if (!arg) throw new UsageError('Usage: reset-password <username>');
      await resetPassword(arg);
      return;
    case 'offsite-status':
      out(JSON.stringify(await using(existing(), (db) => offsiteStatus(db)), null, 2));
      return;
    case 'offsite-test': {
      const r = await testOffsite();
      out(`OK: ${r.host}, bucket ${r.bucket} (${r.ms} ms)`);
      return;
    }
    case 'offsite-sync': {
      const r = await using(existing(), (db) => syncOffsite(db));
      out(r.uploaded.length ? `Uploaded: ${r.uploaded.join(', ')}` : 'Nothing new to upload');
      return;
    }
    case 'offsite-list':
      for (const r of await listRemote()) out(`${r.name}\t${(r.size / 1024 / 1024).toFixed(1)} MB\t${r.createdAt}${r.encrypted ? '\tencrypted' : ''}`);
      return;
    case 'offsite-download':
      if (!arg) throw new UsageError('Usage: offsite-download <name>');
      // A new server restoring from the cloud has no data yet: the default folder is used then.
      out(await using(connect(), async (db) => downloadRemote(arg, (await schemaVersion(db)) ? db : null)));
      return;
    default:
      throw new UsageError(
        'Commands: backup [label] | schema-version [file] | known-schema | restore <file> [--reset] | reset-password <user> | ' +
          'offsite-status | offsite-test | offsite-sync | offsite-list | offsite-download <name>',
      );
  }
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(e instanceof UsageError || e instanceof HttpError ? 2 : 1);
});
