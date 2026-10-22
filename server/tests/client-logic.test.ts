/**
 * The browser-side logic of the imports, tested without a browser: numbers typed by people,
 * column detection and row numbers of the Excel import, and reading supplier invoices (sheet
 * and PDF text) into lines.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

// The client modules expect a browser: the little they touch while loading.
Object.assign(globalThis, {
  document: { documentElement: { lang: 'el' } },
  localStorage: { getItem: () => null, setItem: () => {} },
});

// Typed by the client's own project (client/tsconfig.json); loaded here by path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = Record<string, (...args: any[]) => any>;
const load = (name: string): Promise<Mod> => import(/* @vite-ignore */ fileURLToPath(new URL(`../../client/src/lib/${name}.ts`, import.meta.url)));
let format: Mod;
let sheet: Mod;
let inv: Mod;
type Source = Record<string, unknown>;

beforeAll(async () => {
  [format, sheet, inv] = await Promise.all([load('format'), load('importSheet'), load('invoiceFile')]);
});

describe('numbers typed in the forms (product, stock, documents, counts, invoices)', () => {
  it.each([
    ['12.50', 12.5],
    ['12,50', 12.5],
    ['1,250.50', 1250.5],
    ['1.250,50', 1250.5],
    ['1.250.000', 1250000],
    ['1,250,000', 1250000],
    ['€ 1.250,50', 1250.5],
    ['0', 0],
    ['0,00', 0],
    ['15', 15],
    [' 7 ', 7],
    ['.5', 0.5],
  ])('%j → %d', (text, value) => {
    expect(format.parseDecimal(text)).toBe(value);
  });

  it.each(['', 'abc', '12,5,0', '1,2,3.4', '1.2.3', '12a', '--1'])('%j is not a number', (text) => {
    expect(format.parseDecimal(text)).toBeNaN();
  });
});

describe('Excel import: which column is which', () => {
  it('the standard five columns, in English and in Greek', () => {
    expect(sheet.autoMap(['SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price'])).toEqual(['sku', 'barcode', 'quantity', 'purchasePrice', 'sellingPrice']);
    expect(sheet.autoMap(['Κωδικός', 'Barcode', 'Ποσότητα', 'Τιμή Αγοράς', 'Τιμή Πώλησης'])).toEqual(['sku', 'barcode', 'quantity', 'purchasePrice', 'sellingPrice']);
    expect(sheet.autoMap(['ΚΩΔΙΚΟΣ', 'BARCODE', 'ΤΕΜΑΧΙΑ', 'ΤΙΜΗ ΚΟΣΤΟΥΣ', 'ΛΙΑΝΙΚΗ'])).toEqual(['sku', 'barcode', 'quantity', 'purchasePrice', 'sellingPrice']);
  });

  it('titles written without the final sigma, in Greeklish, or with extra words', () => {
    expect(sheet.autoMap(['κωδικοσ', 'temaxia', 'Τιμή αγοράσ (€)'])).toEqual(['sku', 'quantity', 'purchasePrice']);
    expect(sheet.autoMap(['Code', 'Name', 'Qty', 'Unit Cost', 'Unit Price', 'Minimum Stock Level'])).toEqual(['sku', 'name', 'quantity', 'purchasePrice', 'sellingPrice', 'minStock']);
  });

  it('totals, values, discounts and percentages are never a quantity or a price', () => {
    expect(sheet.autoMap(['SKU', 'Ποσότητα', 'Τιμή', 'Σύνολο', 'Έκπτωση %', 'Ποσοστό ΦΠΑ', 'Line Total', 'Stock Value'])).toEqual(['sku', 'quantity', 'sellingPrice', '', '', '', '', '']);
    expect(sheet.autoMap(['Total Price', 'Total Cost', 'Amount'])).toEqual(['', '', '']);
  });

  const book = (rows: unknown[][], origin = 'A1') => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.sheet_add_aoa(ws, rows, { origin });
    XLSX.utils.book_append_sheet(wb, ws, 'Products');
    return wb;
  };

  it('row numbers are the Excel row numbers, also with empty rows and a title above', () => {
    const wb = book([
      ['Stock list October'],
      [],
      ['SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price'],
      ['A 1', '0012345', 5, 1.5, null],
      [],
      [],
      ['B 2', null, '3', '2,50', '4,90'],
    ]);
    const p = sheet.parseSheet(wb, 'x.xlsx', 'Products');
    expect(p.noHeader).toBe(false);
    expect(p.headers).toEqual(['SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price']);
    expect(p.rows.map((r: unknown[]) => r[0])).toEqual(['A 1', 'B 2']);
    expect(p.rowNumbers).toEqual([4, 7]);
    expect(sheet.mappingFor(p)).toEqual(['sku', 'barcode', 'quantity', 'purchasePrice', 'sellingPrice']);
  });

  it('a sheet that starts lower down keeps its real row numbers', () => {
    const p = sheet.parseSheet(book([['SKU', 'Quantity'], ['C 3', 9]], 'B5'), 'x.xlsx', 'Products');
    expect(p.rowNumbers).toEqual([6]);
  });

  it('a file without titles is read by position (A SKU … E Selling Price); a title line above is not a product', () => {
    const p = sheet.parseSheet(book([['My stock'], ['ΧΑΡΤΙ  A4', '0012345678905', 10, '3,90', null], ['cola-330', null, 5, null, 0.9]]), 'x.xlsx', 'Products');
    expect(p.noHeader).toBe(true);
    expect(sheet.mappingFor(p)).toEqual(['sku', 'barcode', 'quantity', 'purchasePrice', 'sellingPrice']);
    expect(p.rows.map((r: unknown[]) => r[0])).toEqual(['ΧΑΡΤΙ  A4', 'cola-330']);
    expect(p.rowNumbers).toEqual([2, 3]);
  });
});

