/**
 * Off-site copies of the database backups, in S3-compatible cloud storage.
 *
 * Every local backup (daily, manual, before updates) is uploaded soon after it is made;
 * uploads that fail are retried every 30 minutes. The bucket keeps the newest S3_KEEP copies.
 * If the server is lost, a new server can restore from the bucket (Settings or `ims`).
 *
 * Configured only through environment variables, so keys never end up in the database
 * or in its backups:
 *   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY   required
 *   S3_ENDPOINT        provider URL; empty means AWS S3
 *   S3_REGION          default us-east-1 (Cloudflare R2: auto)
 *   S3_PREFIX          folder inside the bucket, default warehouse-ims/
 *   S3_KEEP            copies to keep in the bucket, default 60
 *   BACKUP_PASSPHRASE  optional: encrypt copies (AES-256-GCM) before they leave the server
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, nowIso, type DB } from '../db/index.js';
import { BACKUP_FILE_RE, backupDir, listBackups, onBackup } from './backup.js';
import { badRequest } from './errors.js';
import { S3Client, type S3Config } from './s3.js';

export interface OffsiteSettings {
  s3: S3Config;
  prefix: string;
  keep: number;
  passphrase: string | null;
}

export function offsiteSettings(env: NodeJS.ProcessEnv = process.env): OffsiteSettings | null {
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  let prefix = (env.S3_PREFIX ?? 'warehouse-ims/').trim().replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return {
    s3: {
      endpoint: env.S3_ENDPOINT?.trim() || undefined,
      region: env.S3_REGION?.trim() || 'us-east-1',
      bucket,
      accessKeyId,
      secretAccessKey,
      pathStyle: env.S3_PATH_STYLE ? env.S3_PATH_STYLE === 'true' : undefined,
    },
    prefix,
    keep: Math.max(1, Number(env.S3_KEEP) || 60),
    passphrase: env.BACKUP_PASSPHRASE?.length ? env.BACKUP_PASSPHRASE : null,
  };
}

// ---- Encryption ---------------------------------------------------------------------------

const MAGIC = Buffer.from('IMSENC01');

const deriveKey = (passphrase: string, salt: Buffer) =>
  crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

/** MAGIC | salt (16) | iv (12) | tag (16) | ciphertext */
export function encryptBackup(data: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export const isEncryptedBackup = (data: Buffer) => data.length > MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);

export function decryptBackup(data: Buffer, passphrase: string): Buffer {
  if (!isEncryptedBackup(data)) return data;
  const salt = data.subarray(8, 24);
  const iv = data.subarray(24, 36);
  const tag = data.subarray(36, 52);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(52)), decipher.final()]);
  } catch {
    throw badRequest('Wrong BACKUP_PASSPHRASE: this copy cannot be decrypted', 'OFFSITE_PASSPHRASE');
  }
}

// ---- Status (kept in settings; no secrets) --------------------------------------------------

