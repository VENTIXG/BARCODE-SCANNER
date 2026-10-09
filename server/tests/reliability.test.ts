import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getDb, migrate } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';

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
  getDb();
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = await login('admin', 'admin123');
  const u = await api('POST', '/users', { username: 'rel_worker', fullName: 'Reliability Worker', role: 'WAREHOUSE_USER', password: 'worker-pass-1' });
  expect(u.status).toBe(201);
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
  it('a failing migration rolls back and leaves a copy from before the upgrade', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const file = path.join(dir, 'test.db');
    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    migrate(db, migrations, dir); // fresh database: no copy needed
    db.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'keep-me')").run();
    const bad = [...migrations, { version: 99, name: 'broken', sql: 'CREATE TABLE should_not_exist (a INTEGER); INSERT INTO missing_table VALUES (1);' }];
    expect(() => migrate(db, bad, dir)).toThrow();
    const copies = fs.readdirSync(dir).filter((f) => f.includes('before-migrate-v99'));
    expect(copies).toHaveLength(1);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'probe'").pluck().get()).toBe('keep-me');
    expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'should_not_exist'").pluck().get()).toBe(0);
    expect(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(migrations[migrations.length - 1].version);
    const copy = new Database(path.join(dir, copies[0]), { readonly: true });
    expect(copy.prepare("SELECT value FROM settings WHERE key = 'probe'").pluck().get()).toBe('keep-me');
    copy.close();
    db.close();
  });
});
