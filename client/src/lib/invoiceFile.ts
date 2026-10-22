/**
 * Reading a supplier invoice in the browser: Excel / CSV cells, or the text of a PDF (one that
 * was produced by a program, not a scan) placed into the invoice's own columns.
 *
 * Nothing about the invoice is assumed: the columns come from the invoice's header row (found
 * by its titles, e.g. "Περιγραφή", "Ποσότητα") or from the layout saved for the supplier the
 * first time. Descriptions are kept exactly as printed.
 */
import * as XLSX from 'xlsx';

export type Cell = string | number | null;

export const INVOICE_FIELDS = ['description', 'sku', 'barcode', 'quantity', 'unitPrice', 'lineTotal'] as const;
export type InvoiceField = (typeof INVOICE_FIELDS)[number];

export interface InvoiceLayout {
  version: 1;
  source: 'sheet' | 'pdf';
  sheet?: string | null;
  columns: Partial<Record<InvoiceField, { header?: string | null; index: number }>>;
  joinWrapped: boolean;
  updatePrices: boolean;
}

/** A piece of PDF text with its position (PDF units, y up). */
interface Fragment {
  text: string;
  x: number;
  w: number;
  y: number;
  h: number;
}

export interface InvoiceSource {
  kind: 'sheet' | 'pdf';
  fileName: string;
  hash: string;
  sheets: string[];
  sheet: string | null;
  /** Rows of cells (sheet) or lines of text pieces (pdf), top to bottom. */
  rows: Cell[][];
  lines: Fragment[][];
}

export interface Table {
  headerIndex: number;
  headers: string[];
  rows: { cells: Cell[]; source: number }[];
}

export interface ExtractedLine {
  lineNo: number;
  /** Row of the file (sheet) or line of the PDF the item comes from (1-based). */
  sourceRow: number;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  quantity: Cell;
  unitPrice: Cell;
  lineTotal: Cell;
}

// ---- Column titles ------------------------------------------------------------------------

export const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Usual titles on Greek and English invoices; only used to suggest columns. */
const TITLES: Record<InvoiceField, string[]> = {
  description: ['περιγραφη', 'περιγραφη ειδουσ', 'ειδοσ', 'ονομασια', 'περιγραφη προιοντοσ', 'description', 'item description', 'item', 'product'],
  sku: ['κωδικοσ', 'κωδ', 'κωδ ειδουσ', 'κωδικοσ ειδουσ', 'κωδ προιοντοσ', 'code', 'item code', 'sku', 'part no', 'article'],
  barcode: ['barcode', 'ean', 'ean13', 'upc', 'gtin', 'γραμμωτοσ κωδικασ'],
  quantity: ['ποσοτητα', 'ποσ', 'τεμ', 'τεμαχια', 'qty', 'quantity'],
  unitPrice: ['τιμη', 'τιμη μοναδασ', 'τιμη μον', 'τ μον', 'τιμη μονασ', 'unit price', 'price'],
  lineTotal: ['αξια', 'καθαρη αξια', 'συνολο', 'ποσο', 'αξια ειδουσ', 'net amount', 'amount', 'total', 'line total'],
};
/** Never the price or total column: VAT, discount and percentage columns. */
const NOT_A_PRICE = /^(φπα|vat|εκπτ|discount|ποσοστο|%)|αξια φπα|ποσο φπα|vat amount/;

function fieldOf(title: string, pass: 0 | 1, used: Set<InvoiceField>): InvoiceField | null {
  const n = norm(title);
  if (!n) return null;
  for (const f of INVOICE_FIELDS) {
    if (used.has(f)) continue;
    if ((f === 'unitPrice' || f === 'lineTotal') && NOT_A_PRICE.test(n)) continue;
    if (TITLES[f].some((s) => (pass === 0 ? n === s : n.startsWith(`${s} `) || n.includes(` ${s}`) || n.startsWith(s)))) return f;
  }
  return null;
}

/** Suggested field for each column, from the titles. */
export function suggestColumns(headers: string[]): (InvoiceField | '')[] {
  const out: (InvoiceField | '')[] = headers.map(() => '');
  const used = new Set<InvoiceField>();
  for (const pass of [0, 1] as const)
    headers.forEach((h, i) => {
      if (out[i]) return;
      const f = fieldOf(h, pass, used);
      if (f) {
        out[i] = f;
        used.add(f);
      }
    });
  return out;
}

