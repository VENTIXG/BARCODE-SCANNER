import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { getDb, getDefaultWarehouseId, nowIso, type DB } from '../db/index.js';
import { actorOf, requirePermission } from '../middleware/auth.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, num, optText, pagination, str } from '../lib/http.js';
import { findOrCreateLocation } from '../lib/locations.js';
import {
  getProduct,
  listProducts,
  lookupByCode,
  serializeProduct,
  type ProductFilters,
  type ProductRow,
} from '../lib/products.js';
import { applyStockChange, setProductLocation } from '../lib/stock.js';
import { idempotencyKeySchema, runIdempotent } from '../lib/idempotency.js';

export const productsRouter = Router();

/**
 * SKU or barcode: spaces inside are kept as typed (only the ends are trimmed); tabs and line
 * breaks are refused. Codes that differ only in spacing or letter case count as the same code.
 */
const code = z
  .string()
  .trim()
  .max(64)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'must not contain tabs or line breaks');

const productBody = z.object({
  sku: code.min(1, 'SKU is required'),
  barcode: code.nullish().transform((v) => (v ? v : null)),
  name: z.string().trim().min(1, 'Name is required').max(200),
  description: optText(2000),
  categoryId: z.number().int().positive().nullish(),
  supplierId: z.number().int().positive().nullish(),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  minStock: z.number().min(0).default(0),
  purchasePrice: z.number().min(0).default(0),
  /** Empty (null) = no selling price set. Left out on an update: the current one is kept. */
  sellingPrice: z.number().min(0).nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  locationCode: optText(40),
  /** Required to save a barcode that another product already uses. */
  confirmDuplicateBarcode: z.boolean().optional(),
});

const createBody = productBody.extend({
  initialQuantity: z.number().min(0).default(0),
});

function readFilters(query: Record<string, unknown>): ProductFilters & { sort?: string; dir?: string } {
  const stock = str(query.stock);
  const status = str(query.status);
  return {
    q: str(query.q),
    categoryId: num(query.categoryId),
    supplierId: num(query.supplierId),
    locationId: num(query.locationId),
    zone: str(query.zone),
    status: status === 'ACTIVE' || status === 'INACTIVE' ? status : undefined,
    stock: stock === 'low' || stock === 'out' || stock === 'in' || stock === 'alert' ? stock : undefined,
    sort: str(query.sort),
    dir: str(query.dir),
  };
}

productsRouter.get('/', async (req, res) => {
  const db = getDb();
  const { page, pageSize, offset } = pagination(req.query);
  const { total, rows } = await listProducts(db, readFilters(req.query), { limit: pageSize, offset });
  res.json({ data: rows.map(serializeProduct), total, page, pageSize });
});

/** Barcode / SKU exact lookup (scanner). Returns all matches. */
productsRouter.get('/lookup', async (req, res) => {
  const c = str(req.query.code);
  if (!c) throw badRequest('code is required');
  res.json({ data: (await lookupByCode(getDb(), c)).map(serializeProduct) });
});

/** Live uniqueness check for the product form. */
productsRouter.get('/check-unique', async (req, res) => {
  const db = getDb();
  const excludeId = num(req.query.excludeId) ?? 0;
  const sku = str(req.query.sku);
  const barcode = str(req.query.barcode);
  const skuMatch = sku
    ? ((await db.get('SELECT id, sku, name FROM products WHERE ims_key(sku::text) = ims_key(?) AND id <> ?', sku, excludeId)) ?? null)
    : null;
  const barcodeMatches = barcode
    ? await db.all('SELECT id, sku, name FROM products WHERE ims_compact(barcode::text) = ims_compact(?) AND id <> ?', barcode, excludeId)
    : [];
  res.json({ sku: skuMatch, barcode: barcodeMatches });
});

productsRouter.get('/:id', async (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const p = await getProduct(db, id);
  if (!p) throw notFound('Product not found');
  const variants = [];
  for (const vid of await db.column<number>('SELECT id FROM products WHERE parent_id = ? ORDER BY id', id))
    variants.push(serializeProduct((await getProduct(db, vid))!));
  const stats = await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN quantity_change > 0 THEN quantity_change END), 0) AS "totalIn",
       COALESCE(SUM(CASE WHEN quantity_change < 0 THEN -quantity_change END), 0) AS "totalOut",
       COUNT(*) AS transactions,
       MAX(CASE WHEN type = 'STOCK_IN' THEN created_at END) AS "lastStockIn",
       MAX(CASE WHEN type = 'STOCK_OUT' THEN created_at END) AS "lastStockOut"
     FROM inventory_transactions WHERE product_id = ?`,
    id,
  );
  const duplicates = p.barcode
    ? await db.all('SELECT id, sku, name FROM products WHERE ims_compact(barcode::text) = ims_compact(?) AND id <> ?', p.barcode, id)
    : [];
  res.json({ data: serializeProduct(p), stats, barcodeDuplicates: duplicates, variants });
});

productsRouter.get('/:id/transactions', async (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const { page, pageSize, offset } = pagination(req.query, 50);
  const total = await db.value<number>('SELECT COUNT(*) FROM inventory_transactions WHERE product_id = ?', id);
  const rows = await db.all(
    `SELECT t.*, u.username, u.full_name AS user_full_name
     FROM inventory_transactions t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.product_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    id,
    pageSize,
    offset,
  );
  res.json({ data: rows, total, page, pageSize });
});

