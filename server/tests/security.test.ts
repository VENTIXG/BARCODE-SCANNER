/**
 * Security audit as tests: every API route needs a session, every role gets exactly its
 * permissions, sessions cannot be forged, hostile input is stored as text and never runs as
 * SQL or as a spreadsheet formula, uploads are checked by content, and temporary passwords
 * must be changed before the account can be used.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';
import { getDb, initDb } from '../src/db/index.js';

const app = createApp();
const admin = request.agent(app);
const manager = request.agent(app);
const worker = request.agent(app);
let productId = 0;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const binary = (r: request.Request) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

async function makeUser(agent: request.Agent, username: string, role: string) {
  const password = `${username}-pass-1`;
  const res = await admin.post('/api/users').send({ username, fullName: username, role, password, isActive: true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  // A password given by an administrator is temporary: changed at the first sign-in.
  expect((await agent.post('/api/auth/login').send({ username, password })).status).toBe(200);
  const changed = await agent.post('/api/auth/change-password').send({ currentPassword: password, newPassword: `${password}-own` });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  return res.body.data.id as number;
}

beforeAll(async () => {
  await initDb();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
  await makeUser(manager, 'sec_manager', 'MANAGER');
  await makeUser(worker, 'sec_worker', 'WAREHOUSE_USER');
  const p = await admin.post('/api/products').send({ sku: 'SEC-1', name: 'Security product', barcode: '0001234567895', purchasePrice: 1, initialQuantity: 5 });
  expect(p.status).toBe(201);
  productId = p.body.data.id;
});

describe('every route needs a session', () => {
  const routes: [string, string][] = [
    ['get', '/api/dashboard'], ['get', '/api/search?q=a'], ['get', '/api/products'], ['get', '/api/products/lookup?code=1'],
    ['get', '/api/products/1'], ['post', '/api/products'], ['put', '/api/products/1'], ['delete', '/api/products/1'],
    ['post', '/api/stock/scan'], ['post', '/api/stock/adjust'], ['post', '/api/stock/count'], ['get', '/api/receipts'],
    ['post', '/api/receipts'], ['get', '/api/dispatches'], ['post', '/api/dispatches'], ['get', '/api/invoices'],
    ['post', '/api/invoices/commit'], ['get', '/api/transactions'], ['post', '/api/transactions/1/reverse'],
    ['get', '/api/categories'], ['get', '/api/suppliers'], ['get', '/api/warehouses'], ['get', '/api/locations'],
    ['get', '/api/settings'], ['put', '/api/settings'], ['get', '/api/import/template'], ['post', '/api/import/products/commit'],
    ['get', '/api/export/products'], ['get', '/api/reports/valuation'], ['get', '/api/audit'], ['get', '/api/users'],
    ['post', '/api/users'], ['get', '/api/backups'], ['post', '/api/backups'], ['get', '/api/system/update'],
    ['get', '/api/events'], ['get', '/api/auth/me'], ['post', '/api/auth/change-password'], ['get', '/uploads/p_x.png'],
  ];
  it.each(routes)('%s %s → 401', async (method, url) => {
    const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
    expect(res.status).toBe(401);
  });

  it('a forged, foreign or expired session is refused', async () => {
    const forge = (token: string) => request(app).get('/api/auth/me').set('Cookie', `ims_session=${token}`);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":1,"tv":0}').toString('base64url')}.`;
    expect((await forge(none)).status).toBe(401);
    expect((await forge(jwt.sign({ sub: 1, tv: 0 }, 'another-secret'))).status).toBe(401);
    expect((await forge(jwt.sign({ sub: 1, tv: 0, exp: Math.floor(Date.now() / 1000) - 10 }, 'test-secret'))).status).toBe(401);
    expect((await forge('garbage')).status).toBe(401);
  });

  it('the session cookie is HttpOnly and SameSite=Strict; security headers are set', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });
});

describe('each role gets exactly its permissions', () => {
  const body = { sku: 'X', name: 'X' };
  const forbiddenForWorker: [string, string, unknown?][] = [
    ['post', '/api/products', body], ['put', '/api/products/1', body], ['delete', '/api/products/1'],
    ['post', '/api/stock/adjust', {}], ['post', '/api/stock/count', {}], ['get', '/api/transactions'],
    ['post', '/api/categories', { name: 'x' }], ['post', '/api/suppliers', { name: 'x' }], ['post', '/api/locations', { code: 'A-1' }],
    ['get', '/api/import/template'], ['post', '/api/import/products/validate', { rows: [] }], ['get', '/api/export/products'],
    ['get', '/api/reports/valuation'], ['get', '/api/audit'], ['get', '/api/users'], ['get', '/api/backups'],
    ['get', '/api/system/update'], ['get', '/api/settings'], ['put', '/api/settings', {}], ['post', '/api/receipts/1/cancel', {}],
  ];
  it.each(forbiddenForWorker)('warehouse user: %s %s → 403', async (method, url, payload) => {
    const r = (worker as unknown as Record<string, (u: string) => request.Test>)[method](url);
    expect((await (payload === undefined ? r : r.send(payload as object))).status).toBe(403);
  });

  const forbiddenForManager: [string, string, unknown?][] = [
    ['delete', '/api/products/1'], ['get', '/api/users'], ['post', '/api/users', {}], ['get', '/api/backups'],
    ['post', '/api/backups', {}], ['get', '/api/system/update'], ['get', '/api/settings'], ['put', '/api/settings', {}],
    ['put', '/api/warehouses/1', {}], ['post', '/api/settings/demo-data', {}],
  ];
  it.each(forbiddenForManager)('manager: %s %s → 403', async (method, url, payload) => {
    const r = (manager as unknown as Record<string, (u: string) => request.Test>)[method](url);
    expect((await (payload === undefined ? r : r.send(payload as object))).status).toBe(403);
  });

  it('a warehouse user can do the daily work', async () => {
    expect((await worker.get('/api/products')).status).toBe(200);
    expect((await worker.post('/api/stock/scan').send({ code: 'SEC-1', mode: 'IN', quantity: 1 })).status).toBe(201);
    expect((await worker.get('/api/dashboard')).status).toBe(200);
    expect((await worker.get('/api/receipts')).status).toBe(200);
  });

  it('a warehouse user cannot undo someone else’s movement', async () => {
    const scan = await manager.post('/api/stock/scan').send({ code: 'SEC-1', mode: 'IN', quantity: 1 });
    expect((await worker.post(`/api/transactions/${scan.body.data.transaction.id}/reverse`).send({})).status).toBe(403);
  });

  it('password hashes are never returned', async () => {
    const users = await admin.get('/api/users');
    expect(JSON.stringify(users.body)).not.toMatch(/password|\$2[aby]\$/);
    const me = await worker.get('/api/auth/me');
    expect(JSON.stringify(me.body)).not.toMatch(/\$2[aby]\$/);
    const audit = await admin.get('/api/audit').query({ pageSize: 500 });
    expect(JSON.stringify(audit.body)).not.toMatch(/\$2[aby]\$/);
  });
});

describe('temporary passwords', () => {
  it('a user with a temporary password must change it before using the system', async () => {
    const res = await admin.post('/api/users').send({ username: 'sec_temp', fullName: 'Temp', role: 'MANAGER', password: 'temporary-1', isActive: true });
    expect(res.status).toBe(201);
    const temp = request.agent(app);
    const login = await temp.post('/api/auth/login').send({ username: 'sec_temp', password: 'temporary-1' });
    expect(login.status).toBe(200);
    expect(login.body.data.mustChangePassword).toBe(true);
    // Signed in, but only the password change is allowed.
    expect((await temp.get('/api/auth/me')).status).toBe(200);
    const blocked = await temp.get('/api/products');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await temp.post('/api/stock/scan').send({ code: 'SEC-1', mode: 'IN' })).status).toBe(403);
    expect((await temp.post('/api/auth/change-password').send({ currentPassword: 'temporary-1', newPassword: 'my-own-password-1' })).status).toBe(200);
    expect((await temp.get('/api/products')).status).toBe(200);
  });

  it('usernames that differ only in letter case are refused', async () => {
    const res = await admin.post('/api/users').send({ username: 'ADMIN', fullName: 'Impostor', role: 'WAREHOUSE_USER', password: 'impostor-pass-1', isActive: true });
    expect(res.status).toBe(409);
  });
});

describe('hostile input is data, never code', () => {
  const injections = ["' OR 1=1 --", "%' UNION SELECT password_hash FROM users --", "'; DROP TABLE products; --", '\\', '%', '_', '"'];

  it('a NUL character is refused with 400, in a query or a body, never a server error', async () => {
    expect((await admin.get('/api/products').query({ q: 'a\u0000b' })).status).toBe(400);
    const res = await admin.post('/api/products').send({ sku: 'NUL\u0000', name: 'n' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_VALUE');
    expect((await admin.post('/api/stock/scan').send({ code: 'x\u0000', mode: 'IN' })).status).toBe(400);
  });

  it('numbers beyond what the database holds are refused with 400', async () => {
    expect((await admin.post('/api/stock/scan').send({ productId: 99999999999, mode: 'IN' })).status).toBe(400);
    expect((await admin.post('/api/receipts').send({ date: '2026-01-01', items: [{ productId: 3000000000, quantity: 1 }] })).status).toBe(400);
    expect((await admin.get('/api/products').query({ categoryId: '99999999999' })).status).toBeLessThan(500);
  });

  it.each(injections)('search, filters and sorting with %j', async (payload) => {
    for (const query of [{ q: payload }, { sort: payload }, { dir: payload }, { categoryId: payload }, { stock: payload }, { zone: payload }]) {
      const res = await admin.get('/api/products').query(query);
      expect(res.status, JSON.stringify(query)).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
    }
    for (const url of ['/api/search', '/api/transactions', '/api/audit', '/api/receipts', '/api/dispatches']) {
      const res = await admin.get(url).query({ q: payload });
      expect(res.status, url).toBe(200);
    }
    expect((await admin.get('/api/products/lookup').query({ code: payload })).status).toBe(200);
    expect(await getDb().value('SELECT COUNT(*) FROM products')).toBeGreaterThan(0);
  });

  it('script and formula text in a product is stored and returned exactly, and exported as text', async () => {
    const name = '<img src=x onerror=alert(1)> =HYPERLINK("http://evil","x")';
    const res = await admin.post('/api/products').send({ sku: '=1+1', barcode: '+SUM(1,2)', name, description: '@cmd|/c calc', purchasePrice: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const back = (await admin.get(`/api/products/${res.body.data.id}`)).body.data;
    expect([back.sku, back.barcode, back.name, back.description]).toEqual(['=1+1', '+SUM(1,2)', name, '@cmd|/c calc']);
    for (const url of ['/api/export/products', '/api/export/products-full', '/api/export/inventory']) {
      const file = await binary(admin.get(url).query({ q: '=1+1' }));
      expect(file.status, url).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.body);
      const cells: ExcelJS.Cell[] = [];
      wb.worksheets[0].eachRow((row) => row.eachCell((c) => cells.push(c)));
      expect(cells.some((c) => c.value === '=1+1'), url).toBe(true);
      // Never a formula: every cell holds a plain value.
      expect(cells.filter((c) => c.type === ExcelJS.ValueType.Formula || c.formula), url).toEqual([]);
    }
  });

  it('malformed or oversized requests are refused cleanly', async () => {
    const bad = await admin.post('/api/products').set('Content-Type', 'application/json').send('{"sku": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_JSON');
    const big = await admin.post('/api/import/products/validate').set('Content-Type', 'application/json').send(`{"rows":"${'x'.repeat(31 * 1024 * 1024)}"}`);
    expect(big.status).toBe(413);
    for (const id of ['abc', '-1', '0', '1.5', '99999999999999999999']) expect((await admin.get(`/api/products/${id}`)).status, id).toBe(400);
    expect((await admin.get('/api/products/999999')).status).toBe(404);
    expect((await admin.post('/api/products').send({ sku: 'NEG', name: 'n', purchasePrice: -1 })).status).toBe(400);
    expect((await admin.post('/api/products').send({ sku: 'A\tB', name: 'tab' })).status).toBe(400);
    expect((await admin.post('/api/stock/scan').send({ code: 'SEC-1', mode: 'IN', quantity: 0 })).status).toBe(400);
    expect((await admin.post('/api/stock/scan').send({ code: 'SEC-1', mode: 'SIDEWAYS' })).status).toBe(400);
  });

  it('backup file names cannot leave the backup folder', async () => {
    for (const name of ['..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd', '..%5C..%5Cwindows', 'x.json.gz%00.txt']) {
      expect((await admin.get(`/api/backups/${name}/download`)).status, name).toBeGreaterThanOrEqual(400);
      expect((await admin.post(`/api/backups/${name}/restore`)).status, name).toBeGreaterThanOrEqual(400);
    }
  });

  it('a file that is not a backup changes nothing', async () => {
    const before = await getDb().value('SELECT COUNT(*) FROM products');
    const res = await admin.post('/api/backups/restore-upload').attach('file', Buffer.from('not a backup'), 'evil.json.gz');
    expect(res.status).toBe(400);
    expect(await getDb().value('SELECT COUNT(*) FROM products')).toBe(before);
  });
});

describe('uploads are checked by their content', () => {
  it('a real image is accepted and served only to signed-in users, with nosniff', async () => {
    const res = await admin.post(`/api/products/${productId}/image`).attach('image', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const url = res.body.data.imageUrl as string;
    expect((await request(app).get(url)).status).toBe(401);
    const img = await admin.get(url);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
  });

  it('HTML or a script disguised as an image is refused', async () => {
    for (const [content, type] of [
      [Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'],
      [Buffer.from('<svg onload=alert(1)>'), 'image/jpeg'],
      [Buffer.from('<script>alert(1)</script>'), 'text/html'],
    ] as const) {
      const res = await admin.post(`/api/products/${productId}/image`).attach('image', content, { filename: 'x.png', contentType: type });
      expect(res.status, type).toBe(400);
    }
  });
});

describe('sign-in protection', () => {
  it('repeated wrong passwords are rate limited', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await request(app).post('/api/auth/login').send({ username: 'admin', password: `wrong-${i}` })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
