import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';
import { getDb } from '../src/db/index.js';

const app = createApp();
const admin = request.agent(app);
const worker = request.agent(app);

async function createProduct(body: Record<string, unknown>) {
  const res = await admin.post('/api/products').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: number; quantity: number; sku: string };
}

beforeAll(async () => {
  getDb();
  const res = await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' });
  expect(res.status).toBe(200);
  const u = await admin
    .post('/api/users')
    .send({ username: 'worker', fullName: 'Warehouse Worker', role: 'WAREHOUSE_USER', password: 'worker123', isActive: true });
  expect(u.status).toBe(201);
  expect((await worker.post('/api/auth/login').send({ username: 'worker', password: 'worker123' })).status).toBe(200);
});

describe('authentication & authorization', () => {
  it('rejects bad credentials and anonymous requests', async () => {
    expect((await request(app).post('/api/auth/login').send({ username: 'admin', password: 'nope' })).status).toBe(401);
    expect((await request(app).get('/api/products')).status).toBe(401);
  });

  it('stores passwords hashed', () => {
    const hash = getDb().prepare(`SELECT password_hash FROM users WHERE username = 'worker'`).pluck().get() as string;
    expect(hash).not.toContain('worker123');
    expect(hash.startsWith('$2')).toBe(true);
  });

  it('limits warehouse users', async () => {
    expect((await worker.get('/api/users')).status).toBe(403);
    expect((await worker.post('/api/products').send({ sku: 'X', name: 'X' })).status).toBe(403);
    expect((await worker.post('/api/stock/adjust').send({ mode: 'count', productId: 1, countedQuantity: 1, reason: 'x' })).status).toBe(403);
    expect((await worker.get('/api/products')).status).toBe(200);
  });
});

