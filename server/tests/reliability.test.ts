import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { connect, getDb, initDb, migrate } from '../src/db/index.js';
import { readBackupFile } from '../src/db/dump.js';
import { latestSchemaVersion, migrations } from '../src/db/migrations.js';

let base = '';
let server: http.Server;
let cookie = '';
let worker = '';

async function login(username: string, password: string) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

const api = (method: string, url: string, body?: unknown, who = cookie) =>
  fetch(`${base}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  await initDb();
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = await login('admin', 'admin123');
  const u = await api('POST', '/users', { username: 'rel_worker', fullName: 'Reliability Worker', role: 'WAREHOUSE_USER', password: 'worker-temp-1' });
  expect(u.status).toBe(201);
  // The password from the administrator is temporary: the worker chooses their own first.
  const first = await login('rel_worker', 'worker-temp-1');
  expect((await api('POST', '/auth/change-password', { currentPassword: 'worker-temp-1', newPassword: 'worker-pass-1' }, first)).status).toBe(200);
  worker = await login('rel_worker', 'worker-pass-1');
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function product(sku: string, qty: number) {
  const res = await api('POST', '/products', { sku, name: `Product ${sku}`, initialQuantity: qty });
  expect(res.status).toBe(201);
  return (await res.json()).data as { id: number };
}
const qtyOf = async (id: number) => ((await (await api('GET', `/products/${id}`)).json()).data.quantity as number);

describe('idempotent writes', () => {
  it('posts a scan once when the same key is sent twice (retry / double submit)', async () => {
    const p = await product('IDEM-1', 50);
    const body = { productId: p.id, mode: 'OUT', quantity: 7, idempotencyKey: 'scan-key-0001' };
    const first = await api('POST', '/stock/scan', body, worker);
    const second = await api('POST', '/stock/scan', body, worker);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await second.json()).data.product.quantity).toBe(43);
    expect(await qtyOf(p.id)).toBe(43);
  });

  it('refuses a key that belongs to another user or another action', async () => {
    const p = await product('IDEM-2', 20);
    const body = { productId: p.id, mode: 'IN', quantity: 1, idempotencyKey: 'shared-key-0002' };
    expect((await api('POST', '/stock/scan', body, worker)).status).toBe(201);
    const other = await api('POST', '/stock/scan', body, cookie); // admin re-uses the key
    expect(other.status).toBe(409);
    expect((await other.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await qtyOf(p.id)).toBe(21);
  });

  it('stores nothing for a failed request, so a corrected retry still works', async () => {
    const p = await product('IDEM-3', 3);
    const key = 'retry-key-0003';
    const tooMuch = await api('POST', '/stock/scan', { productId: p.id, mode: 'OUT', quantity: 10, idempotencyKey: key }, worker);
    expect(tooMuch.status).toBe(409);
    const ok = await api('POST', '/stock/scan', { productId: p.id, mode: 'OUT', quantity: 2, idempotencyKey: key }, worker);
    expect(ok.status).toBe(201);
    expect(await qtyOf(p.id)).toBe(1);
  });

  it('posts a receipt once for a repeated key', async () => {
    const p = await product('IDEM-4', 0);
    const body = { date: '2026-10-09', idempotencyKey: 'receipt-key-0004', items: [{ productId: p.id, quantity: 5 }] };
    const a = await api('POST', '/receipts', body, worker);
    const b = await api('POST', '/receipts', body, worker);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await b.json()).data.id).toBe((await a.json()).data.id);
    expect(await qtyOf(p.id)).toBe(5);
  });
});

describe('concurrency', () => {
  it('20 simultaneous stock OUT requests of 10 on stock 100: exactly 10 succeed, stock ends at 0', async () => {
    const p = await product('CONC-1', 100);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => api('POST', '/stock/scan', { productId: p.id, mode: 'OUT', quantity: 10 }, worker)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 409)).toHaveLength(10);
    expect(await qtyOf(p.id)).toBe(0);
  });

  it('simultaneous IN and OUT from two users keep every movement (no lost update)', async () => {
    const p = await product('CONC-2', 100);
    const ops = Array.from({ length: 15 }, (_, i) =>
      api('POST', '/stock/scan', { productId: p.id, mode: i % 2 ? 'IN' : 'OUT', quantity: 3 }, i % 3 ? worker : cookie),
    );
    await Promise.all(ops);
    const ins = 7;
    const outs = 8;
    expect(await qtyOf(p.id)).toBe(100 + ins * 3 - outs * 3);
    const history = await (await api('GET', `/products/${p.id}/transactions?pageSize=100`)).json();
    expect(history.total).toBe(15 + 1);
  });
});

describe('backups and writers', () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)('a backup reads one moment and does not hold up writes (PostgreSQL server)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let seen = -1;
    const reading = getDb().snapshot(async (t) => {
      await t.value('SELECT COUNT(*) FROM products');
      await gate;
      seen = (await t.value<number>("SELECT COUNT(*) FROM products WHERE sku = 'SNAP-1'"))!;
    });
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await product('SNAP-1', 1); // a write while the backup is reading
    expect(Date.now() - started).toBeLessThan(2000);
    release();
    await reading;
    expect(seen).toBe(0);
  });
});

describe('real-time events', () => {
  it('pushes a change event to a listening browser when another user writes', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const received = new Promise<string>(async (resolve) => {
      while (!text.includes('event: change')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      resolve(text);
    });
    await new Promise((r) => setTimeout(r, 100));
    await product('EVT-1', 1); // written by another request
    const got = await Promise.race([received, new Promise<string>((r) => setTimeout(() => r('timeout'), 3000))]);
    controller.abort();
    expect(got).toContain('"scope":"products"');
  });

  it('rejects the event stream without a session', async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
  });
});

describe('migrations never lose data', () => {
  it('1.3 to 1.4 (schema 101): data kept, selling prices kept, SKUs that differ only in spacing tolerated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig101-'));
    const db = await connect({ url: 'memory://' });
    try {
      await migrate(db, migrations.filter((m) => m.version === 100), dir);
      await db.exec(`INSERT INTO warehouses (code, name, is_default) VALUES ('MAIN', 'Main', 1);
        INSERT INTO products (sku, name, purchase_price, selling_price) VALUES ('A B', 'One', 1, 2), ('A  B', 'Two', 3, 0);
        INSERT INTO stock_receipts (receipt_number, warehouse_id, receipt_date, invoice_number) VALUES ('RCV-1', 1, '2026-10-01', 'INV 1');`);
      await migrate(db, migrations, dir);
      expect(fs.readdirSync(dir).filter((f) => f.includes('before-migrate-v101'))).toHaveLength(1);
      expect(await db.all('SELECT sku::text AS sku, purchase_price, selling_price FROM products ORDER BY id')).toEqual([
        { sku: 'A B', purchase_price: 1, selling_price: 2 },
        { sku: 'A  B', purchase_price: 3, selling_price: 0 },
      ]);
      // Existing duplicates by spacing: the index is created without UNIQUE; the application refuses new ones.
      expect(await db.value("SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_products_sku_key'")).not.toMatch(/UNIQUE/);
      await db.run("INSERT INTO products (sku, name) VALUES ('C', 'No selling price')");
      expect(await db.value("SELECT selling_price FROM products WHERE sku = 'C'")).toBeNull();
      expect(await db.value("SELECT COUNT(*) FROM stock_receipts WHERE ims_compact(invoice_number) = ims_compact('inv1')")).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('a failing migration rolls back and leaves a copy from before the upgrade', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const db = await connect({ url: 'memory://' });
    try {
      await migrate(db, migrations, dir); // fresh database: no copy needed
      expect(fs.readdirSync(dir)).toEqual([]);
      await db.run("INSERT INTO settings (key, value) VALUES ('probe', 'keep-me')");
      const bad = [...migrations, { version: 999, name: 'broken', sql: 'CREATE TABLE should_not_exist (a INTEGER); INSERT INTO missing_table VALUES (1);' }];
      await expect(migrate(db, bad, dir)).rejects.toThrow();
      const copies = fs.readdirSync(dir).filter((f) => f.includes('before-migrate-v999'));
      expect(copies).toHaveLength(1);
      expect(await db.value("SELECT value FROM settings WHERE key = 'probe'")).toBe('keep-me');
      expect(await db.value("SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'should_not_exist'")).toBe(0);
      expect(await db.value('SELECT MAX(version) FROM schema_migrations')).toBe(latestSchemaVersion);
      const copy = await readBackupFile(path.join(dir, copies[0]));
      expect(copy.schema).toBe(latestSchemaVersion);
      expect(copy.tables.settings.find((r) => r.key === 'probe')?.value).toBe('keep-me');
      // An older program refuses a database that a newer one has upgraded.
      await db.run("INSERT INTO schema_migrations (version, name) VALUES (998, 'from_the_future')");
      await expect(migrate(db, migrations, dir)).rejects.toThrow(/upgraded by a newer version/);
    } finally {
      await db.close();
    }
  }, 30_000);
});