async function assertCodesAvailable(
  db: DB,
  body: { sku: string; barcode: string | null; confirmDuplicateBarcode?: boolean },
  excludeId = 0,
) {
  // "AB  12" and "ab 12" are the same SKU: no second product that differs only in spacing.
  const skuOwner = await db.get<{ id: number; sku: string; name: string }>(
    'SELECT id, sku, name FROM products WHERE ims_key(sku::text) = ims_key(?) AND id <> ?',
    body.sku,
    excludeId,
  );
  if (skuOwner) throw conflict(`SKU ${body.sku} is already used by "${skuOwner.name}" (${skuOwner.sku})`, 'DUPLICATE_SKU', skuOwner);
  if (body.barcode && !body.confirmDuplicateBarcode) {
    const others = await db.all<{ id: number; sku: string; name: string }>(
      'SELECT id, sku, name FROM products WHERE ims_compact(barcode::text) = ims_compact(?) AND id <> ?',
      body.barcode,
      excludeId,
    );
    if (others.length)
      throw conflict(
        `Barcode ${body.barcode} is already used by ${others.map((o) => o.sku).join(', ')}. Confirm to save a duplicate barcode.`,
        'DUPLICATE_BARCODE',
        { products: others },
      );
  }
}

async function assertRefs(db: DB, body: { categoryId?: number | null; supplierId?: number | null }) {
  if (body.categoryId && !(await db.get('SELECT 1 FROM categories WHERE id = ?', body.categoryId))) throw badRequest('Category not found');
  if (body.supplierId && !(await db.get('SELECT 1 FROM suppliers WHERE id = ?', body.supplierId))) throw badRequest('Supplier not found');
}

