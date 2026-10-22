/**
 * Product import from Excel/CSV.
 *
 * The browser parses the file and maps columns; the server validates every row
 * (types, required fields, duplicates inside the file and against the
 * database) and then imports the valid rows in one database transaction.
 *
 * The standard file has five columns: SKU | Barcode Number | Quantity | Purchase Price |
 * Selling Price. Older files with more columns (name, category, ...) still work. A row finds
 * its product by SKU (spaces and letter case do not matter), by barcode, or, when the SKU
 * column holds a product description, by that description. SKUs and descriptions are stored
 * exactly as in the file.
 */
import { getDefaultWarehouseId, normalizeText, nowIso, type DB } from '../db/index.js';
import { audit, type Actor } from './audit.js';
import { badRequest, conflict } from './errors.js';
import { findOrCreateLocation } from './locations.js';
import { cleanText, keysFor, loadCatalog, type CatalogProduct } from './matching.js';
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

export type QuantityMode = 'ignore' | 'set' | 'add';

export interface ImportOptions {
  duplicateStrategy: 'skip' | 'update' | 'ask';
  /** Per-row decision when duplicateStrategy = 'ask'. */
  decisions?: Record<string, 'skip' | 'update'>;
  /**
   * What to do with the Quantity column for existing products. No default: when the file has
   * quantities for products that already exist, the person must choose (add, set or leave).
   */
  quantityMode?: QuantityMode;
  createMissing: boolean;
  /** SHA-256 of the file: adding the same file to stock again needs allowDuplicate. */
  fileHash?: string | null;
  allowDuplicate?: boolean;
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
  /** keepSku: matched by barcode, and the SKU column holds the product's description, not a new SKU. */
  match?: {
    id: number;
    sku: string;
    name: string;
    matchedBy: 'sku' | 'barcode' | 'name';
    keepSku?: boolean;
    /** Stock and prices now, to show what the import changes. */
    current?: { quantity: number; purchasePrice: number; sellingPrice: number | null };
  };
  data?: CleanRow;
}

/** Text cell: numbers from Excel are converted without exponent notation; inner spaces kept. */
const text = cleanText;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** How a file writes numbers that are text cells: "1.250,50" (comma) or "1,250.50" (dot). */
export type NumberStyle = 'comma' | 'dot' | null;

const NUMBER_FIELDS = ['quantity', 'minStock', 'purchasePrice', 'sellingPrice'] as const;

/**
 * The decimal separator of the file, from the text numbers that can only be read one way
 * ("12,50" and "1.234,5": comma; "12.50" and "1,234.5": dot). null when the file has none, or
 * has both.
 */
export function numberStyleOf(rows: RawRow[]): NumberStyle {
  let comma = false;
  let dot = false;
  for (const r of rows)
    for (const f of NUMBER_FIELDS) {
      const v = r[f];
      if (typeof v !== 'string') continue;
      const s = v.replace(/[\s€$£]/g, '');
      if (/^-?\d+,\d{1,2}$/.test(s) || /^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) comma = true;
      else if (/^-?\d+\.\d{1,2}$/.test(s) || /^-?\d{1,3}(,\d{3})+\.\d+$/.test(s)) dot = true;
    }
  return comma === dot ? null : comma ? 'comma' : 'dot';
}

/**
 * Accepts 12.5, "12,5", "1.234,56", "1,234.56", "€ 12,00". With the file's number style,
 * "1.250" is 1250 in a file that writes decimals with a comma (and "1,250" in one with a dot).
 */
