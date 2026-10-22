/**
 * Quantity, purchase price and selling price from the Excel import: saved for new products,
 * and for existing products only by an explicit rule (add / set / leave), never dropped
 * silently and never added twice from the same file unnoticed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getDb, initDb } from '../src/db/index.js';
import { numberStyleOf, parseNumber } from '../src/lib/importer.js';

const app = createApp();
const admin = request.agent(app);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** The row the import page sends for the five-column file. */
const abc = (over: Record<string, unknown> = {}) => ({
  rowNumber: 2,
  sku: 'ABC 123',
  barcode: '5201234567890',
  quantity: 15,
  purchasePrice: 12.5,
  sellingPrice: 19.9,
  ...over,
});
const validate = async (rows: Record<string, unknown>[], fileHash?: string) => {
  const res = await admin.post('/api/import/products/validate').send({ rows, fileHash });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
const commit = (rows: Record<string, unknown>[], options: Record<string, unknown> = {}, fileHash?: string) =>
  admin.post('/api/import/products/commit').send({ rows, options, fileHash, fileName: 'stock.xlsx' });
const bySku = async (sku: string) => {
  const list = (await admin.get('/api/products').query({ q: sku })).body.data as { id: number; sku: string }[];
  const p = list.find((x) => x.sku === sku);
  return p ? (await admin.get(`/api/products/${p.id}`)).body.data : null;
};
const five = (p: { sku: string; barcode: string; quantity: number; purchasePrice: number; sellingPrice: number | null }) => [
  p.sku,
  p.barcode,
  p.quantity,
  p.purchasePrice,
  p.sellingPrice,
];
const movements = async (id: number) =>
  (await getDb().all<{ type: string; quantity: number }>('SELECT type, ABS(quantity_change) AS quantity FROM inventory_transactions WHERE product_id = ? ORDER BY id', id)).map(
    (m) => `${m.type} ${m.quantity}`,
  );

beforeAll(async () => {
  await initDb();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
});

describe('new product: all five values saved', () => {
  it('ABC 123 | 5201234567890 | 15 | 12.50 | 19.90', async () => {
    const v = await validate([abc()]);
    expect(v.summary).toMatchObject({ total: 1, new: 1, existing: 0, errors: 0 });
    const res = await commit([abc()]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ imported: 1, updated: 0, errors: 0 });

    // Read back from the database (as after refreshing the application).
    const p = await bySku('ABC 123');
    expect(five(p)).toEqual(['ABC 123', '5201234567890', 15, 12.5, 19.9]);
    expect(await movements(p.id)).toEqual(['INITIAL_STOCK 15']);
    // The list (inventory screen) and the scanner give the same values.
    const listed = (await admin.get('/api/products').query({ q: '5201234567890' })).body.data[0];
    expect(five(listed)).toEqual(['ABC 123', '5201234567890', 15, 12.5, 19.9]);
    expect((await admin.get('/api/products/lookup').query({ code: '5201234567890' })).body.data[0].id).toBe(p.id);
  });

  it('text cells with a decimal comma or dot: 12,50 and 12.50 are both 12.5', async () => {
    const rows = [
      { rowNumber: 2, sku: 'DEC-COMMA', quantity: '7', purchasePrice: '12,50', sellingPrice: '€ 19,90' },
      { rowNumber: 3, sku: 'DEC-DOT', quantity: '3', purchasePrice: '12.50', sellingPrice: '19.90' },
    ];
    expect((await commit(rows)).body.data).toMatchObject({ imported: 2, errors: 0 });
    expect(five(await bySku('DEC-COMMA')).slice(2)).toEqual([7, 12.5, 19.9]);
    expect(five(await bySku('DEC-DOT')).slice(2)).toEqual([3, 12.5, 19.9]);
  });

  it('a missing selling price stays empty; it is never taken from the purchase price', async () => {
    expect((await commit([{ rowNumber: 2, sku: 'NO-SELL', quantity: 2, purchasePrice: 4.2, sellingPrice: null }])).body.data.imported).toBe(1);
    expect(five(await bySku('NO-SELL')).slice(2)).toEqual([2, 4.2, null]);
  });
});

