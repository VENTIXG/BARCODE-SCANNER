/**
 * Cloud copies of backups. The storage tests need an S3-compatible server:
 *
 *   docker run -d -p 9000:7070 versity/versitygw --access testkey --secret testsecret123456 posix /tmp
 *   curl -X PUT --aws-sigv4 aws:amz:us-east-1:s3 --user testkey:testsecret123456 http://127.0.0.1:9000/ims-backups
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9000 npm test
 *
 * Without S3_TEST_ENDPOINT only the parts that need no server run.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getDb } from '../src/db/index.js';
import { runBackup, validateBackupFile } from '../src/lib/backup.js';
import {
  decryptBackup,
  downloadRemote,
  encryptBackup,
  isEncryptedBackup,
  listRemote,
  offsiteSettings,
  syncOffsite,
} from '../src/lib/offsite.js';
import { S3Client, S3Error } from '../src/lib/s3.js';

const endpoint = process.env.S3_TEST_ENDPOINT;
const creds = {
  endpoint,
  region: process.env.S3_TEST_REGION ?? 'us-east-1',
  bucket: process.env.S3_TEST_BUCKET ?? 'ims-backups',
  accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? 'testkey',
  secretAccessKey: process.env.S3_TEST_SECRET ?? 'testsecret123456',
};
const prefix = `test-${Date.now().toString(36)}/`;
const second = () => new Promise((r) => setTimeout(r, 1100));

function useStorage(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    S3_ENDPOINT: creds.endpoint,
    S3_REGION: creds.region,
    S3_BUCKET: creds.bucket,
    S3_ACCESS_KEY_ID: creds.accessKeyId,
    S3_SECRET_ACCESS_KEY: creds.secretAccessKey,
    S3_PREFIX: prefix,
    S3_KEEP: '2',
    ...extra,
  });
}

afterAll(() => {
  for (const k of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PREFIX', 'S3_KEEP', 'BACKUP_PASSPHRASE'])
    delete process.env[k];
});

describe('backup encryption', () => {
  it('encrypts and decrypts; a wrong passphrase is refused', () => {
    const data = Buffer.from('SQLite format 3\0 some data');
    const enc = encryptBackup(data, 'correct horse');
    expect(isEncryptedBackup(enc)).toBe(true);
    expect(enc.includes(data)).toBe(false);
    expect(decryptBackup(enc, 'correct horse').equals(data)).toBe(true);
    expect(() => decryptBackup(enc, 'wrong')).toThrow(/passphrase/i);
    // Plain files pass through unchanged.
    expect(decryptBackup(data, 'any').equals(data)).toBe(true);
  });
});

describe('cloud backup settings', () => {
  it('is off unless bucket and keys are set; the folder always ends with /', () => {
    expect(offsiteSettings({})).toBeNull();
    expect(offsiteSettings({ S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' })).toBeNull();
    const s = offsiteSettings({ S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_PREFIX: '/shop' });
    expect(s?.prefix).toBe('shop/');
    expect(s?.keep).toBe(60);
    expect(s?.s3.region).toBe('us-east-1');
    expect(new S3Client(s!.s3).host).toBe('b.s3.us-east-1.amazonaws.com');
    expect(new S3Client({ ...s!.s3, endpoint: 'https://s3.eu-central-003.backblazeb2.com' }).host).toBe('s3.eu-central-003.backblazeb2.com');
  });
});

describe.skipIf(!endpoint)('S3-compatible storage', () => {
  const app = createApp();
  const admin = request.agent(app);

  beforeAll(async () => {
    getDb();
    expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
  });

  it('puts, lists, reads and deletes objects, also with spaces and Greek in the name', async () => {
    const c = new S3Client(creds);
    const key = `${prefix}φάκελος/αρχείο με κενά (1).txt`;
    await c.putObject(key, Buffer.from('γεια'), 'text/plain');
    expect((await c.getObject(key)).toString()).toBe('γεια');
    expect((await c.listObjects(`${prefix}φάκελος/`)).map((o) => o.key)).toEqual([key]);
    await c.deleteObject(key);
    expect(await c.listObjects(`${prefix}φάκελος/`)).toEqual([]);
  });

  it('a wrong secret key is refused with the reason', async () => {
    const c = new S3Client({ ...creds, secretAccessKey: 'wrong-secret' });
    const err = await c.listObjects(prefix).catch((e) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect(err.status).toBe(403);
  });

  it('uploads new backups and keeps only S3_KEEP copies in the bucket', async () => {
    useStorage();
    const first = await runBackup('manual');
    expect((await syncOffsite()).uploaded).toEqual([first.name]);
    expect((await syncOffsite()).uploaded).toEqual([]);
    await second();
    const b2 = await runBackup('manual');
    await second();
    const b3 = await runBackup('auto');
    expect((await syncOffsite()).uploaded).toEqual([b2.name, b3.name]);
    expect((await listRemote()).map((r) => r.name)).toEqual([b3.name, b2.name]);
    const status = (await admin.get('/api/backups')).body.data.offsite;
    expect(status).toMatchObject({ configured: true, bucket: creds.bucket, lastFile: b3.name, lastError: null });
  }, 30_000);

  it('API: connection test, list, and restore from the cloud', async () => {
    useStorage();
    expect((await admin.post('/api/backups/offsite/test')).status).toBe(200);
    const files = (await admin.get('/api/backups/offsite/files')).body.data as { name: string }[];
    expect(files.length).toBe(2);
    const count = () => getDb().prepare('SELECT COUNT(*) FROM products').pluck().get() as number;
    const before = count();
    expect((await admin.post('/api/products').send({ sku: 'AFTER-CLOUD', name: 'Made after the cloud copy' })).status).toBe(201);
    expect(count()).toBe(before + 1);
    // Remove the local copy: the restore must come from the bucket.
    const local = await downloadRemote(files[0].name);
    fs.rmSync(local);
    const res = await admin.post(`/api/backups/offsite/${files[0].name}/restore`);
    expect(res.status).toBe(200);
    expect(count()).toBe(before);
    // Restoring signs everyone out.
    expect((await admin.get('/api/auth/me')).status).toBe(401);
    expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
  }, 30_000);

  it('with BACKUP_PASSPHRASE the bucket holds only encrypted copies', async () => {
    useStorage({ S3_PREFIX: `${prefix}enc/`, BACKUP_PASSPHRASE: 'a long passphrase for tests' });
    await second();
    const b = await runBackup('manual');
    expect((await syncOffsite()).uploaded).toEqual([b.name]);
    const [remote] = await listRemote();
    expect(remote).toMatchObject({ name: b.name, encrypted: true });
    expect(remote.key.endsWith('.enc')).toBe(true);
    const raw = await new S3Client(creds).getObject(remote.key);
    expect(isEncryptedBackup(raw)).toBe(true);
    expect(raw.subarray(0, 16).toString()).not.toContain('SQLite');
    // Download decrypts into a valid database file.
    fs.rmSync(await downloadRemote(b.name));
    const file = await downloadRemote(b.name);
    expect(() => validateBackupFile(file)).not.toThrow();
    // Without the passphrase the copy cannot be used.
    delete process.env.BACKUP_PASSPHRASE;
    fs.rmSync(file);
    await expect(downloadRemote(b.name)).rejects.toThrow(/encrypted/);
  }, 30_000);
});
