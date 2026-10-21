/**
 * Supplier invoices into the warehouse.
 *
 * The browser reads the invoice file (Excel, CSV or a PDF with text) with the column layout
 * saved for that supplier and sends its lines: description, supplier code (SKU), barcode,
 * quantity, unit price or line total, exactly as printed. Here each line is matched to a
 * product (see matching.ts): lines with one reliable match are ready; the rest are shown to a
 * person, who picks the product, creates a new one or skips the line. The confirmed invoice is
 * posted as a goods receipt (stock in), keeping the invoice's own text on every line.
 *
 * When a person confirms that a supplier's description or code means a product, it is saved
 * (product_aliases), so the same text on the next invoice of that supplier matches by itself.
 */
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { parseNumber } from './importer.js';
import { cleanText, keysFor, loadCatalog, similarProducts, type Catalog, type CatalogProduct, type Keys } from './matching.js';
import { round3 } from './stock.js';

export const INVOICE_FIELDS = ['description', 'sku', 'barcode', 'quantity', 'unitPrice', 'lineTotal'] as const;
export type InvoiceField = (typeof INVOICE_FIELDS)[number];

/** Which column of the supplier's invoice holds which field; saved once per supplier. */
export const layoutSchema = z.object({
  version: z.literal(1),
  source: z.enum(['sheet', 'pdf']),
  sheet: z.string().max(100).nullish(),
  /** Column of each field: its header text (preferred, survives moved columns) and position. */
  columns: z
    .partialRecord(z.enum(INVOICE_FIELDS), z.object({ header: z.string().max(200).nullish(), index: z.number().int().min(0).max(500) }))
    .refine((c) => c.description || c.sku || c.barcode, 'Choose the column with the description or the code')
    .refine((c) => c.quantity, 'Choose the quantity column'),
  /** A text-only line under an item (a long description wrapped to two lines) belongs to it. */
  joinWrapped: z.boolean().default(false),
  updatePrices: z.boolean().default(true),
});
export type InvoiceLayout = z.infer<typeof layoutSchema>;

export const invoiceLineSchema = z
  .object({ lineNo: z.number().int().min(0).max(100_000) })
  .catchall(z.union([z.string().max(1000), z.number(), z.null()]));
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;

export interface ParsedLine {
  lineNo: number;
  /** As on the invoice (spaces inside kept). */
  description: string | null;
  sku: string | null;
  barcode: string | null;
  quantity: number | null;
  unitPrice: number | null;
}

/** How the product was found. The first five are reliable; the rest are suggestions. */
export type MatchBy =
  | 'barcode'
  | 'sku'
  | 'supplier-code'
  | 'saved-description'
  | 'description'
  | 'other-supplier'
  | 'spacing'
  | 'similar';
const RELIABLE = new Set<MatchBy>(['barcode', 'sku', 'supplier-code', 'saved-description', 'description']);

export interface ProductSummary {
  id: number;
  sku: string;
  name: string;
  barcode: string | null;
  status: string;
  unit: string;
  purchasePrice: number;
}

export interface Candidate {
  product: ProductSummary;
  by: MatchBy;
  score?: number;
}

export interface LineMatch {
  line: ParsedLine;
  /** matched: one reliable product; review: a person must decide; new: nothing similar; error: unusable line. */
  status: 'matched' | 'review' | 'new' | 'error';
  productId: number | null;
  by: MatchBy | null;
  candidates: Candidate[];
  errors: string[];
  warnings: string[];
}

const summary = (p: CatalogProduct): ProductSummary => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  barcode: p.barcode,
  status: p.status,
  unit: p.unit,
  purchasePrice: p.purchase_price,
});

export function parseLine(raw: InvoiceLineInput, errors: string[], warnings: string[]): ParsedLine {
  const numberOf = (field: InvoiceField, label: string) => {
    const n = parseNumber(raw[field]);
    if (n === null) return null;
    if (Number.isNaN(n)) {
      errors.push(`${label} "${String(raw[field])}" is not a number`);
      return null;
    }
    return n;
  };
  const description = cleanText(raw.description);
  const sku = cleanText(raw.sku);
  const barcode = cleanText(raw.barcode);
  const quantity = numberOf('quantity', 'Quantity');
  let unitPrice = numberOf('unitPrice', 'Unit price');
  const lineTotal = numberOf('lineTotal', 'Line total');
  if (!description && !sku && !barcode) errors.push('The line has no description or code');
  if (quantity === null) errors.push('Quantity is missing');
  else if (quantity <= 0) errors.push('Quantity must be greater than zero');
  if (unitPrice === null && lineTotal !== null && quantity) {
    unitPrice = Math.round((lineTotal / quantity) * 10000) / 10000;
    warnings.push('Unit price calculated from the line total');
  }
  if (unitPrice !== null && unitPrice < 0) {
    errors.push('Unit price cannot be negative');
    unitPrice = null;
  }
  if (description && description.length > 500) errors.push('Description is too long (max 500)');
  if (sku && sku.length > 64) errors.push('Code is too long (max 64)');
  return { lineNo: raw.lineNo, description, sku, barcode, quantity: quantity === null ? null : round3(quantity), unitPrice };
}

