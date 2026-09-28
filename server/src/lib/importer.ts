/**
 * Product import from Excel/CSV.
 *
 * The browser parses the file and maps columns; the server validates every row
 * (types, required fields, duplicates inside the file and against the
 * database) and then imports the valid rows in one database transaction.
 */
import { getDefaultWarehouseId, normalizeText, nowIso, type DB } from '../db/index.js';
import { audit, type Actor } from './audit.js';
import { findOrCreateLocation } from './locations.js';
import { adjustToCount, applyStockChange, round3, setProductLocation } from './stock.js';

export const IMPORT_FIELDS = [
  'sku',
  'barcode',
  'name',
  'description',
  'category',
  'supplier',
  'unit',
  'quantity',
  'minStock',
  'location',
  'purchasePrice',
  'sellingPrice',
  'status',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export type RawRow = { rowNumber: number } & Partial<Record<ImportField, unknown>>;

export interface ImportOptions {
  duplicateStrategy: 'skip' | 'update' | 'ask';
  /** Per-row decision when duplicateStrategy = 'ask'. */
  decisions?: Record<string, 'skip' | 'update'>;
  /** What to do with the Quantity column for existing products. */
  quantityMode: 'ignore' | 'set' | 'add';
  createMissing: boolean;
}

interface CleanRow {
  sku: string;
  barcode: string | null;
  name: string | null;
  description: string | null;
  category: string | null;
  supplier: string | null;
  unit: string | null;
  quantity: number | null;
  minStock: number | null;
  location: string | null;
  purchasePrice: number | null;
  sellingPrice: number | null;
  status: 'ACTIVE' | 'INACTIVE' | null;
}

export interface RowResult {
  rowNumber: number;
  status: 'new' | 'existing' | 'error';
  errors: string[];
  warnings: string[];
  match?: { id: number; sku: string; name: string; matchedBy: 'sku' | 'barcode' };
  data?: CleanRow;
}

/** Text cell: numbers from Excel are converted without exponent notation. */
function text(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Accepts 12.5, "12,5", "1.234,56", "1,234.56", "€ 12,00". */
export function parseNumber(v: unknown): number | null | typeof NaN {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[\s€$£]/g, '');
  if (s === '') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

function parseStatus(v: unknown): 'ACTIVE' | 'INACTIVE' | null | undefined {
  const s = text(v);
  if (!s) return null;
  const n = normalizeText(s);
  if (['active', 'yes', 'true', '1', 'ενεργο', 'ναι', 'y'].includes(n)) return 'ACTIVE';
  if (['inactive', 'no', 'false', '0', 'ανενεργο', 'οχι', 'n'].includes(n)) return 'INACTIVE';
  return undefined;
}

function cleanRow(raw: RawRow, errors: string[], warnings: string[]): CleanRow {
  const num = (field: ImportField, label: string) => {
    const n = parseNumber(raw[field]);
    if (n === null) return null;
    if (Number.isNaN(n)) {
      errors.push(`${label} "${String(raw[field])}" is not a valid number`);
      return null;
    }
    if (n < 0) {
      errors.push(`${label} cannot be negative`);
      return null;
    }
    return round3(n);
  };
  const sku = text(raw.sku);
  const barcode = text(raw.barcode);
  if (!sku) errors.push('SKU is required');
  else if (/\s/.test(sku)) errors.push('SKU must not contain spaces');
  else if (sku.length > 64) errors.push('SKU is too long (max 64)');
  if (barcode && /\s/.test(barcode)) errors.push('Barcode must not contain spaces');
  if (barcode && barcode.length > 64) errors.push('Barcode is too long (max 64)');
  if (barcode && /^\d+\.?\d*e\+\d+$/i.test(barcode)) errors.push('Barcode looks like scientific notation — format the column as Text in Excel');
  const status = parseStatus(raw.status);
  if (status === undefined) {
    warnings.push(`Unknown status "${String(raw.status)}" — Active will be used`);
  }
  const name = text(raw.name);
  if (name && name.length > 200) errors.push('Product name is too long (max 200)');
  return {
    sku: sku ?? '',
    barcode,
    name,
    description: text(raw.description),
    category: text(raw.category),
    supplier: text(raw.supplier),
    unit: text(raw.unit),
    quantity: num('quantity', 'Quantity'),
    minStock: num('minStock', 'Minimum stock'),
    location: text(raw.location),
    purchasePrice: num('purchasePrice', 'Purchase price'),
    sellingPrice: num('sellingPrice', 'Selling price'),
    status: status ?? null,
  };
}

export function validateRows(db: DB, rows: RawRow[]): RowResult[] {
  const bySku = db.prepare('SELECT id, sku, name FROM products WHERE sku = ?');
  const byBarcode = db.prepare('SELECT id, sku, name FROM products WHERE barcode = ?');
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();
  type Ref = { id: number; sku: string; name: string };

  return rows.map((raw) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const data = cleanRow(raw, errors, warnings);
    const result: RowResult = { rowNumber: raw.rowNumber, status: 'new', errors, warnings, data };

    if (data.sku) {
      const key = data.sku.toLowerCase();
      const prev = seenSku.get(key);
      if (prev) errors.push(`Duplicate SKU in file (also on row ${prev})`);
      else seenSku.set(key, raw.rowNumber);
    }
    if (data.barcode) {
      const key = data.barcode.toLowerCase();
      const prev = seenBarcode.get(key);
      if (prev) errors.push(`Duplicate barcode in file (also on row ${prev})`);
      else seenBarcode.set(key, raw.rowNumber);
    }

    if (data.sku && !errors.length) {
      const skuMatch = bySku.get(data.sku) as Ref | undefined;
      const barcodeMatches = data.barcode ? (byBarcode.all(data.barcode) as Ref[]) : [];
      if (skuMatch) {
        const foreign = barcodeMatches.filter((b) => b.id !== skuMatch.id);
        if (foreign.length)
          errors.push(`Barcode ${data.barcode} already belongs to another product (${foreign.map((f) => f.sku).join(', ')})`);
        else result.match = { ...skuMatch, matchedBy: 'sku' };
      } else if (barcodeMatches.length === 1) {
        result.match = { ...barcodeMatches[0], matchedBy: 'barcode' };
        warnings.push(`Matched existing product by barcode; SKU would change from ${barcodeMatches[0].sku} to ${data.sku}`);
      } else if (barcodeMatches.length > 1) {
        errors.push(`Barcode ${data.barcode} is shared by several products (${barcodeMatches.map((b) => b.sku).join(', ')})`);
      }
    }
    if (!result.match && !data.name && !errors.length) errors.push('Product name is required for new products');
    result.status = errors.length ? 'error' : result.match ? 'existing' : 'new';
    return result;
  });
}

export interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  total: number;
  createdCategories: string[];
  createdSuppliers: string[];
  errorRows: { rowNumber: number; errors: string[] }[];
}