productsRouter.post('/', requirePermission('products.manage'), async (req, res) => {
  const db = getDb();
  const actor = actorOf(req);
  const body = createBody.parse(req.body);

  const id = await db.tx(async (t) => {
    const warehouseId = await getDefaultWarehouseId(t);
    await assertCodesAvailable(t, body);
    await assertRefs(t, body);
    const productId = (await t.value<number>(
      `INSERT INTO products (sku, barcode, name, description, category_id, supplier_id, unit, min_stock,
         purchase_price, selling_price, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      body.sku,
      body.barcode,
      body.name,
      body.description,
      body.categoryId ?? null,
      body.supplierId ?? null,
      body.unit,
      body.minStock,
      body.purchasePrice,
      body.sellingPrice ?? null,
      body.status,
      actor.id,
    )) as number;
    const locationId = body.locationCode ? await findOrCreateLocation(t, warehouseId, body.locationCode) : null;
    await setProductLocation(t, productId, warehouseId, locationId);
    await audit(t, actor, {
      action: 'PRODUCT.CREATE',
      entityType: 'product',
      entityId: productId,
      productId,
      description: `${actor.username} added new product ${body.sku} (${body.name}).`,
      newValue: body,
    });
    if (body.initialQuantity > 0) {
      await applyStockChange(t, actor, {
        productId,
        warehouseId,
        type: 'INITIAL_STOCK',
        quantity: body.initialQuantity,
        notes: 'Initial stock on product creation',
        sourceType: 'PRODUCT',
        sourceId: productId,
        unitCost: body.purchasePrice,
      });
    }
    return productId;
  });

  res.status(201).json({ data: serializeProduct((await getProduct(db, id))!) });
});

const FIELD_LABELS: Partial<Record<keyof ProductRow, string>> = {
  sku: 'SKU',
  barcode: 'barcode',
  name: 'name',
  description: 'description',
  category_name: 'category',
  supplier_name: 'supplier',
  unit: 'unit',
  min_stock: 'minimum stock',
  purchase_price: 'purchase price',
  selling_price: 'selling price',
  status: 'status',
  location_code: 'location',
};

productsRouter.put('/:id', requirePermission('products.manage'), async (req, res) => {
  const db = getDb();
  const actor = actorOf(req);
  const id = idParam(req.params.id);
  const parsed = productBody.parse(req.body);
  // A field left out of the request keeps its stored value: an update that only sends some
  // fields never resets prices, stock levels or the location to their defaults.
  const sent = (k: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, k);

  await db.tx(async (t) => {
    const warehouseId = await getDefaultWarehouseId(t);
    const before = await getProduct(t, id);
    if (!before) throw notFound('Product not found');
    const body = {
      ...parsed,
      barcode: sent('barcode') ? parsed.barcode : before.barcode,
      description: sent('description') ? parsed.description : before.description,
      categoryId: sent('categoryId') ? parsed.categoryId : before.category_id,
      supplierId: sent('supplierId') ? parsed.supplierId : before.supplier_id,
      unit: sent('unit') ? parsed.unit : before.unit,
      minStock: sent('minStock') ? parsed.minStock : before.min_stock,
      purchasePrice: sent('purchasePrice') ? parsed.purchasePrice : before.purchase_price,
      sellingPrice: sent('sellingPrice') ? (parsed.sellingPrice ?? null) : before.selling_price,
      status: sent('status') ? parsed.status : before.status,
    };
    // Only re-check the barcode if it actually changed.
    await assertCodesAvailable(
      t,
      { ...body, confirmDuplicateBarcode: body.confirmDuplicateBarcode || body.barcode === before.barcode },
      id,
    );
    await assertRefs(t, body);
    await t.run(
      `UPDATE products SET sku = ?, barcode = ?, name = ?, description = ?, category_id = ?, supplier_id = ?,
         unit = ?, min_stock = ?, purchase_price = ?, selling_price = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      body.sku,
      body.barcode,
      body.name,
      body.description,
      body.categoryId ?? null,
      body.supplierId ?? null,
      body.unit,
      body.minStock,
      body.purchasePrice,
      body.sellingPrice,
      body.status,
      nowIso(),
      id,
    );
    if (sent('locationCode')) {
      const locationId = body.locationCode ? await findOrCreateLocation(t, warehouseId, body.locationCode) : null;
      await setProductLocation(t, id, warehouseId, locationId);
    }

    const after = (await getProduct(t, id))!;
    const d = diff(before, after, FIELD_LABELS);
    if (d.changed) {
      await audit(t, actor, {
        action: 'PRODUCT.UPDATE',
        entityType: 'product',
        entityId: id,
        productId: id,
        description: `${actor.username} changed ${d.phrases.join('; ')} on ${after.sku}.`,
        oldValue: d.oldValue,
        newValue: d.newValue,
      });
    }
  });

  res.json({ data: serializeProduct((await getProduct(db, id))!) });
});

productsRouter.delete('/:id', requirePermission('products.delete'), async (req, res) => {
  const actor = actorOf(req);
  const id = idParam(req.params.id);
  await getDb().tx(async (t) => {
    const p = await getProduct(t, id);
    if (!p) throw notFound('Product not found');
    const used =
      (await t.get('SELECT 1 FROM stock_receipt_items WHERE product_id = ? LIMIT 1', id)) ||
      (await t.get('SELECT 1 FROM stock_dispatch_items WHERE product_id = ? LIMIT 1', id)) ||
      (await t.get(`SELECT 1 FROM inventory_transactions WHERE product_id = ? AND type <> 'INITIAL_STOCK' LIMIT 1`, id));
    const sizes = (await t.value<number>('SELECT COUNT(*) FROM products WHERE parent_id = ?', id)) ?? 0;
    if (sizes)
      throw conflict(
        `This product has ${sizes} sizes with their own stock history. Set it to Inactive, or delete the sizes first.`,
        'PRODUCT_HAS_VARIANTS',
      );
    if (used)
      throw conflict(
        'This product has stock movements and cannot be deleted without losing history. Set it to Inactive instead.',
        'PRODUCT_IN_USE',
      );
    await audit(t, actor, {
      action: 'PRODUCT.DELETE',
      entityType: 'product',
      entityId: id,
      description: `${actor.username} deleted product ${p.sku} (${p.name}).`,
      oldValue: serializeProduct(p),
    });
    // The photo goes with the product (product_images: ON DELETE CASCADE).
    await t.run('DELETE FROM products WHERE id = ?', id);
  });
  res.status(204).end();
});

// ---- Sizes / variants --------------------------------------------------------

const variantBody = z.object({
  idempotencyKey: idempotencyKeySchema,
  variants: z
    .array(
      z.object({
        size: z.string().trim().min(1, 'Size is required').max(20),
        sku: code.min(1, 'SKU is required'),
        barcode: code.nullish().transform((v) => (v ? v : null)),
        minStock: z.number().min(0).default(0),
        initialQuantity: z.number().min(0).default(0),
      }),
    )
    .min(1)
    .max(40),
});

/**
 * Add sizes to a product. Each size becomes a product of its own: its SKU and
 * barcode are scanned and counted separately, and its history is separate.
 * Category, supplier, prices and location are copied from the base product.
 */
productsRouter.post('/:id/variants', requirePermission('products.manage'), async (req, res) => {
  const db = getDb();
  const actor = actorOf(req);
  const parentId = idParam(req.params.id);
  const body = variantBody.parse(req.body);
  const out = await runIdempotent(db, actor, body.idempotencyKey, `variants:${parentId}`, async () => {
    const warehouseId = await getDefaultWarehouseId(db);
    const parent = await getProduct(db, parentId);
    if (!parent) throw notFound('Product not found');
    if (parent.parent_id) throw badRequest('Sizes can only be added to a base product, not to a size');
    const seen = new Set<string>();
    for (const v of body.variants) {
      const key = v.size.toLowerCase();
      if (seen.has(key)) throw badRequest(`Size ${v.size} is listed more than once`);
      seen.add(key);
    }
    const createdIds: number[] = [];
    for (const v of body.variants) {
      await assertCodesAvailable(db, { sku: v.sku, barcode: v.barcode });
      const id = (await db.value<number>(
        `INSERT INTO products (sku, barcode, name, description, category_id, supplier_id, unit, min_stock,
           purchase_price, selling_price, status, created_by, parent_id, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        v.sku,
        v.barcode,
        `${parent.name} ${v.size}`,
        parent.description,
        parent.category_id,
        parent.supplier_id,
        parent.unit,
        v.minStock,
        parent.purchase_price,
        parent.selling_price,
        parent.status,
        actor.id,
        parentId,
        v.size,
      )) as number;
      await setProductLocation(db, id, warehouseId, parent.location_id);
      if (v.initialQuantity > 0)
        await applyStockChange(db, actor, {
          productId: id,
          warehouseId,
          type: 'INITIAL_STOCK',
          quantity: v.initialQuantity,
          notes: `Opening stock for size ${v.size}`,
          sourceType: 'PRODUCT',
          sourceId: id,
        });
      createdIds.push(id);
    }
    await audit(db, actor, {
      action: 'PRODUCT.VARIANTS',
      entityType: 'product',
      entityId: parentId,
      productId: parentId,
      description: `${actor.username} added sizes ${body.variants.map((v) => v.size).join(', ')} to ${parent.sku}.`,
      newValue: { sizes: body.variants.map((v) => ({ size: v.size, sku: v.sku })) },
    });
    const created = [];
    for (const id of createdIds) created.push(serializeProduct((await getProduct(db, id))!));
    return { status: 201, body: { data: created } };
  });
  res.status(out.status).json(out.body);
});

// ---- Product image (stored in the database: product_images) -------------------

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** The image type from the file's first bytes; null when it is not a JPG, PNG, WEBP or GIF. */
export function sniffImage(b: Buffer): { type: string; ext: string } | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: '.jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: '.png' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return { type: 'image/gif', ext: '.gif' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
    return { type: 'image/webp', ext: '.webp' };
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(badRequest('Only JPG, PNG, WEBP or GIF images are allowed'));
  },
});

productsRouter.post('/:id/image', requirePermission('products.manage'), upload.single('image'), async (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  if (!req.file) throw badRequest('No image uploaded');
  const file = req.file;
  // The declared type is only what the browser says: the content must really be an image.
  const image = sniffImage(file.buffer);
  if (!image) throw badRequest('Only JPG, PNG, WEBP or GIF images are allowed');
  await db.tx(async (t) => {
    const p = await getProduct(t, id);
    if (!p) throw notFound('Product not found');
    const name = `p_${crypto.randomBytes(10).toString('hex')}${image.ext}`;
    await t.run('INSERT INTO product_images (name, product_id, content_type, data) VALUES (?, ?, ?, ?)', name, id, image.type, file.buffer);
    await t.run('UPDATE products SET image_path = ?, updated_at = ? WHERE id = ?', name, nowIso(), id);
    if (p.image_path) await t.run('DELETE FROM product_images WHERE name = ?', p.image_path);
    await audit(t, actorOf(req), {
      action: 'PRODUCT.IMAGE',
      entityType: 'product',
      entityId: id,
      productId: id,
      description: `${req.user!.username} updated the photo of ${p.sku}.`,
    });
  });
  res.json({ data: serializeProduct((await getProduct(db, id))!) });
});

productsRouter.delete('/:id/image', requirePermission('products.manage'), async (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  await db.tx(async (t) => {
    const p = await getProduct(t, id);
    if (!p) throw notFound('Product not found');
    if (!p.image_path) return;
    await t.run('UPDATE products SET image_path = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
    await t.run('DELETE FROM product_images WHERE name = ?', p.image_path);
    await audit(t, actorOf(req), {
      action: 'PRODUCT.IMAGE',
      entityType: 'product',
      entityId: id,
      productId: id,
      description: `${req.user!.username} removed the photo of ${p.sku}.`,
    });
  });
  res.json({ data: serializeProduct((await getProduct(db, id))!) });
});
