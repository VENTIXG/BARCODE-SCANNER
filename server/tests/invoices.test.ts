/**
 * Supplier invoices into the warehouse: original descriptions kept, reliable matches only,
 * uncertain lines for review, posting as a goods receipt, and no second import unnoticed.
 */
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getDb, initDb } from '../src/db/index.js';
import { addUser } from './users.js';

const app = createApp();
const admin = request.agent(app);
const worker = request.agent(app);
let supplier = 0;
let otherSupplier = 0;
const ids: Record<string, number> = {};
const hash = crypto.createHash('sha256').update('invoice file A-100').digest('hex');

const lines = [
  // Same description, other letter case, no accents and other spacing.
  { lineNo: 1, description: 'COLA  330ML', quantity: '24', unitPrice: '0,35' },
  // Only similar: shown for review, never matched by itself. Unit price from the line total.
  { lineNo: 2, description: 'ΝΕΡΟ  ΦΥΣΙΚΟ 500ML', sku: 'NR 500', quantity: 12, lineTotal: '3,00' },
  // Nothing like it in the warehouse.
  { lineNo: 3, description: 'ΑΓΝΩΣΤΟ ΠΡΟΪΟΝ  1KG', quantity: 2, unitPrice: 5 },
  // Not a product line (no quantity).
  { lineNo: 4, description: 'ΜΕΤΑΦΟΡΙΚΑ', quantity: null },
  // Barcode of a product: matched, whatever the description says.
  { lineNo: 5, description: 'Cola (προσφορά)', barcode: '5200000000017', quantity: '6', unitPrice: '0.30' },
  // Our SKU used by another supplier's product: asked, not assumed.
  { lineNo: 6, description: 'Item of the other supplier', sku: '1001', quantity: 1, unitPrice: 1 },
];

