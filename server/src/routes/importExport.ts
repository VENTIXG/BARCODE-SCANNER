import { Router } from 'express';
import { z } from 'zod';
import { getDb, getDefaultWarehouseId } from '../db/index.js';
import { actorOf, requirePermission } from '../middleware/auth.js';
import { badRequest } from '../lib/errors.js';
import { FMT, PRODUCT_COLUMNS, addSheet, newWorkbook, sendWorkbook, toDate, type Column } from '../lib/excel.js';
import { str } from '../lib/http.js';
import { IMPORT_FIELDS, importRows, validateRows } from '../lib/importer.js';
import { PRODUCT_SELECT, buildProductWhere, orderBy, type ProductRow } from '../lib/products.js';
import { TX_SELECT, buildTxWhere, readTxFilters } from '../lib/transactions.js';

// ---- Import ---------------------------------------------------------------

export const importRouter = Router();

const rowSchema = z
  .object({ rowNumber: z.number().int().positive() })
  .catchall(z.union([z.string(), z.number(), z.boolean(), z.null()]));
const rowsSchema = z.array(rowSchema).min(1, 'The file has no data rows').max(20000, 'Maximum 20,000 rows per import');

const optionsSchema = z.object({
  duplicateStrategy: z.enum(['skip', 'update', 'ask']).default('skip'),
  decisions: z.record(z.string(), z.enum(['skip', 'update'])).optional(),
  quantityMode: z.enum(['ignore', 'set', 'add']).default('ignore'),
  createMissing: z.boolean().default(true),
});

function pickFields(rows: z.infer<typeof rowsSchema>) {
  return rows.map((r) => {
    const out: Record<string, unknown> = { rowNumber: r.rowNumber };
    for (const f of IMPORT_FIELDS) if (f in r) out[f] = r[f];
    return out as { rowNumber: number };
  });
}

importRouter.get('/template', async (_req, res) => {
  const wb = newWorkbook();
  addSheet(wb, 'Products', PRODUCT_COLUMNS, [
    { sku: 'ABC123', barcode: '5201234567890', name: 'Example product', description: 'Optional description', category: 'Beverages', supplier: 'Example Supplier S.A.', unit: 'pcs', quantity: 50, minStock: 10, location: 'A-01-03', purchasePrice: 1.2, sellingPrice: 2.5, status: 'Active' },
    { sku: 'XYZ-500', barcode: '5209876543210', name: 'Second example (kg)', description: '', category: 'Food', supplier: 'Example Supplier S.A.', unit: 'kg', quantity: 12.5, minStock: 5, location: 'B-02-01', purchasePrice: 3.4, sellingPrice: 5.9, status: 'Active' },
  ]);
  const help = wb.addWorksheet('Instructions');
  help.columns = [{ width: 18 }, { width: 12 }, { width: 90 }];
  help.addRow(['Column', 'Required', 'Notes']).font = { bold: true };
  const notes: [string, string, string][] = [
    ['SKU', 'Yes', 'Unique product code. No spaces. Used to detect existing products.'],
    ['Barcode', 'No', 'EAN / UPC / Code128. Keep the column formatted as Text so leading zeros are kept.'],
    ['Product Name', 'New only', 'Required for new products.'],
    ['Description', 'No', ''],
    ['Category', 'No', 'Created automatically if it does not exist (option in the import screen).'],
    ['Supplier', 'No', 'Created automatically if it does not exist (option in the import screen).'],
    ['Unit', 'No', 'pcs, kg, lt, m, box ... Default: pcs.'],
    ['Quantity', 'No', 'New products: initial stock (INITIAL_STOCK transaction). Existing products: see import options.'],
    ['Minimum Stock', 'No', 'Low stock alert threshold.'],
    ['Location', 'No', 'Format ZONE-RACK-SHELF, e.g. A-01-03. Created automatically.'],
    ['Purchase Price', 'No', 'Decimal comma or dot are both accepted.'],
    ['Selling Price', 'No', ''],
    ['Status', 'No', 'Active / Inactive. Default: Active.'],
  ];
  notes.forEach((n) => help.addRow(n));
  await sendWorkbook(res, wb, 'product_import_template');
});

importRouter.post('/products/validate', (req, res) => {
  const rows = pickFields(rowsSchema.parse(req.body?.rows));
  const results = validateRows(getDb(), rows);
  const summary = {
    total: results.length,
    new: results.filter((r) => r.status === 'new').length,
    existing: results.filter((r) => r.status === 'existing').length,
    errors: results.filter((r) => r.status === 'error').length,
    warnings: results.filter((r) => r.warnings.length).length,
  };
  res.json({ data: { summary, rows: results.map(({ data: _data, ...r }) => r) } });
});