describe('stock ledger', () => {
  it('scan IN / OUT follows the example: 50 + 10 - 7 = 53', async () => {
    const p = await createProduct({ sku: 'ABC123', barcode: '5201234567890', name: 'Test product', initialQuantity: 50, minStock: 10 });
    expect(p.quantity).toBe(50);

    const inRes = await worker.post('/api/stock/scan').send({ code: '5201234567890', mode: 'IN', quantity: 10 });
    expect(inRes.status).toBe(201);
    expect(inRes.body.data.product.quantity).toBe(60);
    expect(inRes.body.data.transaction).toMatchObject({ type: 'STOCK_IN', quantity_before: 50, quantity_change: 10, quantity_after: 60 });

    const outRes = await worker.post('/api/stock/scan').send({ code: 'ABC123', mode: 'OUT', quantity: 7 });
    expect(outRes.body.data.product.quantity).toBe(53);
    expect(outRes.body.data.transaction).toMatchObject({ type: 'STOCK_OUT', quantity_before: 60, quantity_change: -7, quantity_after: 53 });

    const history = await admin.get(`/api/products/${p.id}/transactions`);
    expect(history.body.data.map((t: { type: string }) => t.type)).toEqual(['STOCK_OUT', 'STOCK_IN', 'INITIAL_STOCK']);
    expect(history.body.data[0].username).toBe('worker');
  });

  it('refuses negative stock with a clear error', async () => {
    const res = await worker.post('/api/stock/scan').send({ code: 'ABC123', mode: 'OUT', quantity: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details.items[0]).toMatchObject({ available: 53, requested: 1000 });
    const p = await admin.get('/api/products/lookup?code=ABC123');
    expect(p.body.data[0].quantity).toBe(53);
  });

  it('returns 404 for unknown barcodes', async () => {
    const res = await worker.post('/api/stock/scan').send({ code: '0000000000', mode: 'IN' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('adjusts to a physical count (75 -> 72 = -3) with a reason', async () => {
    const p = await createProduct({ sku: 'ADJ-1', name: 'Adjust me', initialQuantity: 75 });
    const res = await admin.post('/api/stock/adjust').send({ mode: 'count', productId: p.id, countedQuantity: 72, reason: 'Physical inventory count' });
    expect(res.status).toBe(200);
    expect(res.body.data.transaction).toMatchObject({ type: 'ADJUSTMENT_MINUS', quantity_before: 75, quantity_change: -3, quantity_after: 72, notes: 'Physical inventory count' });
  });

  it('lets a user undo their own scan', async () => {
    const scan = await worker.post('/api/stock/scan').send({ code: 'ABC123', mode: 'IN', quantity: 5 });
    const undo = await worker.post(`/api/transactions/${scan.body.data.transaction.id}/reverse`).send({});
    expect(undo.status).toBe(200);
    expect(undo.body.data.product.quantity).toBe(53);
    expect((await worker.post(`/api/transactions/${scan.body.data.transaction.id}/reverse`).send({})).status).toBe(400);
  });
});

describe('products', () => {
  it('rejects duplicate SKU and asks confirmation for duplicate barcode', async () => {
    const dupSku = await admin.post('/api/products').send({ sku: 'abc123', name: 'Dup' });
    expect(dupSku.status).toBe(409);
    expect(dupSku.body.error.code).toBe('DUPLICATE_SKU');

    const dupBarcode = await admin.post('/api/products').send({ sku: 'ABC124', barcode: '5201234567890', name: 'Variant' });
    expect(dupBarcode.status).toBe(409);
    expect(dupBarcode.body.error.code).toBe('DUPLICATE_BARCODE');

    await createProduct({ sku: 'ABC124', barcode: '5201234567890', name: 'Variant', confirmDuplicateBarcode: true });
    const scan = await worker.post('/api/stock/scan').send({ code: '5201234567890', mode: 'IN' });
    expect(scan.status).toBe(409);
    expect(scan.body.error.code).toBe('MULTIPLE_MATCHES');
    expect(scan.body.error.details.products).toHaveLength(2);
  });

  it('logs field changes in the audit log', async () => {
    const p = await createProduct({ sku: 'AUD-1', name: 'Audited', minStock: 10 });
    await admin.put(`/api/products/${p.id}`).send({ sku: 'AUD-1', name: 'Audited', minStock: 20 });
    const log = await admin.get(`/api/audit?productId=${p.id}`);
    expect(log.body.data[0].description).toContain('minimum stock from "10" to "20"');
  });

  it('searches accent- and case-insensitively (Greek)', async () => {
    await createProduct({ sku: 'GR-1', name: 'Ελληνικός Καφές 194g' });
    const res = await admin.get('/api/search?q=' + encodeURIComponent('ελληνικος καφ'));
    expect(res.body.data.products.map((p: { sku: string }) => p.sku)).toContain('GR-1');
  });
});

describe('receipts & dispatches', () => {
  it('confirms a receipt and updates every line', async () => {
    const a = await createProduct({ sku: 'RC-A', name: 'Receipt A' });
    const b = await createProduct({ sku: 'RC-B', name: 'Receipt B', initialQuantity: 5 });
    const res = await worker.post('/api/receipts').send({
      date: '2026-09-28',
      invoiceNumber: 'INV-1',
      items: [{ productId: a.id, quantity: 12 }, { productId: b.id, quantity: 3, unitPrice: 2 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.receipt_number).toMatch(/^RCV-\d{4}-00001$/);
    const la = await admin.get('/api/products/lookup?code=RC-A');
    const lb = await admin.get('/api/products/lookup?code=RC-B');
    expect(la.body.data[0].quantity).toBe(12);
    expect(lb.body.data[0].quantity).toBe(8);
  });

  it('rejects a dispatch atomically when any line lacks stock', async () => {
    const a = (await admin.get('/api/products/lookup?code=RC-A')).body.data[0];
    const b = (await admin.get('/api/products/lookup?code=RC-B')).body.data[0];
    const res = await worker.post('/api/dispatches').send({
      date: '2026-09-28',
      customerName: 'Customer',
      items: [{ productId: a.id, quantity: 2 }, { productId: b.id, quantity: 5 }, { productId: b.id, quantity: 5 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.items[0]).toMatchObject({ sku: 'RC-B', available: 8, requested: 10 });
    expect((await admin.get('/api/products/lookup?code=RC-A')).body.data[0].quantity).toBe(12);

    const ok = await worker.post('/api/dispatches').send({ date: '2026-09-28', items: [{ productId: a.id, quantity: 2 }] });
    expect(ok.status).toBe(201);
    expect((await admin.get('/api/products/lookup?code=RC-A')).body.data[0].quantity).toBe(10);

    const cancel = await admin.post(`/api/dispatches/${ok.body.data.id}/cancel`).send({});
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect((await admin.get('/api/products/lookup?code=RC-A')).body.data[0].quantity).toBe(12);
  });
});

describe('excel import / export', () => {
  const rows = [
    { rowNumber: 2, sku: 'IMP-1', barcode: 5209999000011, name: 'Imported 1', category: 'Νέα Κατηγορία', quantity: '10', purchasePrice: '1,50' },
    { rowNumber: 3, sku: 'ABC123', name: 'Renamed by import', minStock: 15 },
    { rowNumber: 4, sku: 'IMP-2', name: '' },
    { rowNumber: 5, sku: 'IMP-1', name: 'Duplicate in file' },
    { rowNumber: 6, sku: 'IMP-3', name: 'Bad number', quantity: 'abc' },
  ];

  it('validates rows', async () => {
    const res = await admin.post('/api/import/products/validate').send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ total: 5, new: 1, existing: 1, errors: 3 });
  });

  it('imports valid rows and reports the result', async () => {
    const res = await admin.post('/api/import/products/commit').send({ rows, options: { duplicateStrategy: 'update', quantityMode: 'ignore', createMissing: true } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ imported: 1, updated: 1, skipped: 0, errors: 3 });
    const imp = (await admin.get('/api/products/lookup?code=5209999000011')).body.data[0];
    expect(imp).toMatchObject({ sku: 'IMP-1', quantity: 10, purchasePrice: 1.5, categoryName: 'Νέα Κατηγορία' });
    const upd = (await admin.get('/api/products/lookup?code=ABC123')).body.data[0];
    expect(upd).toMatchObject({ name: 'Renamed by import', minStock: 15, quantity: 53 });
  });

  it('exports a valid xlsx', async () => {
    const res = await admin.get('/api/export/products').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    const ws = wb.getWorksheet('Products')!;
    expect(ws.getRow(1).getCell(1).value).toBe('SKU');
    expect(ws.rowCount).toBeGreaterThan(5);
  });
});