// ---- Reading the file ---------------------------------------------------------------------

export const isPdf = (file: File) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf';

export async function readInvoiceFile(file: File, sheet?: string | null): Promise<InvoiceSource> {
  const buf = await file.arrayBuffer();
  const hash = await sha256Hex(new Uint8Array(buf));
  if (isPdf(file)) {
    const lines = await pdfLines(buf);
    if (!lines.length) throw new Error('This PDF has no text (probably a scan). Ask the supplier for the PDF of the invoice program or an Excel file.');
    return { kind: 'pdf', fileName: file.name, hash, sheets: [], sheet: null, rows: [], lines };
  }
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('Unsupported file type. Please upload .pdf, .xlsx, .xls or .csv');
  // CSV cells stay text: leading zeros and decimal commas are kept (the server reads the numbers).
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, codepage: 65001, raw: /\.csv$/i.test(file.name) });
  const name = sheet && wb.SheetNames.includes(sheet) ? sheet : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
  return { kind: 'sheet', fileName: file.name, hash, sheets: wb.SheetNames, sheet: name, rows, lines: [] };
}

async function pdfLines(buf: ArrayBuffer): Promise<Fragment[][]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(buf) });
  const doc = await task.promise;
  const lines: Fragment[][] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const frags: Fragment[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [a, b, , d, x, y] = item.transform as number[];
        const h = Math.abs(item.height || d || Math.hypot(a, b)) || 8;
        frags.push({ text: item.str, x, w: item.width, y, h });
      }
      lines.push(...groupLines(frags));
    }
  } finally {
    await task.destroy();
  }
  return lines;
}

/** Pieces at the same height form a line; lines from the top of the page down. */
export function groupLines(frags: Fragment[]): Fragment[][] {
  const sorted = [...frags].sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: { y: number; h: number; items: Fragment[] }[] = [];
  for (const f of sorted) {
    const line = lines.find((l) => Math.abs(l.y - f.y) <= Math.max(2, 0.45 * Math.min(l.h, f.h)));
    if (line) line.items.push(f);
    else lines.push({ y: f.y, h: f.h, items: [f] });
  }
  return lines.sort((p, q) => q.y - p.y).map((l) => l.items.sort((p, q) => p.x - q.x));
}

/** Text of a PDF line, pieces in reading order (a wider gap is one space). */
const joinText = (items: Fragment[]) => {
  let out = '';
  let end = -Infinity;
  for (const f of items) {
    if (out && f.x - end > 0.15 * f.h && !out.endsWith(' ') && !f.text.startsWith(' ')) out += ' ';
    out += f.text;
    end = f.x + f.w;
  }
  return out.trim();
};

export function lineText(source: InvoiceSource, i: number): string {
  if (source.kind === 'pdf') return joinText(source.lines[i] ?? []);
  return (source.rows[i] ?? []).map((c) => (c == null ? '' : String(c))).filter(Boolean).join(' · ');
}

export const rowCount = (source: InvoiceSource) => (source.kind === 'pdf' ? source.lines.length : source.rows.length);

// ---- Header row and table ----------------------------------------------------------------

/** Header labels of a PDF line: pieces close together form one title ("Τιμή Μονάδας"). */
function pdfHeaderLabels(items: Fragment[]): { text: string; x0: number; x1: number }[] {
  const labels: { text: string; x0: number; x1: number; h: number }[] = [];
  for (const f of items) {
    const last = labels[labels.length - 1];
    if (last && f.x - last.x1 < 0.6 * f.h) {
      last.text += (f.x - last.x1 > 0.15 * f.h ? ' ' : '') + f.text;
      last.x1 = f.x + f.w;
    } else labels.push({ text: f.text, x0: f.x, x1: f.x + f.w, h: f.h });
  }
  return labels.map((l) => ({ text: l.text.trim(), x0: l.x0, x1: l.x1 }));
}

function headerCells(source: InvoiceSource, i: number): string[] {
  if (source.kind === 'pdf') return pdfHeaderLabels(source.lines[i] ?? []).map((l) => l.text);
  return (source.rows[i] ?? []).map((c) => (c == null ? '' : String(c).trim()));
}