describe('supplier invoices: reading the lines', () => {
  const sheetSource = (rows: (string | number | null)[][]) =>
    ({ kind: 'sheet', fileName: 'i.xlsx', hash: 'h', sheets: ['S'], sheet: 'S', rows, lines: [] }) as Source;

  it('finds the header under the invoice heading and suggests the columns from the titles', () => {
    const src = sheetSource([
      ['ΤΙΜΟΛΟΓΙΟ ΠΩΛΗΣΗΣ Α-100'],
      ['Ημερομηνία', '20/10/2026'],
      ['Κωδικός', 'Περιγραφή', 'Ποσότητα', 'Τιμή', 'Έκπτ.%', 'Αξία'],
      ['C-330', 'COLA  330ML', '24', '0,35', null, '8,40'],
      ['K-194', 'ΚΑΦΕΣ ΕΛΛΗΝΙΚΟΣ 194G', '1.200', '2,10', '10,00', '2.268,00'],
      [null, 'συνέχεια περιγραφής', null, null, null, null],
      ['', 'Σύνολο', null, null, null, '2.276,40'],
    ]);
    const header = inv.findHeader(src);
    expect(header).toBe(2);
    const table = inv.buildTable(src, header);
    const mapping = inv.suggestColumns(table.headers);
    expect(mapping).toEqual(['sku', 'description', 'quantity', 'unitPrice', '', 'lineTotal']);
    const lines = inv.extractLines(table, mapping, true);
    // The total line has no quantity: not an item. The wrapped description joins its line.
    expect(lines.map((l: Source) => [l.sku, l.description, l.quantity, l.unitPrice, l.lineTotal])).toEqual([
      ['C-330', 'COLA  330ML', '24', '0.35', '8.40'],
      ['K-194', 'ΚΑΦΕΣ ΕΛΛΗΝΙΚΟΣ 194G συνέχεια περιγραφής', '1200', '2.10', '2268.00'],
    ]);
    expect(lines.map((l: Source) => l.sourceRow)).toEqual([4, 5]);
  });

  it('decimal comma or dot is decided per invoice', () => {
    expect(inv.decimalCommaOf(['1.200', '2,10'])).toBe(true);
    expect(inv.decimalCommaOf(['1,200', '2.10'])).toBe(false);
    expect(inv.plainNumber('1.250,50', true)).toBe('1250.50');
    expect(inv.plainNumber('1,250.50', false)).toBe('1250.50');
    expect(inv.plainNumber('12,50', true)).toBe('12.50');
  });

  it('PDF text: pieces on one line are grouped, and right-aligned numbers stay in their column', () => {
    const f = (text: string, x: number, y: number, w = text.length * 5) => ({ text, x, y, w, h: 9 });
    const lines = inv.groupLines([
      f('Κωδικός', 40, 700), f('Περιγραφή', 110, 700), f('Ποσότητα', 300, 700), f('Τιμή', 380, 700), f('Αξία', 450, 700),
      f('C-330', 40, 680), f('COLA 330ML', 110, 680), f('24', 330, 680.5), f('0,35', 392, 680), f('8,40', 455, 679.8),
      f('W500', 40, 660), f('ΝΕΡΟ 500ML', 110, 660), f('48', 330, 660), f('0,18', 392, 660), f('8,64', 455, 660),
    ]);
    expect(lines).toHaveLength(3);
    const src = { kind: 'pdf', fileName: 'i.pdf', hash: 'h', sheets: [], sheet: null, rows: [], lines } as Source;
    const table = inv.buildTable(src, inv.findHeader(src));
    const mapping = inv.suggestColumns(table.headers);
    const out = inv.extractLines(table, mapping, false);
    expect(out.map((l: Source) => [l.sku, l.description, l.quantity, l.unitPrice, l.lineTotal])).toEqual([
      ['C-330', 'COLA 330ML', '24', '0.35', '8.40'],
      ['W500', 'ΝΕΡΟ 500ML', '48', '0.18', '8.64'],
    ]);
  });
});