importRouter.post('/products/commit', (req, res) => {
  const rows = pickFields(rowsSchema.parse(req.body?.rows));
  const options = optionsSchema.parse(req.body?.options ?? {});
  const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.slice(0, 200) : undefined;
  const summary = importRows(getDb(), actorOf(req), rows, options, fileName);
  res.json({ data: summary });
});

// ---- Export ---------------------------------------------------------------

export const exportRouter = Router();

function productRows(where: string, params: Record<string, unknown>, order = 'ORDER BY p.name COLLATE NOCASE') {
  return getDb().prepare(`${PRODUCT_SELECT} ${where} ${order}`).all(params) as ProductRow[];
}

const toProductSheetRow = (p: ProductRow) => ({
  sku: p.sku,
  barcode: p.barcode,
  name: p.name,
  description: p.description,
  category: p.category_name,
  supplier: p.supplier_name,
  unit: p.unit,
  quantity: p.quantity,
  minStock: p.min_stock,
  location: p.location_code,
  purchasePrice: p.purchase_price,
  sellingPrice: p.selling_price,
  status: p.status === 'ACTIVE' ? 'Active' : 'Inactive',
});

const INVENTORY_COLUMNS: Column[] = [
  { header: 'SKU', key: 'sku', width: 16 },
  { header: 'Barcode', key: 'barcode', width: 18, numFmt: '@' },
  { header: 'Product Name', key: 'name', width: 36 },
  { header: 'Category', key: 'category', width: 18 },
  { header: 'Supplier', key: 'supplier', width: 22 },
  { header: 'Location', key: 'location', width: 12 },
  { header: 'Quantity', key: 'quantity', width: 11, numFmt: FMT.QTY },
  { header: 'Unit', key: 'unit', width: 8 },
  { header: 'Minimum Stock', key: 'minStock', width: 15, numFmt: FMT.QTY },
  { header: 'Stock Status', key: 'stockStatus', width: 14 },
  { header: 'Purchase Price', key: 'purchasePrice', width: 15, numFmt: FMT.MONEY },
  { header: 'Stock Value', key: 'value', width: 14, numFmt: FMT.MONEY },
  { header: 'Selling Price', key: 'sellingPrice', width: 14, numFmt: FMT.MONEY },
  { header: 'Last Updated', key: 'updatedAt', width: 18, numFmt: FMT.DATETIME },
];

const STATUS_LABEL = { IN_STOCK: 'In stock', LOW_STOCK: 'LOW STOCK', OUT_OF_STOCK: 'OUT OF STOCK' };

const toInventoryRow = (p: ProductRow) => ({
  sku: p.sku,
  barcode: p.barcode,
  name: p.name,
  category: p.category_name,
  supplier: p.supplier_name,
  location: p.location_code,
  quantity: p.quantity,
  unit: p.unit,
  minStock: p.min_stock,
  stockStatus: STATUS_LABEL[p.stock_status],
  purchasePrice: p.purchase_price,
  value: Math.max(p.quantity, 0) * p.purchase_price,
  sellingPrice: p.selling_price,
  updatedAt: toDate(p.updated_at),
});

/** Products (import-compatible layout). Honours the same filters as the product list. */
exportRouter.get('/products', async (req, res) => {
  const wh = getDefaultWarehouseId();
  const q = req.query as Record<string, unknown>;
  const { where, params } = buildProductWhere(
    {
      q: str(q.q),
      categoryId: Number(q.categoryId) || undefined,
      supplierId: Number(q.supplierId) || undefined,
      locationId: Number(q.locationId) || undefined,
      zone: str(q.zone),
      status: q.status === 'ACTIVE' || q.status === 'INACTIVE' ? q.status : undefined,
      stock: ['low', 'out', 'in', 'alert'].includes(String(q.stock)) ? (q.stock as 'low') : undefined,
    },
    wh,
  );
  const wb = newWorkbook();
  addSheet(wb, 'Products', PRODUCT_COLUMNS, productRows(where, params, orderBy(str(q.sort), str(q.dir), Boolean(str(q.q)))).map(toProductSheetRow));
  await sendWorkbook(res, wb, 'products');
});