export function importRows(db: DB, actor: Actor, rows: RawRow[], options: ImportOptions, fileName?: string): ImportSummary {
  const warehouseId = getDefaultWarehouseId(db);
  const summary: ImportSummary = {
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    total: rows.length,
    createdCategories: [],
    createdSuppliers: [],
    errorRows: [],
  };
  const reference = `IMPORT ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

  const lookupNamed = (table: 'categories' | 'suppliers', name: string, created: string[]): number | null => {
    const found = db.prepare(`SELECT id FROM ${table} WHERE ims_norm(name) = ims_norm(?)`).pluck().get(name) as number | undefined;
    if (found) return found;
    if (!options.createMissing) return null;
    created.push(name);
    return Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
  };

  db.transaction(() => {
    const results = validateRows(db, rows);
    for (const r of results) {
      if (r.status === 'error' || !r.data) {
        summary.errors++;
        summary.errorRows.push({ rowNumber: r.rowNumber, errors: r.errors });
        continue;
      }
      const d = r.data;
      const categoryId = d.category ? lookupNamed('categories', d.category, summary.createdCategories) : null;
      const supplierId = d.supplier ? lookupNamed('suppliers', d.supplier, summary.createdSuppliers) : null;
      const locationId = d.location ? findOrCreateLocation(db, warehouseId, d.location) : null;

      if (r.status === 'new') {
        const id = Number(
          db
            .prepare(
              `INSERT INTO products (sku, barcode, name, description, category_id, supplier_id, unit, min_stock,
                 purchase_price, selling_price, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(d.sku, d.barcode, d.name, d.description, categoryId, supplierId, d.unit ?? 'pcs', d.minStock ?? 0,
              d.purchasePrice ?? 0, d.sellingPrice ?? 0, d.status ?? 'ACTIVE', actor.id).lastInsertRowid,
        );
        setProductLocation(db, id, warehouseId, locationId);
        audit(db, actor, {
          action: 'PRODUCT.CREATE',
          entityType: 'product',
          entityId: id,
          productId: id,
          description: `${actor.username} added new product ${d.sku} (${d.name}) via Excel import.`,
          newValue: d,
        });
        if (d.quantity && d.quantity > 0)
          applyStockChange(db, actor, {
            productId: id,
            warehouseId,
            type: 'INITIAL_STOCK',
            quantity: d.quantity,
            reference,
            notes: fileName ? `Excel import: ${fileName}` : 'Excel import',
            sourceType: 'IMPORT',
            unitCost: d.purchasePrice,
          });
        summary.imported++;
        continue;
      }

      // Existing product
      const decision =
        options.duplicateStrategy === 'ask' ? (options.decisions?.[String(r.rowNumber)] ?? 'skip') : options.duplicateStrategy;
      if (decision === 'skip') {
        summary.skipped++;
        continue;
      }
      const id = r.match!.id;
      const before = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, unknown>;
      // Empty cells never wipe existing data.
      const next = {
        sku: d.sku,
        barcode: d.barcode ?? before.barcode,
        name: d.name ?? before.name,
        description: d.description ?? before.description,
        category_id: d.category ? categoryId ?? before.category_id : before.category_id,
        supplier_id: d.supplier ? supplierId ?? before.supplier_id : before.supplier_id,
        unit: d.unit ?? before.unit,
        min_stock: d.minStock ?? before.min_stock,
        purchase_price: d.purchasePrice ?? before.purchase_price,
        selling_price: d.sellingPrice ?? before.selling_price,
        status: d.status ?? before.status,
      };
      db.prepare(
        `UPDATE products SET sku = @sku, barcode = @barcode, name = @name, description = @description,
           category_id = @category_id, supplier_id = @supplier_id, unit = @unit, min_stock = @min_stock,
           purchase_price = @purchase_price, selling_price = @selling_price, status = @status, updated_at = @now
         WHERE id = @id`,
      ).run({ ...next, now: nowIso(), id });
      if (locationId) setProductLocation(db, id, warehouseId, locationId);
      const changed = Object.keys(next).filter((k) => String(before[k] ?? '') !== String((next as Record<string, unknown>)[k] ?? ''));
      audit(db, actor, {
        action: 'PRODUCT.UPDATE',
        entityType: 'product',
        entityId: id,
        productId: id,
        description: `${actor.username} updated product ${d.sku} via Excel import${changed.length ? ` (${changed.join(', ')})` : ''}.`,
        oldValue: Object.fromEntries(changed.map((k) => [k, before[k]])),
        newValue: Object.fromEntries(changed.map((k) => [k, (next as Record<string, unknown>)[k]])),
      });
      if (d.quantity !== null && options.quantityMode === 'set') {
        adjustToCount(db, actor, { productId: id, warehouseId, countedQuantity: d.quantity, reason: 'Stock set by Excel import', reference });
      } else if (d.quantity && d.quantity > 0 && options.quantityMode === 'add') {
        applyStockChange(db, actor, {
          productId: id,
          warehouseId,
          type: 'STOCK_IN',
          quantity: d.quantity,
          reference,
          notes: 'Excel import',
          sourceType: 'IMPORT',
          unitCost: d.purchasePrice,
        });
      }
      summary.updated++;
    }

    audit(db, actor, {
      action: 'IMPORT.PRODUCTS',
      entityType: 'import',
      description: `${actor.username} imported products from ${fileName ?? 'Excel'}: ${summary.imported} imported, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.errors} errors.`,
      newValue: { ...summary, errorRows: undefined },
    });
  })();
  return summary;
}
