/**
 * Performance and stress check of the built server (production mode), with the built-in
 * database (default) or PostgreSQL (DATABASE_URL). Not part of `npm run e2e`:
 *
 *   npm run build && npx tsx e2e/perf.mts [products=10000]
 *   DATABASE_URL=postgres://user:pass@host/db npx tsx e2e/perf.mts
 *
 * Imports an .xlsx of N products read the way the browser reads it, times the screens'
 * requests, exports and compares every value, repeats scans, and kills the server in the
 * middle of an import to check nothing half-done is left.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { apiLogin, testServer } from './lib.mjs';

Object.assign(globalThis, { document: { documentElement: { lang: 'el' } }, localStorage: { getItem: () => null, setItem: () => {} } });
const { parseSheet, mappingFor } = await import('../client/src/lib/importSheet.ts');

const N = Number(process.argv[2] ?? 10000);
const srv = testServer(Number(process.env.PERF_PORT ?? 4790));
const BASE = srv.base;
const results: string[] = [];
const note = (s: string) => (console.log(s), results.push(s));
let cookie = '';

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(`${BASE}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const out = await fn();
  note(`${label}: ${Math.round(performance.now() - t)} ms`);
  return out;
}
/** Resident memory of the server process (MB). */
function serverMemory(): number {
  const pid = (srv as unknown as { pid?: () => number }).pid?.();
  if (!pid) return NaN;
  const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  return m ? Math.round(Number(m[1]) / 1024) : NaN;
}

interface Item { sku: string; barcode: string | null; quantity: number; purchasePrice: number; sellingPrice: number | null }
const items: Item[] = Array.from({ length: N }, (_, i) => ({
  sku: i % 7 === 0 ? `PERF ΚΩΔ ${i}` : `PERF-${String(i).padStart(6, '0')}`,
  barcode: i % 4 === 3 ? null : `0${String(i).padStart(12, '0')}`,
  quantity: (i % 50) + (i % 3 === 0 ? 0.5 : 1),
  purchasePrice: Math.round((1 + (i % 100) * 0.37) * 100) / 100,
  sellingPrice: i % 6 === 0 ? null : Math.round((2 + (i % 100) * 0.61) * 100) / 100,
}));

