import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb, getDefaultWarehouseId, nowIso } from '../db/index.js';
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

const code = z
  .string()
  .trim()
  .max(64)
  .refine((v) => !/\s/.test(v), 'must not contain spaces');

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
  sellingPrice: z.number().min(0).default(0),
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

productsRouter.get('/', (req, res) => {
  const db = getDb();
  const { page, pageSize, offset } = pagination(req.query);
  const { total, rows } = listProducts(db, readFilters(req.query), { limit: pageSize, offset });
  res.json({ data: rows.map(serializeProduct), total, page, pageSize });
});

/** Barcode / SKU exact lookup (scanner). Returns all matches. */
productsRouter.get('/lookup', (req, res) => {
  const c = str(req.query.code);
  if (!c) throw badRequest('code is required');
  res.json({ data: lookupByCode(getDb(), c).map(serializeProduct) });
});

/** Live uniqueness check for the product form. */
productsRouter.get('/check-unique', (req, res) => {
  const db = getDb();
  const excludeId = num(req.query.excludeId) ?? 0;
  const sku = str(req.query.sku);
  const barcode = str(req.query.barcode);
  const skuMatch = sku
    ? (db.prepare('SELECT id, sku, name FROM products WHERE sku = ? AND id <> ?').get(sku, excludeId) ?? null)
    : null;
  const barcodeMatches = barcode
    ? db.prepare('SELECT id, sku, name FROM products WHERE barcode = ? AND id <> ?').all(barcode, excludeId)
    : [];
  res.json({ sku: skuMatch, barcode: barcodeMatches });
});

productsRouter.get('/:id', (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const p = getProduct(db, id);
  if (!p) throw notFound('Product not found');
  const variants = (db.prepare('SELECT id FROM products WHERE parent_id = ? ORDER BY id').pluck().all(id) as number[]).map(
    (vid) => serializeProduct(getProduct(db, vid)!),
  );
  const stats = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN quantity_change > 0 THEN quantity_change END), 0) AS totalIn,
         COALESCE(SUM(CASE WHEN quantity_change < 0 THEN -quantity_change END), 0) AS totalOut,
         COUNT(*) AS transactions,
         MAX(CASE WHEN type = 'STOCK_IN' THEN created_at END) AS lastStockIn,
         MAX(CASE WHEN type = 'STOCK_OUT' THEN created_at END) AS lastStockOut
       FROM inventory_transactions WHERE product_id = ?`,
    )
    .get(id);
  const duplicates = p.barcode
    ? db.prepare('SELECT id, sku, name FROM products WHERE barcode = ? AND id <> ?').all(p.barcode, id)
    : [];
  res.json({ data: serializeProduct(p), stats, barcodeDuplicates: duplicates, variants });
});

productsRouter.get('/:id/transactions', (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const { page, pageSize, offset } = pagination(req.query, 50);
  const total = db.prepare('SELECT COUNT(*) FROM inventory_transactions WHERE product_id = ?').pluck().get(id);
  const rows = db
    .prepare(
      `SELECT t.*, u.username, u.full_name AS user_full_name
       FROM inventory_transactions t LEFT JOIN users u ON u.id = t.user_id
       WHERE t.product_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    )
    .all(id, pageSize, offset);
  res.json({ data: rows, total, page, pageSize });
});

function assertCodesAvailable(
  db: ReturnType<typeof getDb>,
  body: { sku: string; barcode: string | null; confirmDuplicateBarcode?: boolean },
  excludeId = 0,
) {
  const skuOwner = db.prepare('SELECT id, sku, name FROM products WHERE sku = ? AND id <> ?').get(body.sku, excludeId) as
    | { id: number; sku: string; name: string }
    | undefined;
  if (skuOwner) throw conflict(`SKU ${body.sku} is already used by "${skuOwner.name}"`, 'DUPLICATE_SKU', skuOwner);
  if (body.barcode && !body.confirmDuplicateBarcode) {
    const others = db
      .prepare('SELECT id, sku, name FROM products WHERE barcode = ? AND id <> ?')
      .all(body.barcode, excludeId) as { id: number; sku: string; name: string }[];
    if (others.length)
      throw conflict(
        `Barcode ${body.barcode} is already used by ${others.map((o) => o.sku).join(', ')}. Confirm to save a duplicate barcode.`,
        'DUPLICATE_BARCODE',
        { products: others },
      );
  }
}