interface Alias {
  product_id: number;
  supplier_id: number | null;
  kind: 'description' | 'code';
  value_key: string;
}

/** Saved descriptions and codes: this supplier's first, then the same text from other suppliers. */
async function loadAliases(db: DB) {
  const rows = await db.all<Alias>('SELECT product_id, supplier_id, kind, value_key FROM product_aliases');
  const map = new Map<string, Alias[]>();
  for (const a of rows) {
    const k = `${a.kind}:${a.value_key}`;
    map.set(k, [...(map.get(k) ?? []), a]);
  }
  return (kind: Alias['kind'], key: string) => map.get(`${kind}:${key}`) ?? [];
}

export async function matchInvoiceLines(db: DB, supplierId: number, raw: InvoiceLineInput[]): Promise<LineMatch[]> {
  const catalog = await loadCatalog(db);
  const aliases = await loadAliases(db);
  const parsed = raw.map((r) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    return { line: parseLine(r, errors, warnings), errors, warnings };
  });
  const keys = await keysFor(db, parsed.flatMap((p) => [p.line.description, p.line.sku, p.line.barcode]));
  const results = parsed.map(({ line, errors, warnings }) => match(catalog, aliases, keys, supplierId, line, errors, warnings));

  // The same product on several lines is allowed (quantities add up), but worth a look.
  const byProduct = new Map<number, number[]>();
  for (const r of results) if (r.productId) byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), r.line.lineNo]);
  for (const r of results) {
    const lines = r.productId ? byProduct.get(r.productId)! : [];
    if (lines.length > 1) r.warnings.push(`Same product as line ${lines.filter((n) => n !== r.line.lineNo).join(', ')}`);
  }
  return results;
}

function match(
  catalog: Catalog,
  aliases: Awaited<ReturnType<typeof loadAliases>>,
  keys: Map<string, Keys>,
  supplierId: number,
  line: ParsedLine,
  errors: string[],
  warnings: string[],
): LineMatch {
  const result: LineMatch = { line, status: 'new', productId: null, by: null, candidates: [], errors, warnings };
  if (errors.length) {
    result.status = 'error';
    return result;
  }
  const signals: { product: CatalogProduct; by: MatchBy; reliable: boolean; score?: number }[] = [];
  const add = (products: CatalogProduct[], by: MatchBy, reliable: boolean, score?: number) => {
    for (const product of products) signals.push({ product, by, reliable, score });
  };
  const fromAliases = (list: Alias[]) => list.map((a) => catalog.byId.get(a.product_id)).filter((p): p is CatalogProduct => Boolean(p));

  const barcode = line.barcode ? keys.get(line.barcode)?.compact : '';
  if (barcode) {
    const list = catalog.byBarcode.get(barcode) ?? [];
    add(list, 'barcode', list.length === 1);
  }
  const code = line.sku ? keys.get(line.sku) : undefined;
  if (code?.key) {
    const saved = aliases('code', code.key).filter((a) => a.supplier_id === supplierId);
    add(fromAliases(saved), 'supplier-code', saved.length === 1);
    const list = catalog.bySkuKey.get(code.key) ?? [];
    // Our SKU equal to the supplier's code is reliable, unless the product comes from another supplier.
    for (const p of list) add([p], 'sku', list.length === 1 && (!p.supplier_id || p.supplier_id === supplierId));
    if (!list.length) add((catalog.bySkuCompact.get(code.compact) ?? []), 'spacing', false);
  }
  const desc = line.description ? keys.get(line.description) : undefined;
  if (desc?.key) {
    const saved = aliases('description', desc.key);
    const mine = saved.filter((a) => a.supplier_id === supplierId);
    add(fromAliases(mine), 'saved-description', mine.length === 1);
    add(fromAliases(saved.filter((a) => a.supplier_id !== supplierId)), 'other-supplier', false);
    const sameName = catalog.byNameKey.get(desc.key) ?? [];
    add(sameName, 'description', sameName.length === 1);
    // The description column may hold our own SKU.
    const skuInDescription = catalog.bySkuKey.get(desc.key) ?? [];
    add(skuInDescription, 'sku', skuInDescription.length === 1);
    if (!signals.some((s) => s.reliable)) {
      // Differs only in spaces ("COLA330ML" / "COLA 330 ML"): likely the same, but asked.
      add(catalog.byNameCompact.get(desc.compact) ?? [], 'spacing', false);
      for (const s of similarProducts(catalog, desc.key)) add([s.product], 'similar', false, Math.round(s.score * 100) / 100);
    }
  }

  const reliable = [...new Set(signals.filter((s) => s.reliable).map((s) => s.product.id))];
  const seen = new Set<number>();
  for (const s of signals) {
    if (seen.has(s.product.id)) continue;
    seen.add(s.product.id);
    result.candidates.push({ product: summary(s.product), by: s.by, ...(s.score !== undefined ? { score: s.score } : {}) });
  }
  // Reliable candidates first.
  result.candidates.sort((a, b) => Number(reliable.includes(b.product.id)) - Number(reliable.includes(a.product.id)));
  result.candidates = result.candidates.slice(0, 6);

  if (reliable.length === 1) {
    const p = catalog.byId.get(reliable[0])!;
    const first = signals.find((s) => s.reliable && s.product.id === p.id)!;
    result.productId = p.id;
    result.by = first.by;
    if (p.status === 'INACTIVE') {
      warnings.push(`Product ${p.sku} is inactive: activate it or choose another product`);
      result.status = 'review';
    } else result.status = 'matched';
    // Two reliable signals pointing to different products never get here; one reliable and a
    // weaker different suggestion is still a match, but shown.
    const other = signals.find((s) => s.product.id !== p.id && (s.by === 'barcode' || s.by === 'sku'));
    if (other) {
      warnings.push(`The ${other.by === 'barcode' ? 'barcode' : 'code'} also fits ${other.product.sku} (${other.product.name})`);
      result.status = 'review';
    }
  } else if (reliable.length > 1) {
    const list = reliable.map((id) => catalog.byId.get(id)!);
    warnings.push(`Fits several products: ${list.map((p) => `${p.sku} (${p.name})`).join(', ')}`);
    result.status = 'review';
  } else if (result.candidates.length) {
    result.status = 'review';
    const best = result.candidates[0];
    if (best.by === 'sku') warnings.push(`Code ${line.sku} is our SKU of a product of another supplier`);
  }
  return result;
}

