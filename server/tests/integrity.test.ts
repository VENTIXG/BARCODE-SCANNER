/**
 * Data integrity: every stock figure is the sum of its movements after any mix of operations,
 * a failure in the middle of an import / invoice / receipt leaves nothing behind, the same
 * file or invoice sent twice at the same moment is posted once, and product updates change
 * only what they were asked to change.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getDb, initDb } from '../src/db/index.js';

const app = createApp();
const admin = request.agent(app);
let supplier = 0;

const product = async (id: number) => (await admin.get(`/api/products/${id}`)).body.data;
const create = async (body: Record<string, unknown>) => {
  const res = await admin.post('/api/products').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: number; sku: string };
};
const counts = async () => {
  const db = getDb();
  return {
    products: await db.value<number>('SELECT COUNT(*) FROM products'),
    transactions: await db.value<number>('SELECT COUNT(*) FROM inventory_transactions'),
    receipts: await db.value<number>('SELECT COUNT(*) FROM stock_receipts'),
    imports: await db.value<number>('SELECT COUNT(*) FROM product_imports'),
    invoiceImports: await db.value<number>('SELECT COUNT(*) FROM invoice_imports'),
    stock: await db.value<number>('SELECT COALESCE(SUM(quantity), 0) FROM inventory'),
  };
};

/** Stock = sum of movements, and every movement starts where the previous one ended. */
async function ledgerProblems() {
  const db = getDb();
  const sums = await db.all(
    `SELECT i.product_id, i.quantity, COALESCE(SUM(t.quantity_change), 0) AS moved
     FROM inventory i LEFT JOIN inventory_transactions t ON t.product_id = i.product_id AND t.warehouse_id = i.warehouse_id
     GROUP BY i.product_id, i.warehouse_id, i.quantity
     HAVING ABS(i.quantity - COALESCE(SUM(t.quantity_change), 0)) > 0.0005`,
  );
  const chain = await db.all(
    `SELECT id, product_id FROM (
       SELECT id, product_id, quantity_before, quantity_after, quantity_change,
              LAG(quantity_after) OVER (PARTITION BY product_id, warehouse_id ORDER BY id) AS prev_after
       FROM inventory_transactions) x
     WHERE ABS(quantity_before + quantity_change - quantity_after) > 0.0005
        OR (prev_after IS NOT NULL AND ABS(prev_after - quantity_before) > 0.0005)`,
  );
  return { sums, chain };
}

beforeAll(async () => {
  await initDb();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
  supplier = (await admin.post('/api/suppliers').send({ name: 'Integrity Supplier' })).body.data.id;
});

