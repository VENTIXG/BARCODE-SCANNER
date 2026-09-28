import { getDefaultWarehouseId, normalizeText, type DB } from '../db/index.js';
import { escapeLike, ftsQuery } from './http.js';

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/** Product row joined with category, supplier and stock in the given warehouse. */
export const PRODUCT_SELECT = /* sql */ `
  SELECT p.id, p.sku, p.barcode, p.name, p.description, p.category_id, p.supplier_id, p.unit,
         p.min_stock, p.purchase_price, p.selling_price, p.image_path, p.status,
         p.created_at, p.updated_at,
         c.name AS category_name, s.name AS supplier_name,
         COALESCE(i.quantity, 0) AS quantity,
         i.location_id, l.code AS location_code,
         CASE WHEN COALESCE(i.quantity, 0) <= 0 THEN 'OUT_OF_STOCK'
              WHEN COALESCE(i.quantity, 0) <= p.min_stock THEN 'LOW_STOCK'
              ELSE 'IN_STOCK' END AS stock_status
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN suppliers s ON s.id = p.supplier_id
  LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = @warehouseId
  LEFT JOIN warehouse_locations l ON l.id = i.location_id
`;

export interface ProductRow {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  category_id: number | null;
  supplier_id: number | null;
  unit: string;
  min_stock: number;
  purchase_price: number;
  selling_price: number;
  image_path: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
  category_name: string | null;
  supplier_name: string | null;
  quantity: number;
  location_id: number | null;
  location_code: string | null;
  stock_status: StockStatus;
}

export function serializeProduct(p: ProductRow) {
  return {
    id: p.id,
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    description: p.description,
    categoryId: p.category_id,
    categoryName: p.category_name,
    supplierId: p.supplier_id,
    supplierName: p.supplier_name,
    unit: p.unit,
    quantity: p.quantity,
    minStock: p.min_stock,
    locationId: p.location_id,
    locationCode: p.location_code,
    purchasePrice: p.purchase_price,
    sellingPrice: p.selling_price,
    imageUrl: p.image_path ? `/uploads/${p.image_path}` : null,
    status: p.status,
    stockStatus: p.stock_status,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}
export type ProductDTO = ReturnType<typeof serializeProduct>;

export function getProduct(db: DB, id: number, warehouseId = getDefaultWarehouseId(db)): ProductRow | undefined {
  return db.prepare(`${PRODUCT_SELECT} WHERE p.id = @id`).get({ id, warehouseId }) as ProductRow | undefined;
}

/** Exact lookup by barcode or SKU — used by the barcode scanner (index seek). */
export function lookupByCode(db: DB, code: string, warehouseId = getDefaultWarehouseId(db)): ProductRow[] {
  const c = code.trim();
  if (!c) return [];
  return db
    .prepare(
      `${PRODUCT_SELECT}
       WHERE p.id IN (SELECT id FROM products WHERE barcode = @code UNION SELECT id FROM products WHERE sku = @code)
       ORDER BY (p.status = 'ACTIVE') DESC, (p.barcode = @code) DESC, p.name`,
    )
    .all({ code: c, warehouseId }) as ProductRow[];
}

export interface ProductFilters {
  q?: string;
  categoryId?: number;
  supplierId?: number;
  locationId?: number;
  zone?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  stock?: 'low' | 'out' | 'in' | 'alert';
}

/** Builds WHERE clause + params shared by list, export and search. */
export function buildProductWhere(f: ProductFilters, warehouseId: number) {
  const where: string[] = [];
  const params: Record<string, unknown> = { warehouseId };
  if (f.q) {
    const q = f.q.trim();
    params.q = q;
    params.like = `%${escapeLike(normalizeText(q))}%`;
    const fts = ftsQuery(q);
    const parts = ['p.sku = @q', 'p.barcode = @q'];
    if (fts) {
      params.fts = fts;
      parts.push('p.id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH @fts)');
    }
    parts.push(`p.category_id IN (SELECT id FROM categories WHERE ims_norm(name) LIKE @like ESCAPE '\\')`);
    parts.push(`p.supplier_id IN (SELECT id FROM suppliers WHERE ims_norm(name) LIKE @like ESCAPE '\\')`);
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.categoryId) {
    where.push('p.category_id = @categoryId');
    params.categoryId = f.categoryId;
  }
  if (f.supplierId) {
    where.push('p.supplier_id = @supplierId');
    params.supplierId = f.supplierId;
  }
  if (f.locationId) {
    where.push('i.location_id = @locationId');
    params.locationId = f.locationId;
  }
  if (f.zone) {
    where.push('l.zone = @zone');
    params.zone = f.zone;
  }
  if (f.status) {
    where.push('p.status = @status');
    params.status = f.status;
  }
  const qty = 'COALESCE(i.quantity, 0)';
  if (f.stock === 'out') where.push(`${qty} <= 0`);
  if (f.stock === 'low') where.push(`${qty} > 0 AND ${qty} <= p.min_stock`);
  if (f.stock === 'alert') where.push(`${qty} <= p.min_stock OR ${qty} <= 0`);
  if (f.stock === 'in') where.push(`${qty} > p.min_stock AND ${qty} > 0`);
  return { where: where.length ? `WHERE ${where.map((w) => `(${w})`).join(' AND ')}` : '', params };
}

const SORTS: Record<string, string> = {
  name: 'p.name COLLATE NOCASE',
  sku: 'p.sku',
  barcode: 'p.barcode',
  category: 'c.name COLLATE NOCASE',
  supplier: 's.name COLLATE NOCASE',
  quantity: 'COALESCE(i.quantity, 0)',
  minStock: 'p.min_stock',
  location: 'l.code',
  purchasePrice: 'p.purchase_price',
  sellingPrice: 'p.selling_price',
  value: 'COALESCE(i.quantity, 0) * p.purchase_price',
  updatedAt: 'p.updated_at',
  createdAt: 'p.created_at',
};

export function orderBy(sort: string | undefined, dir: string | undefined, hasQuery: boolean) {
  const direction = dir === 'desc' ? 'DESC' : 'ASC';
  const col = sort && SORTS[sort];
  if (col) return `ORDER BY ${col} ${direction}, p.id`;
  // Relevance: exact SKU/barcode matches first.
  if (hasQuery) return `ORDER BY (p.sku = @q OR p.barcode = @q) DESC, p.name COLLATE NOCASE`;
  return 'ORDER BY p.name COLLATE NOCASE, p.id';
}

export function listProducts(
  db: DB,
  f: ProductFilters & { sort?: string; dir?: string },
  page: { limit: number; offset: number },
  warehouseId = getDefaultWarehouseId(db),
) {
  const { where, params } = buildProductWhere(f, warehouseId);
  const base = `FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = @warehouseId
    LEFT JOIN warehouse_locations l ON l.id = i.location_id
    ${where}`;
  const total = db.prepare(`SELECT COUNT(*) ${base}`).pluck().get(params) as number;
  const rows = db
    .prepare(`${PRODUCT_SELECT} ${where} ${orderBy(f.sort, f.dir, Boolean(f.q))} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: page.limit, offset: page.offset }) as ProductRow[];
  return { total, rows };
}
