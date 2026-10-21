import { getDefaultWarehouseId, type DB } from '../db/index.js';
import { escapeLike, searchWords } from './http.js';

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/** Product row joined with category, supplier and stock in the given warehouse. */
export const PRODUCT_SELECT = /* sql */ `
  SELECT p.id, p.sku, p.barcode, p.name, p.description, p.category_id, p.supplier_id, p.unit,
         p.min_stock, p.purchase_price, p.selling_price, p.image_path, p.status,
         p.created_at, p.updated_at, p.parent_id, p.size,
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
  /** Empty (null) when not set. */
  selling_price: number | null;
  image_path: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
  parent_id: number | null;
  size: string | null;
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
    parentId: p.parent_id,
    size: p.size,
  };
}
export type ProductDTO = ReturnType<typeof serializeProduct>;

export async function getProduct(db: DB, id: number, warehouseId?: number): Promise<ProductRow | undefined> {
  const wh = warehouseId ?? (await getDefaultWarehouseId(db));
  return db.get<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = @id`, { id, warehouseId: wh });
}

/**
 * Exact lookup by barcode or SKU — used by the barcode scanner (index seek). SKUs may contain
 * spaces: letter case and the number of spaces do not matter; barcodes match without spaces.
 */
export async function lookupByCode(db: DB, code: string, warehouseId?: number): Promise<ProductRow[]> {
  const c = code.trim();
  if (!c) return [];
  const wh = warehouseId ?? (await getDefaultWarehouseId(db));
  return db.all<ProductRow>(
    `${PRODUCT_SELECT}
     WHERE p.id IN (SELECT id FROM products WHERE ims_compact(barcode::text) = ims_compact(@code)
                    UNION SELECT id FROM products WHERE ims_key(sku::text) = ims_key(@code))
     ORDER BY (p.status = 'ACTIVE') DESC, COALESCE(ims_compact(p.barcode::text) = ims_compact(@code), false) DESC, lower(p.name)`,
    { code: c, warehouseId: wh },
  );
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
  const params: Record<string, string | number> = { warehouseId };
  if (f.q) {
    const q = f.q.trim();
    params.q = q;
    params.like = `%${escapeLike(q)}%`;
    // An exact SKU, barcode or name (spaces and letter case ignored), or every word below.
    const parts = ['ims_key(p.sku::text) = ims_key(@q)', 'ims_compact(p.barcode::text) = ims_compact(@q)', 'ims_key(p.name) = ims_key(@q)'];
    // Every word must appear in name, SKU, barcode or description (accents and case ignored).
    const words = searchWords(q);
    if (words.length) {
      words.forEach((w, i) => (params[`w${i}`] = `%${escapeLike(w)}%`));
      parts.push(`(${words.map((_, i) => `p.search_text LIKE ims_norm(@w${i}) ESCAPE '\\'`).join(' AND ')})`);
    }
    parts.push(`p.category_id IN (SELECT id FROM categories WHERE ims_norm(name::text) LIKE ims_norm(@like) ESCAPE '\\')`);
    parts.push(`p.supplier_id IN (SELECT id FROM suppliers WHERE ims_norm(name::text) LIKE ims_norm(@like) ESCAPE '\\')`);
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
  name: 'lower(p.name)',
  sku: 'p.sku',
  barcode: 'p.barcode',
  category: 'c.name',
  supplier: 's.name',
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
  if (hasQuery)
    return `ORDER BY COALESCE(ims_key(p.sku::text) = ims_key(@q) OR ims_compact(p.barcode::text) = ims_compact(@q), false) DESC,
      COALESCE(ims_key(p.name) = ims_key(@q), false) DESC, lower(p.name), p.id`;
  return 'ORDER BY lower(p.name), p.id';
}

export async function listProducts(
  db: DB,
  f: ProductFilters & { sort?: string; dir?: string },
  page: { limit: number; offset: number },
  warehouseId?: number,
) {
  const wh = warehouseId ?? (await getDefaultWarehouseId(db));
  const { where, params } = buildProductWhere(f, wh);
  const base = `FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = @warehouseId
    LEFT JOIN warehouse_locations l ON l.id = i.location_id
    ${where}`;
  const total = (await db.value<number>(`SELECT COUNT(*) ${base}`, params)) ?? 0;
  const rows = await db.all<ProductRow>(
    `${PRODUCT_SELECT} ${where} ${orderBy(f.sort, f.dir, Boolean(f.q))} LIMIT @limit OFFSET @offset`,
    { ...params, limit: page.limit, offset: page.offset },
  );
  return { total, rows };
}
