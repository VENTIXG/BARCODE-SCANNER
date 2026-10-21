/**
 * Finding the product a line (Excel row, invoice line) means, by SKU, barcode or description.
 *
 * Text is stored exactly as given (only spaces at the ends are dropped). For comparing, the
 * database computes a key (ims_key: lower case, no accents, every run of spaces one space) and
 * a compact key without any spaces (ims_compact). Keys are always computed by the database, so
 * they follow the same rule as its unique index on SKUs.
 *
 * A match is "reliable" only when it cannot be a different product: the same barcode, the same
 * SKU, a description or supplier code the user confirmed before, or the same description as
 * exactly one product. Everything else (spacing-only differences in descriptions, similar
 * words, a product of another supplier with the same code) is a suggestion for a person.
 */
import type { DB } from '../db/index.js';

export interface Keys {
  key: string;
  compact: string;
}

/** Keys of many texts in one query. */
export async function keysFor(db: DB, texts: (string | null | undefined)[]): Promise<Map<string, Keys>> {
  const unique = [...new Set(texts.filter((t): t is string => typeof t === 'string' && t !== ''))];
  const out = new Map<string, Keys>();
  if (!unique.length) return out;
  const rows = await db.all<{ t: string; k: string; c: string }>(
    'SELECT value AS t, ims_key(value) AS k, ims_compact(value) AS c FROM jsonb_array_elements_text(?::jsonb)',
    JSON.stringify(unique),
  );
  for (const r of rows) out.set(r.t, { key: r.k ?? '', compact: r.c ?? '' });
  return out;
}

/** Cell or field text as stored: spaces inside kept, spaces at the ends dropped; empty -> null. */
export function cleanText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  const s = String(v).trim();
  return s === '' ? null : s;
}

export interface CatalogProduct {
  id: number;
  sku: string;
  name: string;
  barcode: string | null;
  supplier_id: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  purchase_price: number;
  unit: string;
  sku_key: string;
  name_key: string;
  sku_compact: string;
  name_compact: string;
  barcode_compact: string | null;
}

export interface Catalog {
  products: CatalogProduct[];
  byId: Map<number, CatalogProduct>;
  bySkuKey: Map<string, CatalogProduct[]>;
  bySkuCompact: Map<string, CatalogProduct[]>;
  byNameKey: Map<string, CatalogProduct[]>;
  byNameCompact: Map<string, CatalogProduct[]>;
  byBarcode: Map<string, CatalogProduct[]>;
}

function index(products: CatalogProduct[], key: (p: CatalogProduct) => string | null) {
  const m = new Map<string, CatalogProduct[]>();
  for (const p of products) {
    const k = key(p);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(p);
    else m.set(k, [p]);
  }
  return m;
}

/** Every product with its keys (one query; a few thousand products are a few hundred kB). */
export async function loadCatalog(db: DB): Promise<Catalog> {
  const products = await db.all<CatalogProduct>(
    `SELECT id, sku::text AS sku, name, barcode::text AS barcode, supplier_id, status, purchase_price, unit,
            ims_key(sku::text) AS sku_key, ims_key(name) AS name_key,
            ims_compact(sku::text) AS sku_compact, ims_compact(name) AS name_compact,
            ims_compact(barcode::text) AS barcode_compact
     FROM products ORDER BY id`,
  );
  return {
    products,
    byId: new Map(products.map((p) => [p.id, p])),
    bySkuKey: index(products, (p) => p.sku_key),
    bySkuCompact: index(products, (p) => p.sku_compact),
    byNameKey: index(products, (p) => p.name_key),
    byNameCompact: index(products, (p) => p.name_compact),
    byBarcode: index(products, (p) => p.barcode_compact),
  };
}

// ---- Similar descriptions (suggestions only) ---------------------------------------------

/** Words of a key; "1,5l" and "συσκ.6" stay one word, dots and commas at the ends go. */
const tokens = (key: string) =>
  key
    .split(/[^\p{L}\p{N}.,]+/u)
    .map((t) => t.replace(/^[.,]+|[.,]+$/g, ''))
    .filter(Boolean);
const hasDigit = (t: string) => /\d/.test(t);

/**
 * How alike two descriptions are, 0..1 (shared words). Words with digits (sizes, weights,
 * codes such as 500ml or 1,5l) must all agree: "COLA 330ML" is never similar to "COLA 500ML".
 */
export function similarity(aKey: string, bKey: string): number {
  const a = new Set(tokens(aKey));
  const b = new Set(tokens(bKey));
  if (!a.size || !b.size) return 0;
  const aNum = [...a].filter(hasDigit);
  const bNum = [...b].filter(hasDigit);
  if (aNum.length !== bNum.length || aNum.some((t) => !b.has(t))) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** The most similar products by description (at most `limit`, score >= min). */
export function similarProducts(catalog: Catalog, key: string, limit = 3, min = 0.5) {
  const scored: { product: CatalogProduct; score: number }[] = [];
  for (const p of catalog.products) {
    const score = similarity(key, p.name_key);
    if (score >= min) scored.push({ product: p, score });
  }
  return scored.sort((x, y) => y.score - x.score || x.product.id - y.product.id).slice(0, limit);
}