function putSetting(db: DB, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

const readSetting = (db: DB, key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) || null;

export interface OffsiteStatus {
  configured: boolean;
  host: string | null;
  bucket: string | null;
  prefix: string | null;
  encrypted: boolean;
  keep: number | null;
  lastUploadAt: string | null;
  lastFile: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export function offsiteStatus(db: DB = getDb()): OffsiteStatus {
  const s = offsiteSettings();
  return {
    configured: Boolean(s),
    host: s ? new S3Client(s.s3).host : null,
    bucket: s?.s3.bucket ?? null,
    prefix: s?.prefix ?? null,
    encrypted: Boolean(s?.passphrase),
    keep: s?.keep ?? null,
    lastUploadAt: readSetting(db, 'offsite_last_upload_at'),
    lastFile: readSetting(db, 'offsite_last_file'),
    lastError: s ? readSetting(db, 'offsite_last_error') : null,
    lastErrorAt: s ? readSetting(db, 'offsite_last_error_at') : null,
  };
}

// ---- Remote copies ----------------------------------------------------------------------------

export interface RemoteBackup {
  /** Name of the backup (the same as the local file name). */
  name: string;
  key: string;
  size: number;
  createdAt: string;
  encrypted: boolean;
}

function requireSettings(): OffsiteSettings {
  const s = offsiteSettings();
  if (!s) throw badRequest('Cloud backup is not configured on this server', 'OFFSITE_NOT_CONFIGURED');
  return s;
}

export async function listRemote(s: OffsiteSettings = requireSettings()): Promise<RemoteBackup[]> {
  const objects = await new S3Client(s.s3).listObjects(s.prefix);
  return objects
    .map((o) => {
      const rest = o.key.slice(s.prefix.length);
      const encrypted = rest.endsWith('.enc');
      const name = encrypted ? rest.slice(0, -4) : rest;
      return { name, key: o.key, size: o.size, createdAt: o.lastModified, encrypted };
    })
    .filter((r) => BACKUP_FILE_RE.test(r.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function upload(s: OffsiteSettings, file: string, name: string) {
  const data = fs.readFileSync(file);
  const body = s.passphrase ? encryptBackup(data, s.passphrase) : data;
  const key = `${s.prefix}${name}${s.passphrase ? '.enc' : ''}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await new S3Client(s.s3).putObject(key, body);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

let syncing: Promise<{ uploaded: string[] }> | null = null;

/**
 * Upload every local backup newer than the newest copy in the bucket (only the newest one
 * the first time), then delete the oldest copies beyond S3_KEEP.
 */
export function syncOffsite(db: DB = getDb()): Promise<{ uploaded: string[] }> {
  if (syncing) return syncing;
  syncing = (async () => {
    const s = offsiteSettings();
    if (!s) return { uploaded: [] };
    const uploaded: string[] = [];
    try {
      const remote = await listRemote(s);
      const newestRemote = remote[0]?.name ?? '';
      const local = listBackups(db);
      const pending = (newestRemote ? local.filter((f) => f.name > newestRemote) : local.slice(0, 1)).reverse();
      for (const f of pending) {
        await upload(s, path.join(backupDir(db), f.name), f.name);
        uploaded.push(f.name);
        putSetting(db, 'offsite_last_upload_at', nowIso());
        putSetting(db, 'offsite_last_file', f.name);
      }
      if (uploaded.length || remote.length > s.keep) {
        const client = new S3Client(s.s3);
        for (const old of (await listRemote(s)).slice(s.keep)) await client.deleteObject(old.key);
      }
      putSetting(db, 'offsite_last_error', '');
      return { uploaded };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      putSetting(db, 'offsite_last_error', message.slice(0, 500));
      putSetting(db, 'offsite_last_error_at', nowIso());
      throw e;
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

const syncQuietly = () => {
  syncOffsite().then(
    (r) => r.uploaded.length && console.log(`[offsite] uploaded ${r.uploaded.join(', ')}`),
    (e) => console.error('[offsite] upload failed:', e?.message ?? e),
  );
};

let timer: NodeJS.Timeout | null = null;

/** Upload after every backup; retry every 30 minutes. */
export function startOffsiteSync() {
  if (timer || !offsiteSettings()) return;
  onBackup(() => syncQuietly());
  setTimeout(syncQuietly, 90_000).unref();
  timer = setInterval(syncQuietly, 30 * 60_000);
  timer.unref();
}

export function stopOffsiteSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Fetch a copy from the bucket into the backups folder (decrypted) and return its path.
 * An identical local file is reused.
 */
export async function downloadRemote(name: string, db: DB = getDb()): Promise<string> {
  if (!BACKUP_FILE_RE.test(name)) throw badRequest('Invalid backup file name');
  const s = requireSettings();
  const found = (await listRemote(s)).find((r) => r.name === name);
  if (!found) throw badRequest('This copy is not in the cloud storage', 'OFFSITE_NOT_FOUND');
  let data = await new S3Client(s.s3).getObject(found.key);
  if (isEncryptedBackup(data)) {
    if (!s.passphrase) throw badRequest('This copy is encrypted: set BACKUP_PASSPHRASE on the server first', 'OFFSITE_PASSPHRASE');
    data = decryptBackup(data, s.passphrase);
  }
  const dir = backupDir(db);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file) || fs.statSync(file).size !== data.length) {
    fs.writeFileSync(`${file}.part`, data);
    fs.renameSync(`${file}.part`, file);
  }
  return file;
}

/** Write, read back and delete a small file: proves the keys, bucket and permissions work. */
export async function testOffsite(): Promise<{ ms: number; host: string; bucket: string }> {
  const s = requireSettings();
  const client = new S3Client(s.s3);
  const started = Date.now();
  const key = `${s.prefix}.connection-test-${crypto.randomBytes(4).toString('hex')}`;
  const probe = Buffer.from(`Warehouse IMS connection test ${nowIso()}`);
  await client.putObject(key, probe, 'text/plain');
  const back = await client.getObject(key);
  await client.deleteObject(key);
  if (!back.equals(probe)) throw new Error('The file read back from the bucket is different');
  await client.listObjects(s.prefix);
  return { ms: Date.now() - started, host: client.host, bucket: s.s3.bucket };
}
