import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getDb } from '../src/db/index.js';

let base = '';
let server: http.Server;
let cookie = '';

const api = (method: string, url: string, body?: unknown) =>
  fetch(`${base}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  getDb();
  server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('sizes / variants', () => {
  let parentId = 0;
  const sizes = () => [
    { size: 'S', sku: 'TSHIRT-S', barcode: '5201111000011', initialQuantity: 10 },
    { size: 'M', sku: 'TSHIRT-M', barcode: '5201111000028', initialQuantity: 10 },
    { size: 'L', sku: 'TSHIRT-L', barcode: '5201111000035', initialQuantity: 5 },
  ];

  it('creates a base product and its sizes with their own SKU and barcode', async () => {
    const p = await api('POST', '/products', { sku: 'TSHIRT', name: 'Μπλούζα Polo', minStock: 2, sellingPrice: 19.9 });
    parentId = (await p.json()).data.id;
    const res = await api('POST', `/products/${parentId}/variants`, { idempotencyKey: 'variants-key-01', variants: sizes() });
    expect(res.status).toBe(201);
    const created = (await res.json()).data as { size: string; sku: string; quantity: number; sellingPrice: number; parentId: number }[];
    expect(created.map((c) => c.size)).toEqual(['S', 'M', 'L']);
    expect(created.map((c) => c.quantity)).toEqual([10, 10, 5]);
    expect(created.every((c) => c.parentId === parentId && c.sellingPrice === 19.9)).toBe(true);
  });

  it('scanning a size changes only that size; history stays per size', async () => {
    const scan = await api('POST', '/stock/scan', { code: '5201111000028', mode: 'OUT', quantity: 3 });
    expect(scan.status).toBe(201);
    const bySku = async (sku: string) => (await (await api('GET', `/products/lookup?code=${sku}`)).json()).data[0];
    expect((await bySku('TSHIRT-M')).quantity).toBe(7);
    expect((await bySku('TSHIRT-S')).quantity).toBe(10);
    expect((await bySku('TSHIRT')).quantity).toBe(0);
    const mId = (await bySku('TSHIRT-M')).id;
    const history = await (await api('GET', `/products/${mId}/transactions`)).json();
    expect(history.data.map((t: { type: string }) => t.type)).toEqual(['STOCK_OUT', 'INITIAL_STOCK']);
  });

  it('the base product page lists its sizes', async () => {
    const detail = await (await api('GET', `/products/${parentId}`)).json();
    expect(detail.variants.map((v: { size: string }) => v.size)).toEqual(['S', 'M', 'L']);
  });

  it('refuses duplicate sizes, duplicate SKUs and nested sizes', async () => {
    const dup = await api('POST', `/products/${parentId}/variants`, {
      idempotencyKey: 'variants-key-02',
      variants: [{ size: 'XL', sku: 'TSHIRT-XL' }, { size: 'xl', sku: 'TSHIRT-XL2' }],
    });
    expect(dup.status).toBe(400);
    const sku = await api('POST', `/products/${parentId}/variants`, { idempotencyKey: 'variants-key-03', variants: [{ size: 'XXL', sku: 'TSHIRT-M' }] });
    expect(sku.status).toBe(409);
    const sizeId = (await (await api('GET', '/products/lookup?code=TSHIRT-M')).json()).data[0].id;
    const nested = await api('POST', `/products/${sizeId}/variants`, { idempotencyKey: 'variants-key-04', variants: [{ size: 'XS', sku: 'TSHIRT-XS' }] });
    expect(nested.status).toBe(400);
  });

  it('a repeated request does not create the sizes twice', async () => {
    const body = { idempotencyKey: 'variants-key-05', variants: [{ size: 'XXL', sku: 'TSHIRT-XXL', initialQuantity: 1 }] };
    expect((await api('POST', `/products/${parentId}/variants`, body)).status).toBe(201);
    expect((await api('POST', `/products/${parentId}/variants`, body)).status).toBe(201);
    const detail = await (await api('GET', `/products/${parentId}`)).json();
    expect(detail.variants.filter((v: { size: string }) => v.size === 'XXL')).toHaveLength(1);
  });

  it('the base product cannot be deleted while it has sizes with history', async () => {
    const res = await api('DELETE', `/products/${parentId}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('PRODUCT_HAS_VARIANTS');
  });
});
