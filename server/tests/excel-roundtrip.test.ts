/**
 * Excel round trip with real files: an .xlsx of 1, 10, 100 and 1,000 products is read the way
 * the browser reads it, imported, exported again, and every one of the five columns (SKU,
 * Barcode Number, Quantity, Purchase Price, Selling Price) is compared with what was imported.
 * Re-importing the exported file changes nothing.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { createApp } from '../src/app.js';
import { getDb, initDb } from '../src/db/index.js';

Object.assign(globalThis, {
  document: { documentElement: { lang: 'el' } },
  localStorage: { getItem: () => null, setItem: () => {} },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sheet: Record<string, (...args: any[]) => any>;

const app = createApp();
const admin = request.agent(app);

interface Item { sku: string; barcode: string | null; quantity: number; purchasePrice: number; sellingPrice: number | null }

/** Products like real ones: spaces, leading zeros, Greek, decimals, missing selling prices. */
function items(n: number, prefix: string): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    sku: i % 7 === 0 ? `${prefix} ΚΩΔ ${i}` : i % 5 === 0 ? `${prefix}-${String(i).padStart(6, '0')} XL` : `${prefix}${i}`,
    barcode: i % 4 === 3 ? null : `0${String(prefix.length * 1000 + Number(prefix.replace(/\D/g, ''))).padStart(5, '0')}${String(i).padStart(7, '0')}`,
    quantity: i % 9 === 0 ? 0 : (i % 50) + 1 + (i % 3 === 0 ? 0.5 : 0),
    purchasePrice: Math.round((1 + (i % 100) * 0.37) * 100) / 100,
    sellingPrice: i % 6 === 0 ? null : Math.round((2 + (i % 100) * 0.61) * 100) / 100,
  }));
}

/** The file as people make it: text codes, prices as numbers or as "12,50" text. */
async function xlsxOf(list: Item[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');
  ws.getColumn(1).numFmt = '@';
  ws.getColumn(2).numFmt = '@';
  ws.addRow(['SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price']);
  list.forEach((it, i) =>
    ws.addRow([
      it.sku,
      it.barcode,
      it.quantity,
      i % 2 ? String(it.purchasePrice.toFixed(2)).replace('.', ',') : it.purchasePrice,
      it.sellingPrice,
    ]),
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** What the import page sends, from the file. */
function browserRows(buf: Buffer) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, codepage: 65001 });
  const parsed = sheet.parseSheet(wb, 'file.xlsx', wb.SheetNames[0]);
  const mapping = sheet.mappingFor(parsed) as string[];
  return (parsed.rows as unknown[][]).map((r, i) => {
    const out: Record<string, unknown> = { rowNumber: parsed.rowNumbers[i] };
    mapping.forEach((f, c) => f && (out[f] = r[c] === undefined ? null : r[c]));
    return out;
  });
}

async function exportFile(q: string) {
  const res = await admin
    .get('/api/export/products')
    .query({ q })
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return res.body as Buffer;
}

async function exported(buf: Buffer): Promise<Map<string, Item>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Products')!;
  expect(ws.getRow(1).values).toEqual([undefined, 'SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price']);
  const out = new Map<string, Item>();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = (c: number) => row.getCell(c).value;
    out.set(String(v(1)), { sku: String(v(1)), barcode: (v(2) as string) ?? null, quantity: v(3) as number, purchasePrice: v(4) as number, sellingPrice: (v(5) as number) ?? null });
  });
  return out;
}

beforeAll(async () => {
  sheet = await import(/* @vite-ignore */ fileURLToPath(new URL('../../client/src/lib/importSheet.ts', import.meta.url)));
  await initDb();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'admin123' })).status).toBe(200);
});

describe.each([1, 10, 100, 1000])('%i products', (n) => {
  const prefix = `RT${n}X`;
  const list = items(n, prefix);

  it('import → export: every product, every one of the five values', async () => {
    const rows = browserRows(await xlsxOf(list));
    expect(rows).toHaveLength(n);
    const v = await admin.post('/api/import/products/validate').send({ rows });
    expect(v.body.data.summary, JSON.stringify(v.body.data.rows.filter((r: { status: string }) => r.status === 'error'))).toMatchObject({ total: n, new: n, errors: 0 });
    const c = await admin.post('/api/import/products/commit').send({ rows, options: {}, fileName: `${n}.xlsx` });
    expect(c.body.data).toMatchObject({ imported: n, errors: 0 });

    const out = await exported(await exportFile(prefix));
    expect(out.size).toBe(n);
    for (const it of list) expect(out.get(it.sku), it.sku).toEqual(it);
    // The database holds the same (not only the file).
    const db = await getDb().all<{ sku: string; quantity: number; purchase_price: number; selling_price: number | null }>(
      `SELECT p.sku::text AS sku, COALESCE(i.quantity, 0) AS quantity, p.purchase_price, p.selling_price
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.sku::text LIKE ?`,
      `${prefix}%`,
    );
    const bySku = new Map(db.map((r) => [r.sku, r]));
    for (const it of list) expect([bySku.get(it.sku)?.quantity, bySku.get(it.sku)?.purchase_price, bySku.get(it.sku)?.selling_price], it.sku).toEqual([it.quantity, it.purchasePrice, it.sellingPrice]);
  });

  it('re-importing the exported file finds every product and changes nothing', async () => {
    const rows = browserRows(await exportFile(prefix));
    const v = await admin.post('/api/import/products/validate').send({ rows });
    expect(v.body.data.summary).toMatchObject({ total: n, new: 0, existing: n, errors: 0 });
    const before = await getDb().value('SELECT COUNT(*) FROM inventory_transactions');
    const c = await admin.post('/api/import/products/commit').send({ rows, options: { quantityMode: 'set' } });
    expect(c.body.data).toMatchObject({ imported: 0, updated: n, errors: 0 });
    // Setting stock to what it already is posts no movement.
    expect(await getDb().value('SELECT COUNT(*) FROM inventory_transactions')).toBe(before);
    const out = await exported(await exportFile(prefix));
    for (const it of list) expect(out.get(it.sku), it.sku).toEqual(it);
  });
});
