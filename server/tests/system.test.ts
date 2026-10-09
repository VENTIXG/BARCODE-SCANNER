/** Update status shown in Settings and the "check now" request for the host's `ims` tool. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { appVersion } from '../src/config.js';
import { getDb } from '../src/db/index.js';

const app = createApp();
const admin = request.agent(app);
const manager = request.agent(app);

beforeAll(async () => {
  getDb();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
  await admin.post('/api/users').send({ username: 'mgr1', fullName: 'Manager One', role: 'MANAGER', password: 'manager-pass-1' });
  expect((await manager.post('/api/auth/login').send({ username: 'mgr1', password: 'manager-pass-1' })).status).toBe(200);
});

describe('update status', () => {
  it('a server not installed with install.sh is not managed and cannot be asked to update', async () => {
    delete process.env.IMS_STATE_DIR;
    delete process.env.IMS_REQUEST_DIR;
    const res = await admin.get('/api/system/update');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ managed: false, version: appVersion, requestPending: false });
    expect(res.body.data.disk.freeMb).toBeGreaterThan(0);
    expect((await admin.post('/api/system/update/check')).status).toBe(400);
  });

  it('shows what the server tool wrote and passes on a "check now" request', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-state-'));
    const requests = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-req-'));
    process.env.IMS_STATE_DIR = state;
    process.env.IMS_REQUEST_DIR = requests;
    fs.writeFileSync(
      path.join(state, 'update.json'),
      JSON.stringify({
        autoUpdate: true,
        updateTime: '03:30',
        state: 'idle',
        lastResult: 'rolled-back',
        message: 'Version 9.9.9 did not start; returned to 1.2.0.',
        latestVersion: '9.9.9',
        history: [{ at: '2026-10-09T01:30:00Z', from: '1.2.0', to: '9.9.9', result: 'rolled-back' }],
      }),
    );
    const res = await admin.get('/api/system/update');
    expect(res.body.data).toMatchObject({ managed: true, autoUpdate: true, updateTime: '03:30', lastResult: 'rolled-back', latestVersion: '9.9.9' });
    expect(res.body.data.history).toHaveLength(1);

    const check = await admin.post('/api/system/update/check');
    expect(check.status).toBe(202);
    expect(check.body.data.requestPending).toBe(true);
    expect(fs.readFileSync(path.join(requests, 'update-now'), 'utf8')).toContain('admin');
  });

  it('only administrators see or request updates', async () => {
    expect((await manager.get('/api/system/update')).status).toBe(403);
    expect((await manager.post('/api/system/update/check')).status).toBe(403);
  });
});