/**
 * The header row: the one with the saved column titles of this supplier, or the most invoice
 * column titles (at least two). -1 if there is none in the first 80 rows.
 */
export function findHeader(source: InvoiceSource, layout?: InvoiceLayout | null): number {
  const saved = layout ? Object.values(layout.columns).map((c) => norm(c?.header)).filter(Boolean) : [];
  let best = -1;
  let bestScore = 1;
  const limit = Math.min(rowCount(source), 80);
  for (let i = 0; i < limit; i++) {
    const cells = headerCells(source, i).map(norm);
    if (saved.length) {
      if (saved.every((s) => cells.includes(s))) return i;
      continue;
    }
    const score = suggestColumns(cells).filter(Boolean).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** The rows under the header, as cells of the header's columns. */
export function buildTable(source: InvoiceSource, headerIndex: number): Table {
  if (source.kind === 'sheet') {
    const width = Math.max(0, ...source.rows.map((r) => r.length));
    const head = source.rows[headerIndex] ?? [];
    const headers = Array.from({ length: width }, (_, i) => (head[i] == null || String(head[i]).trim() === '' ? `#${i + 1}` : String(head[i]).trim()));
    const rows = source.rows.slice(headerIndex + 1).map((cells, k) => ({ cells, source: headerIndex + k + 2 }));
    return { headerIndex, headers, rows };
  }
  const labels = pdfHeaderLabels(source.lines[headerIndex] ?? []);
  const headerKey = norm(labels.map((l) => l.text).join(' '));
  // The header again on the next pages is not an item.
  const data = source.lines
    .map((items, i) => ({ items, source: i + 1 }))
    .slice(headerIndex + 1)
    .filter((l) => norm(joinText(l.items)) !== headerKey);
  const bounds = columnBounds(labels, data.flatMap((l) => l.items));
  // A piece belongs to the column its middle falls in.
  const columnOf = (f: Fragment) => {
    const mid = f.x + f.w / 2;
    let i = 0;
    while (i < bounds.length && mid > bounds[i]) i++;
    return i;
  };
  const rows: Table['rows'] = data.map((l) => {
    const groups: Fragment[][] = labels.map(() => []);
    for (const f of l.items) groups[columnOf(f)].push(f);
    return { cells: groups.map((g) => (g.length ? joinText(g) : null)), source: l.source };
  });
  return { headerIndex, headers: labels.map((l) => l.text), rows };
}

/**
 * Where one column ends and the next begins. Titles may be left, centred or right aligned and
 * numbers usually right aligned, so the border between two titles is put in the widest strip
 * that no text of the item lines crosses (fewest crossings if there is none).
 */
export function columnBounds(labels: { x0: number; x1: number }[], frags: Fragment[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < labels.length - 1; i++) {
    const lo = labels[i].x1;
    const hi = Math.max(lo, labels[i + 1].x0);
    const inside = frags.filter((f) => f.x < hi && f.x + f.w > lo);
    const edges = [...new Set([lo, hi, ...inside.flatMap((f) => [f.x, f.x + f.w]).filter((x) => x > lo && x < hi)])].sort((a, b) => a - b);
    let best = (lo + hi) / 2;
    let bestCross = Infinity;
    let bestWidth = -1;
    for (let k = 0; k < edges.length - 1; k++) {
      const m = (edges[k] + edges[k + 1]) / 2;
      const cross = inside.filter((f) => f.x < m && f.x + f.w > m).length;
      const width = edges[k + 1] - edges[k];
      if (cross < bestCross || (cross === bestCross && width > bestWidth)) {
        best = m;
        bestCross = cross;
        bestWidth = width;
      }
    }
    out.push(best);
  }
  return out;
}

/** Column index of each field under the saved layout (by title first, then by position). */
export function columnsFromLayout(table: Table, layout: InvoiceLayout): (InvoiceField | '')[] {
  const out: (InvoiceField | '')[] = table.headers.map(() => '');
  const titles = table.headers.map(norm);
  for (const f of INVOICE_FIELDS) {
    const c = layout.columns[f];
    if (!c) continue;
    let i = c.header ? titles.indexOf(norm(c.header)) : -1;
    if (i < 0 && c.index < out.length) i = c.index;
    if (i >= 0 && !out[i]) out[i] = f;
  }
  return out;
}

export function layoutFrom(source: InvoiceSource, table: Table, mapping: (InvoiceField | '')[], options: { joinWrapped: boolean; updatePrices: boolean }): InvoiceLayout {
  const columns: InvoiceLayout['columns'] = {};
  mapping.forEach((f, i) => {
    if (f) columns[f] = { header: table.headers[i] ?? null, index: i };
  });
  return { version: 1, source: source.kind, sheet: source.sheet, columns, ...options };
}

const hasText = (v: Cell) => v !== null && v !== undefined && String(v).trim() !== '';
export const isNumeric = (v: Cell) =>
  typeof v === 'number' || (typeof v === 'string' && /\d/.test(v) && /^[-+]?\s*[\d.,\s]+\s*[€$]?$/.test(v.trim()));

/**
 * The item lines: a quantity that is a number and a description or code. Totals, notes and
 * repeated headers are left out. With joinWrapped, a text-only line right under an item
 * continues its description (long descriptions printed on two lines).
 */
/**
 * Decimal separator of the invoice: Greek invoices write 1.200,50 (comma decimals, dot for
 * thousands). Decided from all the numbers of the item lines together, so "1.200" of a
 * quantity column reads as 1200 when the prices are written 2,10.
 */
export function decimalCommaOf(values: Cell[]): boolean {
  let comma = 0;
  let dot = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const s = v.replace(/[\s€$]/g, '');
    if (/\d,\d+$/.test(s) && !/,\d+\./.test(s)) comma++;
    else if (/\d\.\d{1,2}$/.test(s) || /\d,\d{3}\.\d+$/.test(s)) dot++;
  }
  return comma > dot;
}

/** A number as plain text with a dot for decimals ("2.268,00" -> "2268.00"); other text as is. */
export function plainNumber(v: Cell, decimalComma: boolean): Cell {
  if (typeof v !== 'string' || !isNumeric(v)) return v;
  const s = v.replace(/[\s€$]/g, '');
  return decimalComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
}

export function extractLines(table: Table, mapping: (InvoiceField | '')[], joinWrapped: boolean): ExtractedLine[] {
  const col = (f: InvoiceField) => mapping.indexOf(f);
  const get = (cells: Cell[], f: InvoiceField): Cell => {
    const i = col(f);
    return i < 0 ? null : (cells[i] ?? null);
  };
  const text = (v: Cell) => (hasText(v) ? (typeof v === 'number' ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : String(v)) : null);
  const out: ExtractedLine[] = [];
  let previous: ExtractedLine | null = null;
  for (const r of table.rows) {
    const qty = get(r.cells, 'quantity');
    const description = text(get(r.cells, 'description'));
    const sku = text(get(r.cells, 'sku'));
    const barcode = text(get(r.cells, 'barcode'));
    if (isNumeric(qty) && (description || sku || barcode)) {
      previous = {
        lineNo: out.length + 1,
        sourceRow: r.source,
        description,
        sku,
        barcode,
        quantity: qty,
        unitPrice: get(r.cells, 'unitPrice'),
        lineTotal: get(r.cells, 'lineTotal'),
      };
      out.push(previous);
      continue;
    }
    const others = r.cells.filter((c, i) => hasText(c) && i !== col('description'));
    if (joinWrapped && previous && description && !others.length) previous.description = `${previous.description ?? ''} ${description}`.trim();
    else previous = null;
  }
  const decimalComma = decimalCommaOf(out.flatMap((l) => [l.quantity, l.unitPrice, l.lineTotal]));
  for (const l of out) {
    l.quantity = plainNumber(l.quantity, decimalComma);
    l.unitPrice = plainNumber(l.unitPrice, decimalComma);
    l.lineTotal = plainNumber(l.lineTotal, decimalComma);
  }
  return out;
}

// ---- SHA-256 of the file (to recognise the same invoice file) --------------------------------

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256Fallback(data);
}

/** For plain-HTTP office networks, where the browser offers no crypto.subtle. */
function sha256Fallback(data: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('');
}