async function fileOf(list: Item[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');
  ws.getColumn(1).numFmt = '@';
  ws.getColumn(2).numFmt = '@';
  ws.addRow(['SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price']);
  list.forEach((it, i) => ws.addRow([it.sku, it.barcode, it.quantity, i % 2 ? it.purchasePrice.toFixed(2).replace('.', ',') : it.purchasePrice, it.sellingPrice]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function browserRows(buf: Buffer) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, codepage: 65001 });
  const p = parseSheet(wb, 'perf.xlsx', wb.SheetNames[0]);
  const mapping = mappingFor(p);
  return p.rows.map((r: unknown[], i: number) => {
    const out: Record<string, unknown> = { rowNumber: p.rowNumbers[i] };
    mapping.forEach((f: string, c: number) => f && (out[f] = r[c] ?? null));
    return out;
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-perf-'));
try {
  note(`Database: ${process.env.DATABASE_URL ? 'PostgreSQL server' : 'built-in (PGlite)'}; products: ${N}`);
  await srv.start();
  cookie = await apiLogin(BASE, 'admin', 'admin123');
  note(`Server memory at start: ${serverMemory()} MB`);

  // ---- Import ------------------------------------------------------------------
  const file = await timed(`Excel file of ${N} products written`, () => fileOf(items));
  fs.writeFileSync(path.join(dir, 'perf.xlsx'), file);
  note(`File size: ${(file.length / 1024 / 1024).toFixed(1)} MB`);
  const rows = await timed('File read the browser way (SheetJS + column detection)', async () => browserRows(file));
  const v = await timed(`Validate ${N} rows`, () => api('POST', '/import/products/validate', { rows }));
  if (v.body.data.summary.errors) throw new Error(`validation errors: ${JSON.stringify(v.body.data.rows.filter((r: { status: string }) => r.status === 'error').slice(0, 3))}`);
  const c = await timed(`Import ${N} new products with stock`, () => api('POST', '/import/products/commit', { rows, options: {}, fileName: 'perf.xlsx', fileHash: 'f'.repeat(64) }));
  if (c.body.data.imported !== N) throw new Error(`imported ${JSON.stringify(c.body.data)}`);
  note(`Server memory after import: ${serverMemory()} MB`);

  // ---- Screens -----------------------------------------------------------------
  await timed('Product list, first page of 50 (first request after the import)', () => api('GET', '/products?pageSize=50'));
  await timed('Product list, first page of 50 (again)', () => api('GET', '/products?pageSize=50'));
  await timed('Product list, sorted by stock, page 100', () => api('GET', '/products?pageSize=50&page=100&sort=quantity&dir=desc'));
  await timed('Search a word ("ΚΩΔ")', () => api('GET', '/products?q=ΚΩΔ&pageSize=50'));
  await timed('Search an exact SKU with other spacing', () => api('GET', `/products?q=${encodeURIComponent('perf   κωδ 700')}`));
  await timed('Global search box', () => api('GET', '/search?q=PERF-0099'));
  const lookups = await timed('100 barcode lookups (scanner)', async () => {
    let found = 0;
    for (let i = 0; i < 100; i++) {
      const it = items[(i * 97) % N];
      const r = await api('GET', `/products/lookup?code=${encodeURIComponent(it.barcode ?? it.sku)}`);
      if (r.body.data.length === 1) found++;
    }
    return found;
  });
  note(`  lookups that found exactly one product: ${lookups}/100`);
  await timed('Dashboard', () => api('GET', '/dashboard'));
  await timed('Low stock / inventory valuation report', () => api('GET', '/reports/valuation?groupBy=category'));
  await timed('Inventory screen, stock filter', () => api('GET', '/products?stock=low&pageSize=50'));

  // ---- Export and compare ------------------------------------------------------
  const exp = await timed(`Export ${N} products (five columns)`, () => api('GET', '/export/products?q=PERF'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(exp.body as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Products')!;
  const out = new Map<string, unknown[]>();
  ws.eachRow((row, n) => n > 1 && out.set(String(row.getCell(1).value), [row.getCell(2).value ?? null, row.getCell(3).value, row.getCell(4).value, row.getCell(5).value ?? null]));
  const wrong = items.filter((it) => JSON.stringify(out.get(it.sku)) !== JSON.stringify([it.barcode, it.quantity, it.purchasePrice, it.sellingPrice]));
  note(`Export compared with the imported file: ${out.size} rows, ${wrong.length} differences${wrong.length ? ` e.g. ${JSON.stringify(wrong.slice(0, 2))}` : ''}`);
  if (wrong.length || out.size !== N) throw new Error('export differs');

  const again = browserRows(exp.body as Buffer);
  const v2 = await timed(`Validate the exported file again (${N} existing products)`, () => api('POST', '/import/products/validate', { rows: again }));
  note(`  existing: ${v2.body.data.summary.existing}, new: ${v2.body.data.summary.new}`);
  await timed(`Re-import it, "set the stock" (${N} updates, no movement)`, () => api('POST', '/import/products/commit', { rows: again, options: { quantityMode: 'set' } }));

  // ---- Repeated operations -----------------------------------------------------
  const before = serverMemory();
  await timed('1,000 scans one after the other', async () => {
    for (let i = 0; i < 1000; i++) {
      const r = await api('POST', '/stock/scan', { productId: 1 + (i % 50), mode: Math.floor(i / 50) % 2 ? 'OUT' : 'IN', quantity: 0.5 });
      if (r.status !== 201) throw new Error(`scan ${i}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });
  await timed('200 scans, 20 at a time', async () => {
    for (let k = 0; k < 10; k++)
      await Promise.all(Array.from({ length: 20 }, (_, i) => api('POST', '/stock/scan', { productId: 100 + i, mode: 'IN', quantity: 1 })));
  });
  note(`Server memory before / after 1,200 scans: ${before} / ${serverMemory()} MB`);

  // ---- Interrupted import ------------------------------------------------------
  const count = async () => (await api('GET', '/products?pageSize=1')).body.total as number;
  const productsBefore = await count();
  const big = items.map((it, i) => ({ rowNumber: i + 2, sku: `KILL-${i}`, barcode: null, quantity: 1, purchasePrice: 1 }));
  const pending = api('POST', '/import/products/commit', { rows: big, options: {} }).catch((e) => ({ status: 0, body: String(e) }));
  await new Promise((r) => setTimeout(r, Number(process.env.PERF_KILL_AFTER_MS ?? 700)));
  (srv as unknown as { kill: (s: string) => void }).kill('SIGKILL');
  const killed = await pending;
  note(`Import of ${N} rows interrupted by killing the server (response: ${killed.status || 'connection lost'})`);
  await timed('Server restarted after the crash', () => srv.start());
  cookie = await apiLogin(BASE, 'admin', 'admin123');
  const after = await count();
  note(`Products before / after the interrupted import: ${productsBefore} / ${after} (${after === productsBefore ? 'nothing half-done' : after === productsBefore + N ? 'it had finished before the kill' : 'PARTIAL IMPORT'})`);
  if (after !== productsBefore && after !== productsBefore + N) throw new Error('partial import after crash');
  const ledger = await api('GET', '/products?pageSize=1&q=KILL-1');
  note(`  KILL-* products found after restart: ${ledger.body.total}`);
} finally {
  srv.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(process.env.PERF_REPORT ?? path.join(os.tmpdir(), 'ims-perf.txt'), results.join('\n') + '\n');
}