function assertRefs(db: ReturnType<typeof getDb>, body: { categoryId?: number | null; supplierId?: number | null }) {
  if (body.categoryId && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(body.categoryId))
    throw badRequest('Category not found');
  if (body.supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(body.supplierId))
    throw badRequest('Supplier not found');
}

productsRouter.post('/', requirePermission('products.manage'), (req, res) => {
  const db = getDb();
  const actor = actorOf(req);
  const body = createBody.parse(req.body);
  const warehouseId = getDefaultWarehouseId(db);

  const id = db.transaction(() => {
    assertCodesAvailable(db, body);
    assertRefs(db, body);
    const info = db
      .prepare(
        `INSERT INTO products (sku, barcode, name, description, category_id, supplier_id, unit, min_stock,
           purchase_price, selling_price, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
        actor.id,
      );
    const productId = Number(info.lastInsertRowid);
    const locationId = body.locationCode ? findOrCreateLocation(db, warehouseId, body.locationCode) : null;
    setProductLocation(db, productId, warehouseId, locationId);
    audit(db, actor, {
      action: 'PRODUCT.CREATE',
      entityType: 'product',
      entityId: productId,
      productId,
      description: `${actor.username} added new product ${body.sku} (${body.name}).`,
      newValue: body,
    });
    if (body.initialQuantity > 0) {
      applyStockChange(db, actor, {
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
  })();

  res.status(201).json({ data: serializeProduct(getProduct(db, id)!) });
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

productsRouter.put('/:id', requirePermission('products.manage'), (req, res) => {
  const db = getDb();
  const actor = actorOf(req);
  const id = idParam(req.params.id);
  const body = productBody.parse(req.body);
  const warehouseId = getDefaultWarehouseId(db);

  db.transaction(() => {
    const before = getProduct(db, id);
    if (!before) throw notFound('Product not found');
    // Only re-check the barcode if it actually changed.
    assertCodesAvailable(
      db,
      { ...body, confirmDuplicateBarcode: body.confirmDuplicateBarcode || body.barcode === before.barcode },
      id,
    );
    assertRefs(db, body);
    db.prepare(
      `UPDATE products SET sku = ?, barcode = ?, name = ?, description = ?, category_id = ?, supplier_id = ?,
         unit = ?, min_stock = ?, purchase_price = ?, selling_price = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
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
    const locationId = body.locationCode ? findOrCreateLocation(db, warehouseId, body.locationCode) : null;
    setProductLocation(db, id, warehouseId, locationId);

    const after = getProduct(db, id)!;
    const d = diff(before, after, FIELD_LABELS);
    if (d.changed) {
      audit(db, actor, {
        action: 'PRODUCT.UPDATE',
        entityType: 'product',
        entityId: id,
        productId: id,
        description: `${actor.username} changed ${d.phrases.join('; ')} on ${after.sku}.`,
        oldValue: d.oldValue,
        newValue: d.newValue,
      });
    }
  })();

  res.json({ data: serializeProduct(getProduct(db, id)!) });
});

productsRouter.delete('/:id', requirePermission('products.delete'), (req, res) => {
  const db = getDb();
  const actor = actorOf(req);
  const id = idParam(req.params.id);
  const p = getProduct(db, id);
  if (!p) throw notFound('Product not found');
  const used =
    db.prepare('SELECT 1 FROM stock_receipt_items WHERE product_id = ? LIMIT 1').get(id) ||
    db.prepare('SELECT 1 FROM stock_dispatch_items WHERE product_id = ? LIMIT 1').get(id) ||
    db.prepare(`SELECT 1 FROM inventory_transactions WHERE product_id = ? AND type <> 'INITIAL_STOCK' LIMIT 1`).get(id);
  const sizes = db.prepare('SELECT COUNT(*) FROM products WHERE parent_id = ?').pluck().get(id) as number;
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
  db.transaction(() => {
    audit(db, actor, {
      action: 'PRODUCT.DELETE',
      entityType: 'product',
      entityId: id,
      description: `${actor.username} deleted product ${p.sku} (${p.name}).`,
      oldValue: serializeProduct(p),
    });
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
  })();
  if (p.image_path) fs.rm(path.join(config.uploadsDir, p.image_path), { force: true }, () => {});
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
productsRouter.post('/:id/variants', requirePermission('products.manage'), (req, res) => {
  const db = getDb();
  const actor = actorOf(req);
  const parentId = idParam(req.params.id);
  const body = variantBody.parse(req.body);
  const warehouseId = getDefaultWarehouseId(db);
  const out = runIdempotent(db, actor, body.idempotencyKey, `variants:${parentId}`, () => {
    const parent = getProduct(db, parentId);
    if (!parent) throw notFound('Product not found');
    if (parent.parent_id) throw badRequest('Sizes can only be added to a base product, not to a size');
    const seen = new Set<string>();
    for (const v of body.variants) {
      const key = v.size.toLowerCase();
      if (seen.has(key)) throw badRequest(`Size ${v.size} is listed more than once`);
      seen.add(key);
    }
    const createdIds: number[] = db.transaction(() =>
      body.variants.map((v) => {
        assertCodesAvailable(db, { sku: v.sku, barcode: v.barcode });
        const info = db
          .prepare(
            `INSERT INTO products (sku, barcode, name, description, category_id, supplier_id, unit, min_stock,
               purchase_price, selling_price, status, created_by, parent_id, size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
          );
        const id = Number(info.lastInsertRowid);
        setProductLocation(db, id, warehouseId, parent.location_id);
        if (v.initialQuantity > 0)
          applyStockChange(db, actor, {
            productId: id,
            warehouseId,
            type: 'INITIAL_STOCK',
            quantity: v.initialQuantity,
            notes: `Opening stock for size ${v.size}`,
            sourceType: 'PRODUCT',
            sourceId: id,
          });
        return id;
      }),
    )();
    audit(db, actor, {
      action: 'PRODUCT.VARIANTS',
      entityType: 'product',
      entityId: parentId,
      productId: parentId,
      description: `${actor.username} added sizes ${body.variants.map((v) => v.size).join(', ')} to ${parent.sku}.`,
      newValue: { sizes: body.variants.map((v) => ({ size: v.size, sku: v.sku })) },
    });
    return {
      status: 201,
      body: { data: createdIds.map((id) => serializeProduct(getProduct(db, id)!)) },
    };
  });
  res.status(out.status).json(out.body);
});

// ---- Product image -------------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, `p_${crypto.randomBytes(10).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(badRequest('Only JPG, PNG, WEBP or GIF images are allowed'));
  },
});

productsRouter.post('/:id/image', requirePermission('products.manage'), upload.single('image'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const p = getProduct(db, id);
  if (!req.file) throw badRequest('No image uploaded');
  if (!p) {
    fs.rmSync(req.file.path, { force: true });
    throw notFound('Product not found');
  }
  db.prepare('UPDATE products SET image_path = ?, updated_at = ? WHERE id = ?').run(req.file.filename, nowIso(), id);
  if (p.image_path) fs.rm(path.join(config.uploadsDir, p.image_path), { force: true }, () => {});
  audit(db, actorOf(req), {
    action: 'PRODUCT.IMAGE',
    entityType: 'product',
    entityId: id,
    productId: id,
    description: `${req.user!.username} updated the photo of ${p.sku}.`,
  });
  res.json({ data: serializeProduct(getProduct(db, id)!) });
});

productsRouter.delete('/:id/image', requirePermission('products.manage'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const p = getProduct(db, id);
  if (!p) throw notFound('Product not found');
  if (p.image_path) {
    db.prepare('UPDATE products SET image_path = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
    fs.rm(path.join(config.uploadsDir, p.image_path), { force: true }, () => {});
    audit(db, actorOf(req), {
      action: 'PRODUCT.IMAGE',
      entityType: 'product',
      entityId: id,
      productId: id,
      description: `${req.user!.username} removed the photo of ${p.sku}.`,
    });
  }
  res.json({ data: serializeProduct(getProduct(db, id)!) });
});