export function parseNumber(v: unknown, style: NumberStyle = null): number | null | typeof NaN {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[\s€$£]/g, '');
  if (s === '') return null;
  if (style === 'comma' && /^-?\d{1,3}(\.\d{3})+(,\d*)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (style === 'dot' && /^-?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return Number(s.replace(/,/g, ''));
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

function cleanRow(raw: RawRow, errors: string[], warnings: string[], style: NumberStyle): CleanRow {
  const num = (field: ImportField, label: string) => {
    const n = parseNumber(raw[field], style);
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
  // SKUs and barcodes may contain spaces; they are kept exactly as in the file.
  if (sku && CONTROL.test(sku)) errors.push('SKU contains a tab or line break');
  else if (sku && sku.length > 64) errors.push('SKU is too long (max 64)');
  if (barcode && CONTROL.test(barcode)) errors.push('Barcode contains a tab or line break');
  if (barcode && barcode.length > 64) errors.push('Barcode is too long (max 64)');
  if (barcode && /^\d+\.?\d*e\+\d+$/i.test(barcode)) errors.push('Barcode looks like scientific notation — format the column as Text in Excel');
  // A number cell has no leading zeros any more (0123 became 123).
  if (typeof raw.barcode === 'number') warnings.push('Barcode was a number cell in Excel: leading zeros may have been lost (format the column as Text)');
  if (typeof raw.sku === 'number') warnings.push('SKU was a number cell in Excel: leading zeros may have been lost (format the column as Text)');
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

export async function validateRows(db: DB, rows: RawRow[]): Promise<RowResult[]> {
  const catalog = await loadCatalog(db);
  const style = numberStyleOf(rows);
  const cleaned = rows.map((raw) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    return { raw, errors, warnings, data: cleanRow(raw, errors, warnings, style) };
  });
  const keys = await keysFor(db, cleaned.flatMap((c) => [c.data.sku, c.data.barcode, c.data.name]));
  const keyOf = (v: string | null) => (v ? (keys.get(v)?.key ?? '') : '');
  const compactOf = (v: string | null) => (v ? (keys.get(v)?.compact ?? '') : '');
  const ref = (p: CatalogProduct) => ({ id: p.id, sku: p.sku, name: p.name });
  const seenSku = new Map<string, number>();
  const seenBarcode = new Map<string, number>();
  const seenProduct = new Map<number, number>();

  const results = cleaned.map(({ raw, errors, warnings, data }) => {
    const result: RowResult = { rowNumber: raw.rowNumber, status: 'new', errors, warnings, data };
    const skuKey = keyOf(data.sku);
    const barcodeKey = compactOf(data.barcode);
    if (!data.sku && !data.barcode) errors.push('SKU is required');

    // The same SKU twice in the file, also when written with different spacing.
    if (skuKey) {
      const prev = seenSku.get(skuKey);
      if (prev) errors.push(`Duplicate SKU in file (also on row ${prev})`);
      else seenSku.set(skuKey, raw.rowNumber);
    }
    if (barcodeKey) {
      const prev = seenBarcode.get(barcodeKey);
      if (prev) errors.push(`Duplicate barcode in file (also on row ${prev})`);
      else seenBarcode.set(barcodeKey, raw.rowNumber);
    }

    if (!errors.length) {
      const skuMatches = skuKey ? (catalog.bySkuKey.get(skuKey) ?? []) : [];
      const barcodeMatches = barcodeKey ? (catalog.byBarcode.get(barcodeKey) ?? []) : [];
      // The SKU column may hold a product description (or there is only a name column).
      const descriptionKey = skuKey || keyOf(data.name);
      const nameMatches = !skuMatches.length && descriptionKey ? (catalog.byNameKey.get(descriptionKey) ?? []) : [];
      if (skuMatches.length) {
        const p = skuMatches[0];
        const foreign = barcodeMatches.filter((b) => b.id !== p.id);
        if (foreign.length)
          errors.push(`Barcode ${data.barcode} already belongs to another product (${foreign.map((f) => f.sku).join(', ')})`);
        else result.match = { ...ref(p), matchedBy: 'sku' };
      } else if (barcodeMatches.length === 1) {
        const p = barcodeMatches[0];
        const keepSku = !data.sku || keyOf(data.sku) === p.name_key;
        result.match = { ...ref(p), matchedBy: 'barcode', keepSku };
        if (!keepSku) warnings.push(`Matched existing product by barcode; SKU would change from ${p.sku} to ${data.sku}`);
      } else if (barcodeMatches.length > 1) {
        errors.push(`Barcode ${data.barcode} is shared by several products (${barcodeMatches.map((b) => b.sku).join(', ')})`);
      } else if (nameMatches.length === 1 && (!data.sku || !data.name || keyOf(data.name) === descriptionKey)) {
        // Same description (spaces, accents and letter case ignored) as exactly one product.
        result.match = { ...ref(nameMatches[0]), matchedBy: 'name' };
        warnings.push(`Matched by product description "${nameMatches[0].name}" (SKU ${nameMatches[0].sku})`);
      } else if (nameMatches.length > 1) {
        errors.push(`Several products have this description (${nameMatches.map((p) => p.sku).join(', ')}): use their SKU`);
      } else if (data.sku) {
        // Not the same product, but close: told to the user, never merged automatically.
        const compact = compactOf(data.sku);
        const near = [...(catalog.bySkuCompact.get(compact) ?? []), ...(catalog.byNameCompact.get(compact) ?? [])];
        if (near.length)
          warnings.push(`Similar to existing ${near.map((p) => `${p.sku} (${p.name})`).join(', ')}: only spaces differ. A new product will be created; use the existing SKU to update it instead.`);
        if (data.name) {
          const sameName = catalog.byNameKey.get(keyOf(data.name)) ?? [];
          if (sameName.length) warnings.push(`A product with the same name already exists (${sameName.map((p) => p.sku).join(', ')})`);
        }
      }
      if (result.match) {
        const prev = seenProduct.get(result.match.id);
        if (prev) errors.push(`Same product as row ${prev}`);
        else seenProduct.set(result.match.id, raw.rowNumber);
      }
    }
    if (!result.match && !errors.length) {
      if (!data.sku) errors.push('SKU is required for new products');
      else if (!data.name) {
        // The five-column file has no name column: the product is named after its SKU / description.
        if (!('name' in raw)) {
          data.name = data.sku;
          warnings.push('New product: its name is taken from the SKU column');
        } else errors.push('Product name is required for new products');
      }
    }
    result.status = errors.length ? 'error' : result.match ? 'existing' : 'new';
    return result;
  });

  // Stock and prices of the existing products now (default warehouse), shown next to the file's values.
  const ids = results.filter((r) => r.status === 'existing').map((r) => r.match!.id);
  if (ids.length) {
    const warehouseId = await getDefaultWarehouseId(db);
    const now = await db.all<{ id: number; quantity: number; purchase_price: number; selling_price: number | null }>(
      `SELECT p.id, COALESCE(i.quantity, 0) AS quantity, p.purchase_price, p.selling_price
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
       WHERE p.id IN (SELECT value::int FROM jsonb_array_elements_text(?::jsonb))`,
      warehouseId,
      JSON.stringify(ids),
    );
    const byId = new Map(now.map((p) => [p.id, p]));
    for (const r of results) {
      const p = r.status === 'existing' ? byId.get(r.match!.id) : undefined;
      if (p) r.match!.current = { quantity: p.quantity, purchasePrice: p.purchase_price, sellingPrice: p.selling_price };
    }
  }
  return results;
}

export interface PreviousImport {
  id: number;
  fileName: string | null;
  quantityMode: QuantityMode | null;
  imported: number;
  updated: number;
  stockRows: number;
  username: string | null;
  createdAt: string;
}

/** Earlier imports of the same file (same content), newest first. */
export async function previousImports(db: DB, fileHash: string | null | undefined): Promise<PreviousImport[]> {
  if (!fileHash) return [];
  return db.all<PreviousImport>(
    `SELECT pi.id, pi.file_name AS "fileName", pi.quantity_mode AS "quantityMode", pi.imported, pi.updated,
            pi.stock_rows AS "stockRows", u.username, pi.created_at AS "createdAt"
     FROM product_imports pi LEFT JOIN users u ON u.id = pi.created_by
     WHERE pi.file_hash = ? ORDER BY pi.id DESC LIMIT 5`,
    fileHash,
  );
}

/** Rows that update an existing product under these options. */
const updatesExisting = (r: RowResult, options: Pick<ImportOptions, 'duplicateStrategy' | 'decisions'>) =>
  r.status === 'existing' &&
  (options.duplicateStrategy === 'ask' ? options.decisions?.[String(r.rowNumber)] === 'update' : options.duplicateStrategy === 'update');

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

export async function importRows(
  db: DB,
  actor: Actor,
  rows: RawRow[],
  options: ImportOptions,
  fileName?: string,
): Promise<ImportSummary> {
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

  await db.tx(async (t) => {
    const warehouseId = await getDefaultWarehouseId(t);
    const lookupNamed = async (table: 'categories' | 'suppliers', name: string, created: string[]): Promise<number | null> => {
      const found = await t.value<number>(`SELECT id FROM ${table} WHERE ims_norm(name::text) = ims_norm(?)`, name);
      if (found) return found;
      if (!options.createMissing) return null;
      created.push(name);
      return (await t.value<number>(`INSERT INTO ${table} (name) VALUES (?) RETURNING id`, name)) as number;
    };

    const results = await validateRows(t, rows);
    // Quantities for existing products are never dropped silently: the person chooses what they mean.
    const withQuantity = results.filter((r) => updatesExisting(r, options) && r.data?.quantity != null);
    if (withQuantity.length && !options.quantityMode)
      throw badRequest(
        `The file has quantities for ${withQuantity.length} existing products: choose whether to add them to stock, set the stock to them, or leave the stock unchanged`,
        'QUANTITY_MODE_REQUIRED',
        { rows: withQuantity.length },
      );
    const quantityMode: QuantityMode = options.quantityMode ?? 'ignore';
    // The same file added to stock a second time: only when confirmed.
    if (quantityMode === 'add' && !options.allowDuplicate && withQuantity.some((r) => r.data!.quantity! > 0)) {
      const earlier = (await previousImports(t, options.fileHash)).filter((p) => p.stockRows > 0);
      if (earlier.length)
        throw conflict(
          `This file was already imported on ${earlier[0].createdAt.slice(0, 16).replace('T', ' ')}${earlier[0].username ? ` by ${earlier[0].username}` : ''}. Confirm to add its quantities to stock again.`,
          'DUPLICATE_IMPORT',
          { previous: earlier },
        );
    }
    let stockRows = 0;
    for (const r of results) {
      if (r.status === 'error' || !r.data) {
        summary.errors++;
        summary.errorRows.push({ rowNumber: r.rowNumber, errors: r.errors });
        continue;
      }
      const d = r.data;
      const categoryId = d.category ? await lookupNamed('categories', d.category, summary.createdCategories) : null;
      const supplierId = d.supplier ? await lookupNamed('suppliers', d.supplier, summary.createdSuppliers) : null;
      const locationId = d.location ? await findOrCreateLocation(t, warehouseId, d.location) : null;

      if (r.status === 'new') {
        const id = (await t.value<number>(
          `INSERT INTO products (sku, barcode, name, description, category_id, supplier_id, unit, min_stock,
             purchase_price, selling_price, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id`,
          d.sku,
          d.barcode,
          d.name,
          d.description,
          categoryId,
          supplierId,
          d.unit ?? 'pcs',
          d.minStock ?? 0,
          d.purchasePrice ?? 0,
          // Missing selling price: left empty, not invented.
          d.sellingPrice ?? null,
          d.status ?? 'ACTIVE',
          actor.id,
        )) as number;
        await setProductLocation(t, id, warehouseId, locationId);
        await audit(t, actor, {
          action: 'PRODUCT.CREATE',
          entityType: 'product',
          entityId: id,
          productId: id,
          description: `${actor.username} added new product ${d.sku} (${d.name}) via Excel import.`,
          newValue: d,
        });
        if (d.quantity && d.quantity > 0) {
          await applyStockChange(t, actor, {
            productId: id,
            warehouseId,
            type: 'INITIAL_STOCK',
            quantity: d.quantity,
            reference,
            notes: fileName ? `Excel import: ${fileName}` : 'Excel import',
            sourceType: 'IMPORT',
            unitCost: d.purchasePrice,
          });
          stockRows++;
        }
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
      const before = (await t.get<Record<string, unknown>>('SELECT * FROM products WHERE id = ?', id))!;
      // Empty cells never wipe existing data.
      const next = {
        // Matched by SKU (spaces / letter case may differ) or by description: the stored SKU stays.
        sku: r.match!.matchedBy === 'barcode' && !r.match!.keepSku && d.sku ? d.sku : (before.sku as string),
        barcode: (d.barcode ?? before.barcode) as string | null,
        name: (d.name ?? before.name) as string,
        description: (d.description ?? before.description) as string | null,
        category_id: (d.category ? (categoryId ?? before.category_id) : before.category_id) as number | null,
        supplier_id: (d.supplier ? (supplierId ?? before.supplier_id) : before.supplier_id) as number | null,
        unit: (d.unit ?? before.unit) as string,
        min_stock: (d.minStock ?? before.min_stock) as number,
        purchase_price: (d.purchasePrice ?? before.purchase_price) as number,
        selling_price: (d.sellingPrice ?? before.selling_price) as number | null,
        status: (d.status ?? before.status) as string,
      };
      await t.run(
        `UPDATE products SET sku = @sku, barcode = @barcode, name = @name, description = @description,
           category_id = @category_id, supplier_id = @supplier_id, unit = @unit, min_stock = @min_stock,
           purchase_price = @purchase_price, selling_price = @selling_price, status = @status, updated_at = @now
         WHERE id = @id`,
        { ...next, now: nowIso(), id },
      );
      if (locationId) await setProductLocation(t, id, warehouseId, locationId);
      const changed = Object.keys(next).filter((k) => String(before[k] ?? '') !== String((next as Record<string, unknown>)[k] ?? ''));
      await audit(t, actor, {
        action: 'PRODUCT.UPDATE',
        entityType: 'product',
        entityId: id,
        productId: id,
        description: `${actor.username} updated product ${next.sku} via Excel import${changed.length ? ` (${changed.join(', ')})` : ''}.`,
        oldValue: Object.fromEntries(changed.map((k) => [k, before[k]])),
        newValue: Object.fromEntries(changed.map((k) => [k, (next as Record<string, unknown>)[k]])),
      });
      if (d.quantity !== null && quantityMode === 'set') {
        await adjustToCount(t, actor, { productId: id, warehouseId, countedQuantity: d.quantity, reason: 'Stock set by Excel import', reference });
        stockRows++;
      } else if (d.quantity && d.quantity > 0 && quantityMode === 'add') {
        await applyStockChange(t, actor, {
          productId: id,
          warehouseId,
          type: 'STOCK_IN',
          quantity: d.quantity,
          reference,
          notes: fileName ? `Excel import: ${fileName}` : 'Excel import',
          sourceType: 'IMPORT',
          unitCost: d.purchasePrice,
        });
        stockRows++;
      }
      summary.updated++;
    }

    await t.run(
      `INSERT INTO product_imports (file_name, file_hash, quantity_mode, imported, updated, stock_rows, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      fileName ?? null,
      options.fileHash ?? null,
      withQuantity.length ? quantityMode : null,
      summary.imported,
      summary.updated,
      stockRows,
      actor.id,
    );

    await audit(t, actor, {
      action: 'IMPORT.PRODUCTS',
      entityType: 'import',
      description: `${actor.username} imported products from ${fileName ?? 'Excel'}: ${summary.imported} imported, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.errors} errors.`,
      newValue: { ...summary, errorRows: undefined },
    });
  });
  return summary;
}
