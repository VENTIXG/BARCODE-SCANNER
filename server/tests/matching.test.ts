/**
 * SKUs and descriptions with spaces, the optional selling price, and the five-column Excel
 * file (SKU | Barcode Number | Quantity | Purchase Price | Selling Price).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { createApp } from '../src/app.js';
import { getDb, initDb } from '../src/db/index.js';

const app = createApp();
const admin = request.agent(app);

async function create(body: Record<string, unknown>) {
  const res = await admin.post('/api/products').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: number; sku: string; barcode: string | null; name: string; quantity: number; purchasePrice: number; sellingPrice: number | null };
}
const product = async (id: number) => (await admin.get(`/api/products/${id}`)).body.data;

beforeAll(async () => {
  await initDb();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
});

describe('SKUs and barcodes with spaces', () => {
  let id = 0;
  it('stores an SKU with inner spaces exactly as typed (only the ends are trimmed)', async () => {
    const p = await create({ sku: '  ΑΒ  12 X ', name: 'Προϊόν   με  κενά', initialQuantity: 10 });
    id = p.id;
    expect(p.sku).toBe('ΑΒ  12 X');
    expect(p.name).toBe('Προϊόν   με  κενά');
  });

  it('refuses a second product whose SKU differs only in spacing or letter case', async () => {
    const res = await admin.post('/api/products').send({ sku: 'αβ 12   x', name: 'Duplicate' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_SKU');
    expect((await admin.get('/api/products/check-unique').query({ sku: 'ΑΒ 12 X' })).body.sku.id).toBe(id);
  });

  it('refuses tabs and line breaks in an SKU', async () => {
    expect((await admin.post('/api/products').send({ sku: 'A\tB', name: 'Tab' })).status).toBe(400);
  });

  it('scanner lookup, search and scan find it with any spacing', async () => {
    expect((await admin.get('/api/products/lookup').query({ code: 'αβ 12 x' })).body.data.map((p: { id: number }) => p.id)).toEqual([id]);
    expect((await admin.get('/api/products').query({ q: 'ΑΒ 12   X' })).body.data[0].id).toBe(id);
    expect((await admin.get('/api/products').query({ q: 'προϊον με κενα' })).body.data[0].id).toBe(id);
    const scan = await admin.post('/api/stock/scan').send({ code: 'ΑΒ 12 X', mode: 'OUT', quantity: 2 });
    expect(scan.status, JSON.stringify(scan.body)).toBe(201);
    expect(scan.body.data.product.quantity).toBe(8);
  });

  it('keeps leading zeros and spaces of a barcode; a scan without the spaces finds it', async () => {
    const p = await create({ sku: 'LZ-1', barcode: '0012 3456 7890', name: 'Leading zeros' });
    expect(p.barcode).toBe('0012 3456 7890');
    expect((await admin.get('/api/products/lookup').query({ code: '001234567890' })).body.data[0].id).toBe(p.id);
  });
});

describe('selling price next to purchase price', () => {
  it('is empty when not given, and never overwrites the purchase price', async () => {
    const p = await create({ sku: 'SP-1', name: 'No selling price', purchasePrice: 3.2 });
    expect(p.sellingPrice).toBeNull();
    expect(p.purchasePrice).toBe(3.2);
    const full = await product(p.id);
    const put = (body: Record<string, unknown>) =>
      admin.put(`/api/products/${p.id}`).send({ sku: full.sku, name: full.name, unit: full.unit, purchasePrice: 3.2, ...body });
    expect((await put({ sellingPrice: 4.5 })).body.data).toMatchObject({ sellingPrice: 4.5, purchasePrice: 3.2 });
    // Left out of an update: kept.
    expect((await put({})).body.data.sellingPrice).toBe(4.5);
    // Cleared on purpose.
    expect((await put({ sellingPrice: null })).body.data).toMatchObject({ sellingPrice: null, purchasePrice: 3.2 });
  });
});

describe('Excel import with SKU | Barcode Number | Quantity | Purchase Price | Selling Price', () => {
  const rows = [
    // A new product with spaces in its SKU; no name column, no selling price.
    { rowNumber: 2, sku: 'NEW  ITEM 1', barcode: '00123', quantity: '5', purchasePrice: '1,20' },
    // An existing SKU written with other spacing and letter case: updates that product.
    { rowNumber: 3, sku: 'αβ 12 x', barcode: null, quantity: 4, purchasePrice: null, sellingPrice: '9,90' },
    // The SKU column holds an existing product's description.
    { rowNumber: 4, sku: 'PROIÓN ME', barcode: null, quantity: 1 },
    { rowNumber: 5, sku: 'DESCRIPTION MATCH  product', barcode: null, quantity: 1 },
    // Barcode typed as a number in Excel: imported, with a warning about lost zeros.
    { rowNumber: 6, sku: 'NUM-BC', barcode: 5201234567890, quantity: 2, purchasePrice: 2 },
  ];

  it('validates: matches by SKU with any spacing and by description; new names come from the SKU column', async () => {
    await create({ sku: 'DESC-1', name: 'Description  match product', purchasePrice: 7 });
    const res = await admin.post('/api/import/products/validate').send({ rows });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byRow = new Map(res.body.data.rows.map((r: { rowNumber: number }) => [r.rowNumber, r]));
    expect(byRow.get(2)).toMatchObject({ status: 'new' });
    expect(byRow.get(3)).toMatchObject({ status: 'existing', match: { sku: 'ΑΒ  12 X', matchedBy: 'sku' } });
    // "PROIÓN ME" is not the name of any product: a new one (similar names are never merged).
    expect(byRow.get(4)).toMatchObject({ status: 'new' });
    expect(byRow.get(5), JSON.stringify(byRow.get(5))).toMatchObject({ status: 'existing', match: { sku: 'DESC-1', matchedBy: 'name' } });
    expect((byRow.get(6) as { warnings: string[] }).warnings.join(' ')).toMatch(/leading zeros/);
  });

  it('two products with the same description are not guessed: the row asks for the SKU', async () => {
    const res = await admin.post('/api/import/products/validate').send({ rows: [{ rowNumber: 2, sku: 'no selling price', quantity: 1 }] });
    await create({ sku: 'SP-2', name: 'No  selling price' });
    const again = await admin.post('/api/import/products/validate').send({ rows: [{ rowNumber: 2, sku: 'no selling price', quantity: 1 }] });
    expect(res.body.data.rows[0]).toMatchObject({ status: 'existing', match: { sku: 'SP-1' } });
    expect(again.body.data.rows[0]).toMatchObject({ status: 'error' });
    expect(again.body.data.rows[0].errors[0]).toMatch(/Several products have this description \(SP-1, SP-2\)/);
  });

  it('flags the same SKU twice in a file, also with different spacing', async () => {
    const res = await admin.post('/api/import/products/validate').send({
      rows: [
        { rowNumber: 2, sku: 'DUP  1', quantity: 1 },
        { rowNumber: 3, sku: 'dup 1', quantity: 1 },
      ],
    });
    expect(res.body.data.rows[1]).toMatchObject({ status: 'error' });
    expect(res.body.data.rows[1].errors[0]).toMatch(/Duplicate SKU in file/);
  });

  it('commits: quantities and prices go to the right products; missing selling price stays empty', async () => {
    const before = (await admin.get('/api/products').query({ q: 'ΑΒ 12 X' })).body.data[0];
    const res = await admin
      .post('/api/import/products/commit')
      .send({ rows, options: { duplicateStrategy: 'update', quantityMode: 'add', createMissing: true }, fileName: 'stock.xlsx' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ imported: 3, updated: 2, errors: 0 });

    const created = (await admin.get('/api/products').query({ q: 'NEW  ITEM 1' })).body.data[0];
    expect(created).toMatchObject({ sku: 'NEW  ITEM 1', name: 'NEW  ITEM 1', barcode: '00123', quantity: 5, purchasePrice: 1.2, sellingPrice: null });

    const updated = await product(before.id);
    // SKU kept as stored, selling price set, purchase price untouched, 4 added to stock.
    expect(updated).toMatchObject({ sku: 'ΑΒ  12 X', sellingPrice: 9.9, purchasePrice: before.purchasePrice, quantity: before.quantity + 4 });

    const desc = (await admin.get('/api/products').query({ q: 'DESC-1' })).body.data[0];
    expect(desc).toMatchObject({ sellingPrice: null, purchasePrice: 7, quantity: 1 });
    expect((await admin.get('/api/products').query({ q: 'NUM-BC' })).body.data[0].barcode).toBe('5201234567890');
  });

  it('exports the five columns in order, codes as text', async () => {
    const res = await admin.get('/api/export/products').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Products')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price']);
    const rowsBySku = new Map<string, unknown[]>();
    ws.eachRow((row, n) => {
      if (n > 1) rowsBySku.set(String(row.getCell(1).value), row.values as unknown[]);
    });
    expect(rowsBySku.get('NEW  ITEM 1')).toEqual([undefined, 'NEW  ITEM 1', '00123', 5, 1.2]);
    expect(rowsBySku.get('LZ-1')?.[2]).toBe('0012 3456 7890');
    expect(ws.getColumn(1).numFmt).toBe('@');
    expect(ws.getColumn(2).numFmt).toBe('@');
    // The earlier, longer layout is still available.
    expect((await admin.get('/api/export/products-full')).status).toBe(200);
    expect((await admin.get('/api/import/template')).status).toBe(200);
  });

  it('keeps the database consistent: one normalized key per SKU', async () => {
    const dup = await getDb().value('SELECT COUNT(*) FROM (SELECT ims_key(sku::text) FROM products GROUP BY 1 HAVING COUNT(*) > 1) d');
    expect(dup).toBe(0);
  });
});
