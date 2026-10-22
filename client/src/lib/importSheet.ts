/**
 * Reading a product sheet for the Excel import: which row holds the titles, which column is
 * which field, and the Excel row number of every data row (for messages that point at the
 * right row, also when the file has empty rows).
 */
import * as XLSX from 'xlsx';

export const FIELDS = [
  { key: 'sku', label: 'SKU', required: true },
  { key: 'barcode', label: 'Barcode' },
  { key: 'name', label: 'Product Name', required: true },
  { key: 'description', label: 'Description' },
  { key: 'category', label: 'Category' },
  { key: 'supplier', label: 'Supplier' },
  { key: 'unit', label: 'Unit' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'minStock', label: 'Minimum Stock' },
  { key: 'location', label: 'Location' },
  { key: 'purchasePrice', label: 'Purchase Price' },
  { key: 'sellingPrice', label: 'Selling Price' },
  { key: 'status', label: 'Status' },
] as const;
export type FieldKey = (typeof FIELDS)[number]['key'];

/** Header synonyms (English + Greek) used for automatic column detection. */
const SYNONYMS: Record<FieldKey, string[]> = {
  sku: ['sku', 'code', 'item code', 'product code', 'article', 'κωδικος', 'κωδικος ειδους', 'κωδ', 'κωδικος προιοντος'],
  barcode: ['barcode', 'barcode number', 'bar code', 'ean', 'ean13', 'upc', 'gtin', 'ean upc', 'barcode ean', 'γραμμωτος κωδικας', 'αριθμος barcode'],
  name: ['product name', 'name', 'item name', 'product', 'item', 'title', 'ονομα', 'ονομασια', 'ονομα προιοντος', 'ειδος', 'περιγραφη ειδους'],
  description: ['description', 'details', 'περιγραφη', 'σχολια'],
  category: ['category', 'group', 'product group', 'κατηγορια', 'ομαδα'],
  supplier: ['supplier', 'vendor', 'manufacturer', 'προμηθευτης'],
  unit: ['unit', 'uom', 'unit of measure', 'μοναδα', 'μμ', 'μοναδα μετρησης'],
  quantity: ['quantity', 'qty', 'stock', 'on hand', 'current stock', 'pieces', 'pcs', 'units', 'ποσοτητα', 'αποθεμα', 'ποσ', 'τεμαχια', 'τεμ', 'τμχ', 'temaxia', 'posotita', 'posothta'],
  minStock: ['minimum stock', 'min stock', 'min', 'minimum', 'reorder level', 'reorder point', 'ελαχιστο', 'ελαχιστο αποθεμα'],
  location: ['location', 'bin', 'shelf', 'position', 'θεση', 'ραφι', 'θεση αποθηκης'],
  purchasePrice: ['purchase price', 'cost', 'cost price', 'buy price', 'buying price', 'unit cost', 'τιμη αγορας', 'κοστος', 'τιμη κοστους', 'κοστος αγορας', 'timh agoras', 'timi agoras', 'kostos'],
  sellingPrice: ['selling price', 'price', 'sale price', 'retail price', 'sell price', 'τιμη πωλησης', 'τιμη λιανικης', 'λιανικη', 'τιμη', 'timh polhshs', 'timi polisis', 'timh lianikhs'],
  status: ['status', 'active', 'state', 'κατασταση'],
};

/** Line totals, amounts, discounts and percentages: never a quantity or a unit price. */
const NOT_A_UNIT_VALUE = /(^| )(total|totals|sum|amount|value|συνολο|συνολικη|συνολικο|συνολικησ|αξια|ποσο|εκπτωση|εκπτ|discount|ποσοστο|percent)( |$)/;
const VALUE_FIELDS = new Set<FieldKey>(['quantity', 'minStock', 'purchasePrice', 'sellingPrice']);

/** Lower case, no accents, final sigma as sigma, every non-letter a single space. */
export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const NORMALIZED = Object.fromEntries(Object.entries(SYNONYMS).map(([k, list]) => [k, list.map(norm)])) as Record<FieldKey, string[]>;