describe('existing product: the rules', () => {
  it('validation shows the stock and prices now, next to the file', async () => {
    const v = await validate([abc({ quantity: 5 })]);
    expect(v.summary).toMatchObject({ existing: 1, existingWithQuantity: 1 });
    expect(v.rows[0].match).toMatchObject({ sku: 'ABC 123', current: { quantity: 15, purchasePrice: 12.5, sellingPrice: 19.9 } });
  });

  it('quantities are never dropped silently: without a choice nothing is imported', async () => {
    const res = await commit([abc({ quantity: 5, purchasePrice: 13 })]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('QUANTITY_MODE_REQUIRED');
    expect(five(await bySku('ABC 123'))).toEqual(['ABC 123', '5201234567890', 15, 12.5, 19.9]);
  });

  it('"leave stock": prices are updated (existing products are updated by default), stock stays', async () => {
    const res = await commit([abc({ quantity: 5, purchasePrice: 13, sellingPrice: 21 })], { quantityMode: 'ignore' });
    expect(res.body.data).toMatchObject({ updated: 1, skipped: 0 });
    expect(five(await bySku('ABC 123'))).toEqual(['ABC 123', '5201234567890', 15, 13, 21]);
  });

  it('"add to stock" (a delivery): 15 + 5 = 20, recorded as stock in', async () => {
    const res = await commit([abc({ quantity: 5, purchasePrice: 12.5, sellingPrice: 19.9 })], { quantityMode: 'add' });
    expect(res.body.data).toMatchObject({ updated: 1 });
    const p = await bySku('ABC 123');
    expect(five(p)).toEqual(['ABC 123', '5201234567890', 20, 12.5, 19.9]);
    expect(await movements(p.id)).toEqual(['INITIAL_STOCK 15', 'STOCK_IN 5']);
  });

  it('"set stock" (a count): the stock becomes the file quantity, recorded as an adjustment', async () => {
    await commit([abc({ quantity: 12 })], { quantityMode: 'set' });
    const p = await bySku('ABC 123');
    expect(p.quantity).toBe(12);
    expect((await movements(p.id)).at(-1)).toBe('ADJUSTMENT_MINUS 8');
    // Setting the same count again changes nothing (no double counting).
    await commit([abc({ quantity: 12 })], { quantityMode: 'set' });
    expect((await bySku('ABC 123')).quantity).toBe(12);
    expect((await movements(p.id)).length).toBe(3);
  });

  it('empty price cells keep the stored prices; the two prices are independent', async () => {
    await commit([abc({ quantity: null, purchasePrice: null, sellingPrice: 24.5 })], { quantityMode: 'add' });
    expect(five(await bySku('ABC 123')).slice(2)).toEqual([12, 12.5, 24.5]);
    await commit([abc({ quantity: null, purchasePrice: 11, sellingPrice: null })]);
    expect(five(await bySku('ABC 123')).slice(2)).toEqual([12, 11, 24.5]);
  });

  it('found by barcode (other SKU spelling) or by SKU with other spacing: the same product is updated', async () => {
    await commit([abc({ sku: 'abc   123', quantity: 3, purchasePrice: 12.5, sellingPrice: 19.9 })], { quantityMode: 'add' });
    const p = await bySku('ABC 123');
    expect(five(p)).toEqual(['ABC 123', '5201234567890', 15, 12.5, 19.9]);
    const count = await getDb().value<number>("SELECT COUNT(*) FROM products WHERE ims_compact(barcode::text) = '5201234567890'");
    expect(count).toBe(1);
  });

  it('"skip" chosen on purpose leaves the existing product as it is', async () => {
    const res = await commit([abc({ quantity: 99, purchasePrice: 99, sellingPrice: 99 })], { duplicateStrategy: 'skip' });
    expect(res.body.data).toMatchObject({ skipped: 1, updated: 0 });
    expect(five(await bySku('ABC 123')).slice(2)).toEqual([15, 12.5, 19.9]);
  });
});

describe('the same file is not added to stock twice unnoticed', () => {
  const rows = [{ rowNumber: 2, sku: 'DELIVERY-1', barcode: '0001112223334', quantity: 10, purchasePrice: 2.5, sellingPrice: 4 }];

  it('first import of the file: new product with its stock', async () => {
    expect((await validate(rows, HASH_A)).previousImports).toEqual([]);
    expect((await commit(rows, {}, HASH_A)).body.data.imported).toBe(1);
    expect((await bySku('DELIVERY-1')).quantity).toBe(10);
  });

  it('the same file again: validation says so, and adding needs confirmation', async () => {
    const v = await validate(rows, HASH_A);
    expect(v.previousImports).toHaveLength(1);
    expect(v.previousImports[0]).toMatchObject({ fileName: 'stock.xlsx', imported: 1, stockRows: 1, username: 'admin' });
    const res = await commit(rows, { quantityMode: 'add' }, HASH_A);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_IMPORT');
    expect((await bySku('DELIVERY-1')).quantity).toBe(10);
    // Confirmed: added again.
    expect((await commit(rows, { quantityMode: 'add', allowDuplicate: true }, HASH_A)).status).toBe(200);
    expect((await bySku('DELIVERY-1')).quantity).toBe(20);
  });

  it('setting stock from the same file is safe to repeat; another file adds normally', async () => {
    expect((await commit(rows, { quantityMode: 'set' }, HASH_A)).status).toBe(200);
    expect((await bySku('DELIVERY-1')).quantity).toBe(10);
    expect((await commit(rows, { quantityMode: 'add' }, HASH_B)).status).toBe(200);
    expect((await bySku('DELIVERY-1')).quantity).toBe(20);
  });
});

describe('numbers written as text', () => {
  it('the decimal separator is taken from the file', () => {
    const comma = numberStyleOf([{ rowNumber: 2, purchasePrice: '12,50', quantity: '1.250' }]);
    expect(comma).toBe('comma');
    expect(parseNumber('1.250', comma)).toBe(1250);
    expect(parseNumber('1.234,56', comma)).toBe(1234.56);
    expect(parseNumber('12.50', comma)).toBe(12.5);
    const dot = numberStyleOf([{ rowNumber: 2, purchasePrice: '12.50', quantity: '1,250' }]);
    expect(dot).toBe('dot');
    expect(parseNumber('1,250', dot)).toBe(1250);
    expect(parseNumber('12,5', dot)).toBe(12.5);
    // Both styles in one file, or neither: every value read by itself, as before.
    expect(numberStyleOf([{ rowNumber: 2, purchasePrice: '12,50', sellingPrice: '19.90' }])).toBeNull();
    expect(numberStyleOf([{ rowNumber: 2, purchasePrice: 12.5, quantity: 3 }])).toBeNull();
    expect(parseNumber('19,90')).toBe(19.9);
    expect(parseNumber(15)).toBe(15);
  });

  it('a Greek-format file: 1.250 pieces at 2,10 are 1250 pieces', async () => {
    const res = await commit([
      { rowNumber: 2, sku: 'GR-1', quantity: '1.250', purchasePrice: '2,10', sellingPrice: '3,50' },
      { rowNumber: 3, sku: 'GR-2', quantity: '2', purchasePrice: '1.234,50', sellingPrice: null },
    ]);
    expect(res.body.data).toMatchObject({ imported: 2, errors: 0 });
    expect(five(await bySku('GR-1')).slice(2)).toEqual([1250, 2.1, 3.5]);
    expect(five(await bySku('GR-2')).slice(2)).toEqual([2, 1234.5, null]);
  });
});