const matchLines = async (body: Record<string, unknown> = {}) => {
  const res = await admin.post('/api/invoices/match').send({ supplierId: supplier, invoiceNumber: 'Α-100', fileHash: hash, lines, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as {
    lines: { line: { lineNo: number; description: string; quantity: number; unitPrice: number | null }; status: string; productId: number | null; by: string | null; candidates: { product: { id: number }; by: string }[]; warnings: string[]; errors: string[] }[];
    duplicates: { receiptNumber: string; reason: string }[];
  };
};

beforeAll(async () => {
  await initDb();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
  supplier = (await admin.post('/api/suppliers').send({ name: 'Αφοί Δοκιμή Α.Ε.' })).body.data.id;
  otherSupplier = (await admin.post('/api/suppliers').send({ name: 'Other Supplier' })).body.data.id;
  for (const p of [
    { key: 'cola', sku: 'COLA-330', name: 'Cola 330ml', barcode: '5200000000017', purchasePrice: 0.3 },
    { key: 'water', sku: 'NERO 500', name: 'Νερό 500ml', purchasePrice: 0.2 },
    { key: 'foreign', sku: '1001', name: 'Foreign item', supplierId: otherSupplier },
  ]) {
    const { key, ...body } = p;
    const res = await admin.post('/api/products').send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ids[key] = res.body.data.id;
  }
  await addUser(admin, worker, { username: 'inv_worker', fullName: 'Invoice Worker', role: 'WAREHOUSE_USER', password: 'worker-pass-1' });
});

describe('matching invoice lines', () => {
  it('keeps the original text and matches only what is reliable', async () => {
    const { lines: m, duplicates } = await matchLines();
    expect(duplicates).toEqual([]);
    const at = (n: number) => m.find((l) => l.line.lineNo === n)!;
    expect(at(1)).toMatchObject({ status: 'matched', productId: ids.cola, by: 'description', line: { description: 'COLA  330ML', quantity: 24, unitPrice: 0.35 } });
    expect(at(2)).toMatchObject({ status: 'review', productId: null, line: { description: 'ΝΕΡΟ  ΦΥΣΙΚΟ 500ML', unitPrice: 0.25 } });
    expect(at(2).candidates[0]).toMatchObject({ product: { id: ids.water }, by: 'similar' });
    expect(at(2).warnings.join(' ')).toMatch(/line total/);
    expect(at(3)).toMatchObject({ status: 'new', candidates: [] });
    expect(at(4)).toMatchObject({ status: 'error' });
    expect(at(5)).toMatchObject({ status: 'matched', productId: ids.cola, by: 'barcode' });
    expect(at(5).warnings.join(' ')).toMatch(/Same product as line 1/);
    expect(at(6)).toMatchObject({ status: 'review', productId: null });
    expect(at(6).candidates[0]).toMatchObject({ product: { id: ids.foreign }, by: 'sku' });
  });

  it('with a discount, the net value of the line gives the unit cost', async () => {
    const res = await admin
      .post('/api/invoices/match')
      .send({ supplierId: supplier, lines: [{ lineNo: 1, description: 'COLA 330ML', quantity: '1200', unitPrice: '2.10', lineTotal: '2268.00' }] });
    expect(res.body.data.lines[0].line).toMatchObject({ quantity: 1200, unitPrice: 1.89 });
    expect(res.body.data.lines[0].warnings.join(' ')).toMatch(/after discount/);
  });

  it('a different size is never similar ("500ML" is not "1L")', async () => {
    const res = await admin.post('/api/invoices/match').send({ supplierId: supplier, lines: [{ lineNo: 1, description: 'ΝΕΡΟ 1L', quantity: 1 }] });
    expect(res.body.data.lines[0]).toMatchObject({ status: 'new', candidates: [] });
  });
});

describe('receiving the invoice', () => {
  let receiptId = 0;
  const commit = (body: Record<string, unknown> = {}, who = admin) =>
    who.post('/api/invoices/commit').send({
      supplierId: supplier,
      invoiceNumber: 'Α-100',
      date: '2026-10-20',
      fileName: 'invoice-A-100.xlsx',
      fileHash: hash,
      updatePurchasePrices: true,
      layout: { version: 1, source: 'sheet', columns: { description: { header: 'Περιγραφή', index: 1 }, quantity: { header: 'Ποσότητα', index: 3 }, unitPrice: { header: 'Τιμή', index: 4 } } },
      lines: [
        { lineNo: 1, description: 'COLA  330ML', quantity: 24, unitPrice: 0.35, action: 'product', productId: ids.cola },
        { lineNo: 2, description: 'ΝΕΡΟ  ΦΥΣΙΚΟ 500ML', sku: 'NR 500', quantity: 12, unitPrice: 0.25, action: 'product', productId: ids.water },
        { lineNo: 3, description: 'ΑΓΝΩΣΤΟ ΠΡΟΪΟΝ  1KG', quantity: 2, unitPrice: 5, action: 'new' },
        { lineNo: 5, description: 'Cola (προσφορά)', barcode: '5200000000017', quantity: 6, unitPrice: 0.3, action: 'product', productId: ids.cola },
        { lineNo: 6, description: 'Item of the other supplier', sku: '1001', quantity: 1, action: 'skip' },
      ],
      ...body,
    });

  it('a warehouse user cannot create new products from an invoice', async () => {
    const res = await commit({}, worker);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('posts a goods receipt with the invoice number and the invoice text of every line', async () => {
    const res = await commit({ idempotencyKey: 'invoice-key-0001' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { receipt, created, skipped, remembered } = res.body.data;
    receiptId = receipt.id;
    expect(receipt).toMatchObject({ invoice_number: 'Α-100', status: 'CONFIRMED', supplier_name: 'Αφοί Δοκιμή Α.Ε.' });
    expect(receipt.items.map((i: { invoice_description: string }) => i.invoice_description)).toEqual([
      'COLA  330ML',
      'ΝΕΡΟ  ΦΥΣΙΚΟ 500ML',
      'ΑΓΝΩΣΤΟ ΠΡΟΪΟΝ  1KG',
      'Cola (προσφορά)',
    ]);
    expect(skipped).toBe(1);
    expect(remembered).toBe(4); // two descriptions of Cola, Water's description and its code
    expect(created).toHaveLength(1);
    // The new product: named exactly as on the invoice, automatic SKU, no invented selling price.
    const p = (await admin.get(`/api/products/${created[0].id}`)).body.data;
    expect(p).toMatchObject({ name: 'ΑΓΝΩΣΤΟ ΠΡΟΪΟΝ  1KG', sku: 'P-000001', quantity: 2, purchasePrice: 5, sellingPrice: null, supplierName: 'Αφοί Δοκιμή Α.Ε.' });
    // Stock and purchase prices.
    const cola = (await admin.get(`/api/products/${ids.cola}`)).body.data;
    expect(cola).toMatchObject({ quantity: 30, purchasePrice: 0.3 });
    const water = (await admin.get(`/api/products/${ids.water}`)).body.data;
    expect(water).toMatchObject({ quantity: 12, purchasePrice: 0.25, name: 'Νερό 500ml', sku: 'NERO 500' });
    // A retry with the same key does not post again.
    expect((await commit({ idempotencyKey: 'invoice-key-0001' })).body.data.receipt.id).toBe(receiptId);
  });

  it('remembers the layout and what the supplier calls each product', async () => {
    expect((await admin.get(`/api/invoices/layout/${supplier}`)).body.data).toMatchObject({ source: 'sheet', columns: { description: { header: 'Περιγραφή' } } });
    const { lines: m, duplicates } = await matchLines();
    const at = (n: number) => m.find((l) => l.line.lineNo === n)!;
    expect(at(2)).toMatchObject({ status: 'matched', productId: ids.water, by: 'supplier-code' });
    expect(at(3)).toMatchObject({ status: 'matched', by: 'description' });
    // Saved for this supplier only: another supplier's invoice is still asked.
    const other = await admin.post('/api/invoices/match').send({ supplierId: otherSupplier, lines: [{ lineNo: 1, description: 'ΝΕΡΟ  ΦΥΣΙΚΟ 500ML', quantity: 1 }] });
    expect(other.body.data.lines[0]).toMatchObject({ status: 'review' });
    expect(other.body.data.lines[0].candidates[0]).toMatchObject({ product: { id: ids.water }, by: 'other-supplier' });
    expect(duplicates[0]).toMatchObject({ reason: 'number' });
  });

  it('refuses the same invoice again unless confirmed (same number, or the same file)', async () => {
    const again = await commit({ lines: [{ lineNo: 1, description: 'COLA  330ML', quantity: 1, action: 'product', productId: ids.cola }] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_INVOICE');
    const sameFile = await commit({ invoiceNumber: 'A 101', lines: [{ lineNo: 1, description: 'x', quantity: 1, action: 'product', productId: ids.cola }] });
    expect(sameFile.status).toBe(409);
    expect(sameFile.body.error.details.duplicates[0].reason).toBe('file');
    // Spacing in the number does not hide a duplicate.
    const spaced = await admin.post('/api/invoices/match').send({ supplierId: supplier, invoiceNumber: 'α - 100', lines });
    expect(spaced.body.data.duplicates).toHaveLength(1);
    // The same number from another supplier is another invoice.
    const other = await admin.post('/api/invoices/match').send({ supplierId: otherSupplier, invoiceNumber: 'Α-100', lines });
    expect(other.body.data.duplicates).toEqual([]);
    const confirmed = await commit({ allowDuplicate: true, lines: [{ lineNo: 1, description: 'COLA  330ML', quantity: 1, action: 'product', productId: ids.cola }] });
    expect(confirmed.status).toBe(201);
    // Cancelling the receipts makes the invoice importable again.
    for (const r of [receiptId, confirmed.body.data.receipt.id]) expect((await admin.post(`/api/receipts/${r}/cancel`).send({})).status).toBe(200);
    expect((await matchLines()).duplicates).toEqual([]);
  });

  it('a new product never reuses an SKU or barcode of another product', async () => {
    const res = await commit({
      invoiceNumber: 'Α-200',
      fileHash: null,
      lines: [{ lineNo: 1, description: 'Other cola', barcode: '5200000000017', quantity: 1, action: 'new' }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_BARCODE');
    const sku = await commit({
      invoiceNumber: 'Α-201',
      fileHash: null,
      lines: [{ lineNo: 1, description: 'Water again', quantity: 1, action: 'new', newProduct: { sku: 'nero  500' } }],
    });
    expect(sku.status).toBe(409);
    expect(sku.body.error.code).toBe('DUPLICATE_SKU');
    // Nothing was kept from the failed attempts.
    expect(await getDb().value("SELECT COUNT(*) FROM stock_receipts WHERE invoice_number IN ('Α-200', 'Α-201')")).toBe(0);
  });

  it('lists the imported invoices', async () => {
    const list = (await admin.get('/api/invoices')).body.data;
    expect(list[0]).toMatchObject({ invoice_number: 'Α-100', supplier_name: 'Αφοί Δοκιμή Α.Ε.', receipt_status: 'CANCELLED' });
  });
});
