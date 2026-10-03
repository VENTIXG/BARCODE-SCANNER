import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { getDb } from '../src/db/index.js';
import { backupDue } from '../src/lib/backup.js';

const app = createApp();
const admin = request.agent(app);

const productCount = () => getDb().prepare('SELECT COUNT(*) FROM products').pluck().get() as number;

beforeAll(async () => {
  getDb();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
});

describe('first run', () => {
  it('asks the initial admin to change the default password', async () => {
    const me = await admin.get('/api/auth/me');
    expect(me.body.data.mustChangePassword).toBe(true);
  });

  it('loads demo data into an empty database only once', async () => {
    const res = await admin.post('/api/settings/demo-data');
    expect(res.status).toBe(201);
    expect(res.body.data.products).toBeGreaterThan(50);
    expect((await admin.post('/api/settings/demo-data')).status).toBe(409);
    // The admin password was not overwritten by the demo users.
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ username: 'manager', password: 'manager123' })).status).toBe(200);
  }, 30_000);
});

describe('backups', () => {
  let backupName = '';

  it('creates a backup and lists it', async () => {
    expect(backupDue()).toBe(true);
    const res = await admin.post('/api/backups');
    expect(res.status).toBe(201);
    backupName = res.body.data.name;
    expect(backupName).toMatch(/^inventory_.*_manual\.db$/);
    expect(backupDue()).toBe(false);
    const list = await admin.get('/api/backups');
    expect(list.body.data.files.map((f: { name: string }) => f.name)).toContain(backupName);
    expect(fs.existsSync(path.join(config.dataDir, 'backups', backupName))).toBe(true);
  });

  it('restores a backup and signs everyone out', async () => {
    const before = productCount();
    await admin.post('/api/products').send({ sku: 'AFTER-BACKUP', name: 'Created after the backup' });
    expect(productCount()).toBe(before + 1);

    const res = await admin.post(`/api/backups/${backupName}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.data.safetyBackup).toMatch(/_before-restore\.db$/);
    expect(productCount()).toBe(before);
    // Old session is no longer valid after a restore.
    expect((await admin.get('/api/products')).status).toBe(401);
    expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
  });

  it('rejects files that are not backups', async () => {
    expect((await admin.post('/api/backups/../../etc/passwd/restore')).status).toBeGreaterThanOrEqual(400);
    const res = await admin.post('/api/backups/restore-upload').attach('file', Buffer.from('not a database'), 'evil.db');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BACKUP');
  });

  it('only lets administrators manage backups', async () => {
    const mgr = request.agent(app);
    await mgr.post('/api/auth/login').send({ username: 'manager', password: 'manager123' });
    expect((await mgr.get('/api/backups')).status).toBe(403);
  });
});