exportRouter.get('/inventory', async (_req, res) => {
  const wh = getDefaultWarehouseId();
  const rows = productRows(`WHERE p.status = 'ACTIVE'`, { warehouseId: wh }, 'ORDER BY l.code IS NULL, l.code, p.name COLLATE NOCASE');
  const wb = newWorkbook();
  const ws = addSheet(wb, 'Inventory', INVENTORY_COLUMNS, rows.map(toInventoryRow));
  const totalValue = rows.reduce((s, p) => s + Math.max(p.quantity, 0) * p.purchase_price, 0);
  const totalRow = ws.addRow({ name: 'TOTAL', quantity: rows.reduce((s, p) => s + Math.max(p.quantity, 0), 0), value: totalValue });
  totalRow.font = { bold: true };
  await sendWorkbook(res, wb, 'inventory');
});

exportRouter.get('/low-stock', async (_req, res) => {
  const wh = getDefaultWarehouseId();
  const rows = productRows(
    `WHERE p.status = 'ACTIVE' AND COALESCE(i.quantity, 0) <= p.min_stock`,
    { warehouseId: wh },
    'ORDER BY (COALESCE(i.quantity,0) <= 0) DESC, s.name COLLATE NOCASE, p.name COLLATE NOCASE',
  );
  const wb = newWorkbook();
  addSheet(
    wb,
    'Low Stock',
    [...INVENTORY_COLUMNS.slice(0, 10), { header: 'Shortage', key: 'shortage', width: 11, numFmt: FMT.QTY }, { header: 'Suggested Order', key: 'suggested', width: 16, numFmt: FMT.QTY }, { header: 'Purchase Price', key: 'purchasePrice', width: 15, numFmt: FMT.MONEY }],
    rows.map((p) => ({
      ...toInventoryRow(p),
      shortage: Math.max(p.min_stock - p.quantity, 0),
      // Suggest ordering back up to twice the minimum stock.
      suggested: Math.max(p.min_stock * 2 - p.quantity, 0),
    })),
  );
  await sendWorkbook(res, wb, 'low_stock');
});

const TX_COLUMNS: Column[] = [
  { header: 'Transaction ID', key: 'id', width: 14 },
  { header: 'Date/Time', key: 'date', width: 18, numFmt: FMT.DATETIME },
  { header: 'Type', key: 'type', width: 18 },
  { header: 'SKU', key: 'sku', width: 16 },
  { header: 'Barcode', key: 'barcode', width: 18, numFmt: '@' },
  { header: 'Product', key: 'product', width: 34 },
  { header: 'Previous Qty', key: 'before', width: 13, numFmt: FMT.QTY },
  { header: 'Change', key: 'change', width: 10, numFmt: '+#,##0.###;-#,##0.###' },
  { header: 'New Qty', key: 'after', width: 10, numFmt: FMT.QTY },
  { header: 'Unit', key: 'unit', width: 8 },
  { header: 'Reference', key: 'reference', width: 26 },
  { header: 'Notes', key: 'notes', width: 34 },
  { header: 'Source', key: 'source', width: 12 },
  { header: 'User', key: 'user', width: 16 },
];

exportRouter.get('/transactions', async (req, res) => {
  const filters = readTxFilters(req.query);
  const preset = str(req.query.preset);
  if (preset === 'stock-in') filters.types = ['STOCK_IN'];
  if (preset === 'stock-out') filters.types = ['STOCK_OUT'];
  const { where, params } = buildTxWhere(filters);
  const rows = getDb()
    .prepare(`${TX_SELECT} ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT 200000`)
    .all(params) as Record<string, unknown>[];
  const wb = newWorkbook();
  addSheet(
    wb,
    preset === 'stock-in' ? 'Stock IN' : preset === 'stock-out' ? 'Stock OUT' : 'Transactions',
    TX_COLUMNS,
    rows.map((t) => ({
      id: t.id,
      date: toDate(t.created_at),
      type: t.type,
      sku: t.sku,
      barcode: t.barcode,
      product: t.product_name,
      before: t.quantity_before,
      change: t.quantity_change,
      after: t.quantity_after,
      unit: t.unit,
      reference: t.reference,
      notes: t.notes,
      source: t.source_type,
      user: t.username,
    })),
  );
  await sendWorkbook(res, wb, preset === 'stock-in' ? 'stock_in' : preset === 'stock-out' ? 'stock_out' : 'stock_movements');
});