describe('products: what is saved is what was sent', () => {
  it('all fields saved on create, read back after a fresh read', async () => {
    const cat = (await admin.post('/api/categories').send({ name: 'Integrity Cat' })).body.data.id;
    const p = await create({
      sku: 'INT 001', barcode: '0001112223334', name: 'Integrity, product: “quoted” & more', description: 'Line 1, with punctuation; and spaces  inside.',
      categoryId: cat, supplierId: supplier, unit: 'kg', minStock: 2.5, purchasePrice: 12.5, sellingPrice: 19.9, locationCode: 'A-01-02', initialQuantity: 15,
    });
    const back = await product(p.id);
    expect(back).toMatchObject({
      sku: 'INT 001', barcode: '0001112223334', name: 'Integrity, product: “quoted” & more', description: 'Line 1, with punctuation; and spaces  inside.',
      categoryId: cat, supplierId: supplier, unit: 'kg', minStock: 2.5, purchasePrice: 12.5, sellingPrice: 19.9, locationCode: 'A-01-02', quantity: 15,
    });
  });

  it('an update that sends only some fields keeps every other value (prices are never reset)', async () => {
    const p = await create({ sku: 'INT 002', name: 'Partial', description: 'keep me', unit: 'lt', minStock: 4, purchasePrice: 7.25, sellingPrice: 11, locationCode: 'B-02-01', initialQuantity: 3 });
    const res = await admin.put(`/api/products/${p.id}`).send({ sku: 'INT 002', name: 'Partial renamed', sellingPrice: 12.5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await product(p.id)).toMatchObject({
      name: 'Partial renamed', description: 'keep me', unit: 'lt', minStock: 4, purchasePrice: 7.25, sellingPrice: 12.5, locationCode: 'B-02-01', quantity: 3,
    });
    // Explicit values still change them, null clears the optional ones.
    await admin.put(`/api/products/${p.id}`).send({ sku: 'INT 002', name: 'Partial renamed', purchasePrice: 0, sellingPrice: null, description: null, locationCode: null });
    expect(await product(p.id)).toMatchObject({ purchasePrice: 0, sellingPrice: null, description: null, locationCode: null, quantity: 3 });
  });

  it('SKUs and names with special characters are kept exactly and found again', async () => {
    const codes = ['ΑΒΓ-12/3', "O'BRIEN #5", 'x&y=z?', '50% OFF', 'A_B\\C', 'ΚΑΦΕΣ «ΧΡΥΣΟΣ» 500γρ', '00123', '12 34 56'];
    for (const sku of codes) {
      const p = await create({ sku, name: `Product ${sku}` });
      const back = await product(p.id);
      expect(back.sku).toBe(sku);
      const found = (await admin.get('/api/products/lookup').query({ code: sku })).body.data.map((x: { id: number }) => x.id);
      expect(found, sku).toEqual([p.id]);
      const listed = (await admin.get('/api/products').query({ q: sku })).body.data.map((x: { id: number }) => x.id);
      expect(listed, sku).toContain(p.id);
    }
  });

  it('a product that already has movements cannot be deleted (its history stays)', async () => {
    const p = await create({ sku: 'INT DEL', name: 'Delete me', initialQuantity: 1 });
    await admin.post('/api/stock/scan').send({ productId: p.id, mode: 'IN', quantity: 1 });
    expect((await admin.delete(`/api/products/${p.id}`)).status).toBe(409);
    const fresh = await create({ sku: 'INT DEL 2', name: 'Delete me too' });
    expect((await admin.delete(`/api/products/${fresh.id}`)).status).toBe(204);
    expect((await admin.get(`/api/products/${fresh.id}`)).status).toBe(404);
  });
});

describe('stock = sum of movements after every kind of operation', () => {
  it('scans, adjustments, counts, receipts, dispatches, cancellations, reversals, imports and invoices', async () => {
    const a = await create({ sku: 'LEDGER-A', name: 'Ledger A', barcode: '2000000000015', purchasePrice: 1, initialQuantity: 50 });
    const b = await create({ sku: 'LEDGER-B', name: 'Ledger B', purchasePrice: 2, initialQuantity: 0 });
    const ok = (r: request.Response) => expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    ok(await admin.post('/api/stock/scan').send({ code: '2000000000015', mode: 'OUT', quantity: 7 }));
    ok(await admin.post('/api/stock/scan').send({ productId: b.id, mode: 'IN', quantity: 2.75 }));
    ok(await admin.post('/api/stock/adjust').send({ mode: 'ADJUSTMENT_MINUS', productId: a.id, quantity: 3, reason: 'damaged' }));
    ok(await admin.post('/api/stock/adjust').send({ mode: 'count', productId: b.id, countedQuantity: 10, reason: 'count' }));
    const rcv = await admin.post('/api/receipts').send({ date: '2026-10-01', supplierId: supplier, items: [{ productId: a.id, quantity: 20, unitPrice: 1.1 }, { productId: b.id, quantity: 5 }] });
    ok(rcv);
    const dsp = await admin.post('/api/dispatches').send({ date: '2026-10-02', items: [{ productId: a.id, quantity: 12 }] });
    ok(dsp);
    ok(await admin.post(`/api/receipts/${rcv.body.data.id}/cancel`).send({ reason: 'wrong' }));
    // Too little stock to cancel the dispatch's opposite? Cancelling a dispatch puts stock back.
    ok(await admin.post(`/api/dispatches/${dsp.body.data.id}/cancel`).send({}));
    const scan = await admin.post('/api/stock/scan').send({ productId: a.id, mode: 'IN', quantity: 4 });
    ok(await admin.post(`/api/transactions/${scan.body.data.transaction.id}/reverse`).send({ reason: 'mistake' }));
    ok(await admin.post('/api/import/products/commit').send({ rows: [{ rowNumber: 2, sku: 'LEDGER-A', quantity: 6 }, { rowNumber: 3, sku: 'LEDGER-C', quantity: 9, purchasePrice: 3 }], options: { quantityMode: 'add' } }));
    ok(await admin.post('/api/import/products/commit').send({ rows: [{ rowNumber: 2, sku: 'LEDGER-B', quantity: 1 }], options: { quantityMode: 'set' } }));
    ok(await admin.post('/api/invoices/commit').send({
      supplierId: supplier, invoiceNumber: 'LEDGER-INV-1', date: '2026-10-03', updatePurchasePrices: true,
      lines: [{ lineNo: 1, description: 'Ledger A', sku: 'LEDGER-A', quantity: 2, unitPrice: 1.2, action: 'product', productId: a.id }],
    }));
    // Not allowed: stock never goes below zero, and the refused operation leaves no trace.
    const before = await counts();
    expect((await admin.post('/api/dispatches').send({ date: '2026-10-04', items: [{ productId: b.id, quantity: 999 }] })).status).toBe(409);
    expect((await admin.post('/api/stock/scan').send({ productId: b.id, mode: 'OUT', quantity: 999 })).status).toBe(409);
    expect(await counts()).toEqual(before);

    // 50 - 7 - 3 + 20 - 12 - 20(cancel) + 12(cancel) + 4 - 4 + 6 + 2 = 48
    expect((await product(a.id)).quantity).toBe(48);
    expect((await product(b.id)).quantity).toBe(1);
    expect((await product(a.id)).purchasePrice).toBe(1.2);
    expect(await ledgerProblems()).toEqual({ sums: [], chain: [] });
  });
});

describe('a failure halfway leaves nothing behind', () => {
  // A database error on one product, after other rows were already written in the transaction.
  beforeAll(async () => {
    await getDb().exec(`
      CREATE OR REPLACE FUNCTION test_fail_on_sku() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.sku::text = 'FAIL-ME' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_on_sku BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION test_fail_on_sku();`);
  });

  it('Excel import of 50 rows failing at row 40: no product, no movement, no import record', async () => {
    const before = await counts();
    const rows = Array.from({ length: 50 }, (_, i) => ({ rowNumber: i + 2, sku: i === 38 ? 'FAIL-ME' : `HALF-${i}`, quantity: 5, purchasePrice: 1 }));
    const res = await admin.post('/api/import/products/commit').send({ rows, options: {}, fileHash: 'c'.repeat(64), fileName: 'half.xlsx' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await counts()).toEqual(before);
    // The same file works once the problem is gone.
    const fixed = rows.map((r) => (r.sku === 'FAIL-ME' ? { ...r, sku: 'HALF-38' } : r));
    expect((await admin.post('/api/import/products/commit').send({ rows: fixed, options: {}, fileHash: 'c'.repeat(64) })).body.data.imported).toBe(50);
  });

  it('supplier invoice whose last line fails: no receipt, no stock, no invoice record, no new products', async () => {
    const a = await create({ sku: 'HALF-INV', name: 'Half invoice', initialQuantity: 1 });
    const before = await counts();
    const res = await admin.post('/api/invoices/commit').send({
      supplierId: supplier, invoiceNumber: 'HALF-1', date: '2026-10-05',
      lines: [
        { lineNo: 1, description: 'existing', quantity: 3, unitPrice: 1, action: 'product', productId: a.id },
        { lineNo: 2, description: 'new one', sku: 'HALF-NEW', quantity: 2, unitPrice: 1, action: 'new' },
        { lineNo: 3, description: 'bad', sku: 'FAIL-ME', quantity: 1, unitPrice: 1, action: 'new' },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await counts()).toEqual(before);
    expect((await product(a.id)).quantity).toBe(1);
    // Not marked as imported: the corrected invoice is accepted without a duplicate warning.
    const match = await admin.post('/api/invoices/match').send({ supplierId: supplier, invoiceNumber: 'HALF-1', lines: [{ lineNo: 1, description: 'existing', quantity: 3 }] });
    expect(match.body.data.duplicates).toEqual([]);
  });

  it('goods receipt with a line that cannot be posted: nothing posted at all', async () => {
    const a = await create({ sku: 'HALF-RCV', name: 'Half receipt', initialQuantity: 1 });
    const inactive = await create({ sku: 'HALF-OFF', name: 'Inactive', status: 'INACTIVE' });
    const before = await counts();
    const res = await admin.post('/api/receipts').send({ date: '2026-10-05', items: [{ productId: a.id, quantity: 5 }, { productId: inactive.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it('the ledger is still consistent', async () => {
    expect(await ledgerProblems()).toEqual({ sums: [], chain: [] });
  });
});

describe('supplier invoice: quantity and the two prices', () => {
  it('new product: quantity, purchase price from the invoice, selling price as entered (or empty)', async () => {
    const res = await admin.post('/api/invoices/commit').send({
      supplierId: supplier, invoiceNumber: 'PRICES-1', date: '2026-10-07',
      lines: [
        { lineNo: 1, description: 'NEW WITH PRICE', sku: 'INV-NEW-1', barcode: '0009998887776', quantity: 15, unitPrice: 12.5, action: 'new', newProduct: { sellingPrice: 19.9 } },
        { lineNo: 2, description: 'NEW WITHOUT PRICE', sku: 'INV-NEW-2', quantity: 3, unitPrice: 0, action: 'new' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const list = (await admin.get('/api/products').query({ q: 'INV-NEW' })).body.data as { sku: string; id: number }[];
    const p1 = await product(list.find((p) => p.sku === 'INV-NEW-1')!.id);
    const p2 = await product(list.find((p) => p.sku === 'INV-NEW-2')!.id);
    expect(p1).toMatchObject({ name: 'NEW WITH PRICE', barcode: '0009998887776', quantity: 15, purchasePrice: 12.5, sellingPrice: 19.9 });
    expect(p2).toMatchObject({ quantity: 3, purchasePrice: 0, sellingPrice: null });
  });

  it('existing product: purchase price updated only when asked; the selling price is never touched', async () => {
    const p = await create({ sku: 'INV-OLD', name: 'Existing', purchasePrice: 10, sellingPrice: 15, initialQuantity: 5 });
    const line = { lineNo: 1, description: 'Existing', quantity: 2, unitPrice: 11, action: 'product', productId: p.id };
    await admin.post('/api/invoices/commit').send({ supplierId: supplier, invoiceNumber: 'PRICES-2', date: '2026-10-07', updatePurchasePrices: false, lines: [line] });
    expect(await product(p.id)).toMatchObject({ quantity: 7, purchasePrice: 10, sellingPrice: 15 });
    await admin.post('/api/invoices/commit').send({ supplierId: supplier, invoiceNumber: 'PRICES-3', date: '2026-10-07', updatePurchasePrices: true, lines: [{ ...line, unitPrice: 11.5 }] });
    expect(await product(p.id)).toMatchObject({ quantity: 9, purchasePrice: 11.5, sellingPrice: 15 });
    // The receipt keeps the invoice's unit cost on its line either way.
    const costs = await getDb().column<number>(
      `SELECT it.unit_cost FROM stock_receipt_items it JOIN stock_receipts r ON r.id = it.receipt_id WHERE r.invoice_number IN ('PRICES-2', 'PRICES-3') ORDER BY r.id`,
    );
    expect(costs).toEqual([11, 11.5]);
  });
});

describe('the same thing sent twice at the same moment is posted once', () => {
  it('two simultaneous imports of the same file adding stock: one adds, the other is warned', async () => {
    const p = await create({ sku: 'SAME-FILE', name: 'Same file', initialQuantity: 0 });
    const body = { rows: [{ rowNumber: 2, sku: 'SAME-FILE', quantity: 10 }], options: { quantityMode: 'add' }, fileHash: 'd'.repeat(64), fileName: 'same.xlsx' };
    // A first import of this file exists (as when it was imported yesterday).
    await getDb().run(`INSERT INTO product_imports (file_name, file_hash, quantity_mode, imported, updated, stock_rows) VALUES ('same.xlsx', ?, 'add', 0, 1, 1)`, 'd'.repeat(64));
    const [r1, r2] = await Promise.all([admin.post('/api/import/products/commit').send(body), admin.post('/api/import/products/commit').send(body)]);
    expect([r1.status, r2.status].sort()).toEqual([409, 409]);
    expect((await product(p.id)).quantity).toBe(0);
    const ok = await Promise.all([
      admin.post('/api/import/products/commit').send({ ...body, fileHash: 'e'.repeat(64) }),
      admin.post('/api/import/products/commit').send({ ...body, fileHash: 'e'.repeat(64) }),
    ]);
    expect(ok.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await product(p.id)).quantity).toBe(10);
  });

  it('the same supplier invoice confirmed twice at the same moment: one receipt', async () => {
    const p = await create({ sku: 'SAME-INV', name: 'Same invoice', initialQuantity: 0 });
    const body = {
      supplierId: supplier, invoiceNumber: 'TWICE-1', date: '2026-10-06',
      lines: [{ lineNo: 1, description: 'Same invoice', quantity: 4, unitPrice: 1, action: 'product', productId: p.id }],
    };
    const res = await Promise.all([admin.post('/api/invoices/commit').send(body), admin.post('/api/invoices/commit').send(body)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await product(p.id)).quantity).toBe(4);
    expect(await getDb().value(`SELECT COUNT(*) FROM stock_receipts WHERE invoice_number = 'TWICE-1'`)).toBe(1);
  });

  it('a price change and a stock movement at the same moment do not overwrite each other', async () => {
    const p = await create({ sku: 'SAME-TIME', name: 'Same time', purchasePrice: 1, initialQuantity: 10 });
    await Promise.all([
      admin.put(`/api/products/${p.id}`).send({ sku: 'SAME-TIME', name: 'Same time', purchasePrice: 2.5 }),
      ...Array.from({ length: 5 }, () => admin.post('/api/stock/scan').send({ productId: p.id, mode: 'IN', quantity: 1 })),
    ]);
    expect(await product(p.id)).toMatchObject({ purchasePrice: 2.5, quantity: 15 });
    expect(await ledgerProblems()).toEqual({ sums: [], chain: [] });
  });
});