/** The field of each column, from its title ('' = not recognised). */
export function autoMap(headers: string[]): (FieldKey | '')[] {
  const result: (FieldKey | '')[] = headers.map(() => '');
  const used = new Set<FieldKey>();
  // Pass 1: the title is a known name; pass 2: it contains one as whole words; pass 3: anywhere.
  // In passes 2 and 3 the longest name wins: "Unit Price" is a price, not the unit, and
  // "Minimum Stock Level" the minimum stock, not the quantity.
  const fits = (n: string, s: string, pass: number) =>
    pass === 0 ? n === s : pass === 1 ? ` ${n} `.includes(` ${s} `) : s.length > 2 && n.includes(s);
  for (const pass of [0, 1, 2]) {
    headers.forEach((h, i) => {
      if (result[i]) return;
      const n = norm(h);
      if (!n) return;
      let best: { key: FieldKey; length: number } | null = null;
      for (const f of FIELDS) {
        if (used.has(f.key) || (VALUE_FIELDS.has(f.key) && NOT_A_UNIT_VALUE.test(n))) continue;
        for (const s of NORMALIZED[f.key]) if (fits(n, s, pass) && (!best || s.length > best.length)) best = { key: f.key, length: s.length };
      }
      if (best) {
        result[i] = best.key;
        used.add(best.key);
      }
    });
  }
  return result;
}

export interface ParsedSheet {
  fileName: string;
  sheets: string[];
  sheet: string;
  /** Column titles (or "Column A", ... when the file has none). */
  headers: string[];
  /** Data rows (empty rows left out) and the Excel row number of each. */
  rows: unknown[][];
  rowNumbers: number[];
  noHeader: boolean;
}

/** The standard file: A SKU | B Barcode Number | C Quantity | D Purchase Price | E Selling Price. */
export const STANDARD: FieldKey[] = ['sku', 'barcode', 'quantity', 'purchasePrice', 'sellingPrice'];
const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const columnName = (i: number) => `Column ${COLUMN_LETTERS[i] ?? i + 1}`;

const filled = (c: unknown) => c !== null && c !== undefined && String(c).trim() !== '';

export function parseSheet(wb: XLSX.WorkBook, fileName: string, sheet: string): ParsedSheet {
  const ws = wb.Sheets[sheet];
  // Empty rows are kept here so that index + first row of the sheet = the Excel row number.
  const data = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const firstRow = ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r + 1 : 1;
  // The titles are on the first row with at least two non-empty cells (a one-cell title above is skipped).
  let titleIndex = data.findIndex((r) => r.filter(filled).length >= 2);
  if (titleIndex < 0) titleIndex = Math.max(0, data.findIndex((r) => r.some(filled)));
  const width = Math.max(0, ...data.map((r) => r.length));
  const cells = (data[titleIndex] ?? []).map((h) => (h == null ? '' : String(h).trim()));
  // No title row at all (the file starts with data): the five standard columns by position.
  const isNumber = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^\s*-?[\d.,]+\s*$/.test(v) && /\d/.test(v));
  const noHeader = width <= STANDARD.length && autoMap(cells).every((m) => !m) && [2, 3, 4].some((i) => isNumber(data[titleIndex]?.[i]));
  const headers = Array.from({ length: width }, (_, i) => {
    const h = noHeader ? null : data[titleIndex]?.[i];
    return h == null || String(h).trim() === '' ? columnName(i) : String(h).trim();
  });
  const rows: unknown[][] = [];
  const rowNumbers: number[] = [];
  data.forEach((r, i) => {
    if (i < titleIndex || (i === titleIndex && !noHeader) || !r.some(filled)) return;
    rows.push(r);
    rowNumbers.push(firstRow + i);
  });
  return { fileName, sheets: wb.SheetNames, sheet, headers, rows, rowNumbers, noHeader };
}

/** Detected columns; a file without titles gets the standard order A-E. */
export const mappingFor = (p: ParsedSheet): (FieldKey | '')[] => (p.noHeader ? p.headers.map((_, i) => STANDARD[i] ?? '') : autoMap(p.headers));