/** Receipt / dispatch document lines. */
exportRouter.get('/documents/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (kind !== 'receipts' && kind !== 'dispatches') throw badRequest('Unknown document type');
  const from = str(req.query.from);
  const to = str(req.query.to);
  const r = kind === 'receipts';
  const where: string[] = [];
  if (from) where.push(`d.${r ? 'receipt_date' : 'dispatch_date'} >= @from`);
  if (to) where.push(`d.${r ? 'receipt_date' : 'dispatch_date'} <= @to`);
  const rows = getDb()
    .prepare(
      r
        ? `SELECT d.receipt_number AS number, d.receipt_date AS date, d.status, s.name AS party, d.invoice_number AS ref,
                  p.sku, p.barcode, p.name, it.quantity, p.unit, it.unit_cost AS price, u.username
           FROM stock_receipt_items it JOIN stock_receipts d ON d.id = it.receipt_id JOIN products p ON p.id = it.product_id
           LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN users u ON u.id = d.created_by
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.receipt_date DESC, d.id DESC, it.id`
        : `SELECT d.dispatch_number AS number, d.dispatch_date AS date, d.status, d.customer_name AS party, d.reference AS ref,
                  p.sku, p.barcode, p.name, it.quantity, p.unit, it.unit_price AS price, u.username
           FROM stock_dispatch_items it JOIN stock_dispatches d ON d.id = it.dispatch_id JOIN products p ON p.id = it.product_id
           LEFT JOIN users u ON u.id = d.created_by
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.dispatch_date DESC, d.id DESC, it.id`,
    )
    .all({ from, to }) as Record<string, unknown>[];
  const wb = newWorkbook();
  addSheet(
    wb,
    r ? 'Receipts' : 'Dispatches',
    [
      { header: r ? 'Receipt No' : 'Dispatch No', key: 'number', width: 16 },
      { header: 'Date', key: 'date', width: 12, numFmt: FMT.DATE },
      { header: 'Status', key: 'status', width: 12 },
      { header: r ? 'Supplier' : 'Customer', key: 'party', width: 26 },
      { header: r ? 'Invoice No' : 'Reference', key: 'ref', width: 18 },
      { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Barcode', key: 'barcode', width: 18, numFmt: '@' },
      { header: 'Product', key: 'name', width: 34 },
      { header: 'Quantity', key: 'quantity', width: 11, numFmt: FMT.QTY },
      { header: 'Unit', key: 'unit', width: 8 },
      { header: r ? 'Unit Cost' : 'Unit Price', key: 'price', width: 12, numFmt: FMT.MONEY },
      { header: 'Line Value', key: 'value', width: 12, numFmt: FMT.MONEY },
      { header: 'User', key: 'username', width: 14 },
    ],
    rows.map((x) => ({ ...x, date: x.date ? new Date(`${x.date}T00:00:00Z`) : null, value: x.price != null ? Number(x.price) * Number(x.quantity) : null })),
  );
  await sendWorkbook(res, wb, r ? 'stock_receipts' : 'stock_dispatches');
});

/** One worksheet per category or supplier, plus a summary sheet. */
exportRouter.get('/grouped/:by', async (req, res) => {
  const by = req.params.by;
  if (by !== 'category' && by !== 'supplier') throw badRequest('Group by category or supplier');
  const wh = getDefaultWarehouseId();
  const rows = productRows('', { warehouseId: wh }, `ORDER BY ${by === 'category' ? 'c.name' : 's.name'} COLLATE NOCASE, p.name COLLATE NOCASE`);
  const groups = new Map<string, ProductRow[]>();
  for (const p of rows) {
    const key = (by === 'category' ? p.category_name : p.supplier_name) ?? (by === 'category' ? 'Uncategorised' : 'No supplier');
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const wb = newWorkbook();
  addSheet(
    wb,
    'Summary',
    [
      { header: by === 'category' ? 'Category' : 'Supplier', key: 'name', width: 30 },
      { header: 'Products', key: 'products', width: 10 },
      { header: 'Total Units', key: 'units', width: 12, numFmt: FMT.QTY },
      { header: 'Stock Value', key: 'value', width: 14, numFmt: FMT.MONEY },
      { header: 'Low / Out of Stock', key: 'alerts', width: 18 },
    ],
    [...groups.entries()].map(([name, ps]) => ({
      name,
      products: ps.length,
      units: ps.reduce((s, p) => s + Math.max(p.quantity, 0), 0),
      value: ps.reduce((s, p) => s + Math.max(p.quantity, 0) * p.purchase_price, 0),
      alerts: ps.filter((p) => p.stock_status !== 'IN_STOCK').length,
    })),
  );
  for (const [name, ps] of groups) addSheet(wb, name, INVENTORY_COLUMNS, ps.map(toInventoryRow));
  await sendWorkbook(res, wb, by === 'category' ? 'products_by_category' : 'products_by_supplier');
});