export interface DuplicateInvoice {
  receiptId: number;
  receiptNumber: string;
  receiptDate: string;
  invoiceNumber: string | null;
  reason: 'number' | 'file';
}

/**
 * Earlier receipts (still valid, not cancelled) of the same invoice: the same number from the
 * same supplier, or the same file.
 */
export async function findDuplicateInvoice(
  db: DB,
  supplierId: number,
  invoiceNumber: string | null | undefined,
  fileHash: string | null | undefined,
): Promise<DuplicateInvoice[]> {
  const out: DuplicateInvoice[] = [];
  if (invoiceNumber?.trim()) {
    const rows = await db.all<{ id: number; receipt_number: string; receipt_date: string; invoice_number: string }>(
      `SELECT id, receipt_number, receipt_date, invoice_number FROM stock_receipts
       WHERE supplier_id = ? AND ims_compact(invoice_number) = ims_compact(?) AND status = 'CONFIRMED' ORDER BY id`,
      supplierId,
      invoiceNumber,
    );
    for (const r of rows)
      out.push({ receiptId: r.id, receiptNumber: r.receipt_number, receiptDate: r.receipt_date, invoiceNumber: r.invoice_number, reason: 'number' });
  }
  if (fileHash) {
    const rows = await db.all<{ id: number; receipt_number: string; receipt_date: string; invoice_number: string }>(
      `SELECT r.id, r.receipt_number, r.receipt_date, r.invoice_number
       FROM invoice_imports ii JOIN stock_receipts r ON r.id = ii.receipt_id
       WHERE ii.file_hash = ? AND r.status = 'CONFIRMED' ORDER BY r.id`,
      fileHash,
    );
    for (const r of rows)
      if (!out.some((o) => o.receiptId === r.id))
        out.push({ receiptId: r.id, receiptNumber: r.receipt_number, receiptDate: r.receipt_date, invoiceNumber: r.invoice_number, reason: 'file' });
  }
  return out;
}

/** Save that a supplier's description or code means this product (a later correction wins). */
export async function rememberAlias(
  db: DB,
  a: { productId: number; supplierId: number; kind: 'description' | 'code'; value: string; userId: number },
) {
  await db.run(
    `INSERT INTO product_aliases (product_id, supplier_id, kind, value, created_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT ((COALESCE(supplier_id, 0)), kind, value_key)
     DO UPDATE SET product_id = excluded.product_id, value = excluded.value, updated_at = ims_now()`,
    a.productId,
    a.supplierId,
    a.kind,
    a.value,
    a.userId,
  );
}

/** Next free automatic SKU (P-000001, ...), for new products when the invoice has no code. */
export async function nextAutoSku(db: DB): Promise<string> {
  for (;;) {
    const n = (await db.value<number>(
      `INSERT INTO sequences (name, year, value) VALUES ('SKU', 0, 1)
       ON CONFLICT (name, year) DO UPDATE SET value = sequences.value + 1 RETURNING value`,
    ))!;
    const sku = `P-${String(n).padStart(6, '0')}`;
    if (!(await db.get('SELECT 1 FROM products WHERE ims_key(sku::text) = ims_key(?)', sku))) return sku;
  }
}
