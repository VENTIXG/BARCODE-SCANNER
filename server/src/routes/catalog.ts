/** Categories, suppliers, warehouses and warehouse locations. */
import { Router } from 'express';
import { z } from 'zod';
import { getDb, getDefaultWarehouseId, nowIso } from '../db/index.js';
import { actorOf, requirePermission } from '../middleware/auth.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { checkWritableDir } from '../lib/backup.js';
import { seedDemoData } from '../db/demoData.js';
import { idParam, num, optText } from '../lib/http.js';
import { normalizeLocationCode, parseLocationCode } from '../lib/locations.js';

// ---- Categories ------------------------------------------------------------

export const categoriesRouter = Router();
const categoryBody = z.object({ name: z.string().trim().min(1).max(100), description: optText(500) });

categoriesRouter.get('/', (_req, res) => {
  const wh = getDefaultWarehouseId();
  res.json({
    data: getDb()
      .prepare(
        `SELECT c.*, COUNT(p.id) AS product_count,
                COALESCE(SUM(i.quantity), 0) AS total_quantity,
                COALESCE(SUM(i.quantity * p.purchase_price), 0) AS stock_value
         FROM categories c
         LEFT JOIN products p ON p.category_id = c.id
         LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
         GROUP BY c.id ORDER BY c.name COLLATE NOCASE`,
      )
      .all(wh),
  });
});

categoriesRouter.post('/', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const body = categoryBody.parse(req.body);
  if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(body.name)) throw conflict('Category already exists');
  const id = Number(db.prepare('INSERT INTO categories (name, description) VALUES (?, ?)').run(body.name, body.description).lastInsertRowid);
  audit(db, actorOf(req), { action: 'CATEGORY.CREATE', entityType: 'category', entityId: id, description: `${req.user!.username} created category "${body.name}".` });
  res.status(201).json({ data: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
});

categoriesRouter.put('/:id', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const body = categoryBody.parse(req.body);
  const before = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!before) throw notFound('Category not found');
  if (db.prepare('SELECT 1 FROM categories WHERE name = ? AND id <> ?').get(body.name, id)) throw conflict('Category already exists');
  db.prepare('UPDATE categories SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(body.name, body.description, nowIso(), id);
  const d = diff(before, { name: body.name, description: body.description }, { name: 'name', description: 'description' });
  if (d.changed)
    audit(db, actorOf(req), { action: 'CATEGORY.UPDATE', entityType: 'category', entityId: id, description: `${req.user!.username} changed category ${d.phrases.join('; ')}.`, oldValue: d.oldValue, newValue: d.newValue });
  res.json({ data: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
});

categoriesRouter.delete('/:id', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as { name: string } | undefined;
  if (!c) throw notFound('Category not found');
  const count = db.prepare('SELECT COUNT(*) FROM products WHERE category_id = ?').pluck().get(id) as number;
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  audit(db, actorOf(req), { action: 'CATEGORY.DELETE', entityType: 'category', entityId: id, description: `${req.user!.username} deleted category "${c.name}" (${count} products left uncategorised).` });
  res.status(204).end();
});

// ---- Suppliers -------------------------------------------------------------

export const suppliersRouter = Router();
const supplierBody = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: optText(200),
  email: optText(200),
  phone: optText(50),
  address: optText(500),
  vatNumber: optText(50),
  notes: optText(2000),
  isActive: z.boolean().default(true),
});

suppliersRouter.get('/', (_req, res) => {
  const wh = getDefaultWarehouseId();
  res.json({
    data: getDb()
      .prepare(
        `SELECT s.*, COUNT(p.id) AS product_count,
                COALESCE(SUM(i.quantity * p.purchase_price), 0) AS stock_value,
                (SELECT MAX(receipt_date) FROM stock_receipts r WHERE r.supplier_id = s.id AND r.status = 'CONFIRMED') AS last_receipt_date
         FROM suppliers s
         LEFT JOIN products p ON p.supplier_id = s.id
         LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
         GROUP BY s.id ORDER BY s.name COLLATE NOCASE`,
      )
      .all(wh),
  });
});

function supplierParams(b: z.infer<typeof supplierBody>) {
  return [b.name, b.contactName, b.email, b.phone, b.address, b.vatNumber, b.notes, b.isActive ? 1 : 0];
}

suppliersRouter.post('/', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const body = supplierBody.parse(req.body);
  if (db.prepare('SELECT 1 FROM suppliers WHERE name = ?').get(body.name)) throw conflict('Supplier already exists');
  const id = Number(
    db
      .prepare('INSERT INTO suppliers (name, contact_name, email, phone, address, vat_number, notes, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(...supplierParams(body)).lastInsertRowid,
  );
  audit(db, actorOf(req), { action: 'SUPPLIER.CREATE', entityType: 'supplier', entityId: id, description: `${req.user!.username} created supplier "${body.name}".` });
  res.status(201).json({ data: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) });
});

suppliersRouter.put('/:id', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const body = supplierBody.parse(req.body);
  const before = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!before) throw notFound('Supplier not found');
  if (db.prepare('SELECT 1 FROM suppliers WHERE name = ? AND id <> ?').get(body.name, id)) throw conflict('Supplier already exists');
  db.prepare(
    `UPDATE suppliers SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, vat_number = ?, notes = ?, is_active = ?, updated_at = ? WHERE id = ?`,
  ).run(...supplierParams(body), nowIso(), id);
  const after = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Record<string, unknown>;
  const d = diff(before, after, { name: 'name', contact_name: 'contact', email: 'email', phone: 'phone', address: 'address', vat_number: 'VAT number', is_active: 'active' });
  if (d.changed)
    audit(db, actorOf(req), { action: 'SUPPLIER.UPDATE', entityType: 'supplier', entityId: id, description: `${req.user!.username} changed supplier "${body.name}": ${d.phrases.join('; ')}.`, oldValue: d.oldValue, newValue: d.newValue });
  res.json({ data: after });
});

suppliersRouter.delete('/:id', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as { name: string } | undefined;
  if (!s) throw notFound('Supplier not found');
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
  audit(db, actorOf(req), { action: 'SUPPLIER.DELETE', entityType: 'supplier', entityId: id, description: `${req.user!.username} deleted supplier "${s.name}".` });
  res.status(204).end();
});

// ---- Warehouses & locations -------------------------------------------------

export const warehousesRouter = Router();

warehousesRouter.get('/', (_req, res) => {
  res.json({ data: getDb().prepare('SELECT * FROM warehouses ORDER BY is_default DESC, name').all() });
});

warehousesRouter.put('/:id', requirePermission('settings.manage'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const body = z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(100), address: optText(500) }).parse(req.body);
  const before = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!before) throw notFound('Warehouse not found');
  db.prepare('UPDATE warehouses SET code = ?, name = ?, address = ?, updated_at = ? WHERE id = ?').run(body.code, body.name, body.address, nowIso(), id);
  const d = diff(before, body as unknown as Record<string, unknown>, { code: 'code', name: 'name', address: 'address' });
  if (d.changed)
    audit(db, actorOf(req), { action: 'WAREHOUSE.UPDATE', entityType: 'warehouse', entityId: id, description: `${req.user!.username} changed warehouse ${d.phrases.join('; ')}.` });
  res.json({ data: db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) });
});

export const locationsRouter = Router();

locationsRouter.get('/', (req, res) => {
  const wh = num(req.query.warehouseId) ?? getDefaultWarehouseId();
  res.json({
    data: getDb()
      .prepare(
        `SELECT l.*, COUNT(i.id) AS product_count, COALESCE(SUM(i.quantity), 0) AS total_quantity
         FROM warehouse_locations l LEFT JOIN inventory i ON i.location_id = l.id
         WHERE l.warehouse_id = ? GROUP BY l.id ORDER BY l.code`,
      )
      .all(wh),
  });
});

const locationBody = z.object({ code: z.string().trim().min(1).max(40), description: optText(200), isActive: z.boolean().default(true) });

locationsRouter.post('/', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const body = locationBody.parse(req.body);
  const wh = getDefaultWarehouseId(db);
  const code = normalizeLocationCode(body.code);
  if (db.prepare('SELECT 1 FROM warehouse_locations WHERE warehouse_id = ? AND code = ?').get(wh, code)) throw conflict(`Location ${code} already exists`);
  const { zone, rack, shelf } = parseLocationCode(code);
  const id = Number(
    db.prepare('INSERT INTO warehouse_locations (warehouse_id, code, zone, rack, shelf, description, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(wh, code, zone, rack, shelf, body.description, body.isActive ? 1 : 0).lastInsertRowid,
  );
  audit(db, actorOf(req), { action: 'LOCATION.CREATE', entityType: 'location', entityId: id, description: `${req.user!.username} created location ${code}.` });
  res.status(201).json({ data: db.prepare('SELECT * FROM warehouse_locations WHERE id = ?').get(id) });
});

locationsRouter.put('/:id', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const body = locationBody.parse(req.body);
  const before = db.prepare('SELECT * FROM warehouse_locations WHERE id = ?').get(id) as { warehouse_id: number; code: string } | undefined;
  if (!before) throw notFound('Location not found');
  const code = normalizeLocationCode(body.code);
  if (db.prepare('SELECT 1 FROM warehouse_locations WHERE warehouse_id = ? AND code = ? AND id <> ?').get(before.warehouse_id, code, id))
    throw conflict(`Location ${code} already exists`);
  const { zone, rack, shelf } = parseLocationCode(code);
  db.prepare('UPDATE warehouse_locations SET code = ?, zone = ?, rack = ?, shelf = ?, description = ?, is_active = ?, updated_at = ? WHERE id = ?')
    .run(code, zone, rack, shelf, body.description, body.isActive ? 1 : 0, nowIso(), id);
  if (before.code !== code)
    audit(db, actorOf(req), { action: 'LOCATION.UPDATE', entityType: 'location', entityId: id, description: `${req.user!.username} renamed location ${before.code} to ${code}.` });
  res.json({ data: db.prepare('SELECT * FROM warehouse_locations WHERE id = ?').get(id) });
});

locationsRouter.delete('/:id', requirePermission('catalog.manage'), (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const l = db.prepare('SELECT code FROM warehouse_locations WHERE id = ?').get(id) as { code: string } | undefined;
  if (!l) throw notFound('Location not found');
  const used = db.prepare('SELECT COUNT(*) FROM inventory WHERE location_id = ?').pluck().get(id) as number;
  if (used) throw conflict(`Location ${l.code} is assigned to ${used} products. Move them first.`);
  db.prepare('DELETE FROM warehouse_locations WHERE id = ?').run(id);
  audit(db, actorOf(req), { action: 'LOCATION.DELETE', entityType: 'location', entityId: id, description: `${req.user!.username} deleted location ${l.code}.` });
  res.status(204).end();
});

// ---- Settings ---------------------------------------------------------------

export const settingsRouter = Router();

/** Fill an empty database with demo data (products, suppliers, 12 months of movements). */
settingsRouter.post('/demo-data', requirePermission('settings.manage'), (req, res) => {
  const db = getDb();
  const products = db.prepare('SELECT COUNT(*) FROM products').pluck().get() as number;
  if (products > 0) throw conflict('Demo data can only be loaded into an empty database');
  const stats = db.transaction(() => seedDemoData(db, { keepExistingUsers: true }))();
  audit(db, actorOf(req), {
    action: 'SETTINGS.DEMO_DATA',
    entityType: 'setting',
    description: `${req.user!.username} loaded demo data: ${stats.products} products, ${stats.transactions} transactions.`,
  });
  res.status(201).json({ data: stats });
});

settingsRouter.get('/', (_req, res) => {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  res.json({ data: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

settingsRouter.put('/', requirePermission('settings.manage'), (req, res) => {
  const db = getDb();
  const body = z
    .object({
      company_name: z.string().trim().min(1).max(200).optional(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
      allow_negative_stock: z.enum(['true', 'false']).optional(),
      default_unit: z.string().trim().min(1).max(20).optional(),
      backup_enabled: z.enum(['true', 'false']).optional(),
      backup_keep: z.coerce.number().int().min(1).max(365).transform(String).optional(),
      /** Empty string = default folder inside the data directory. */
      backup_dir: z.string().trim().max(500).optional(),
    })
    .parse(req.body);
  if (body.backup_dir) {
    const problem = checkWritableDir(body.backup_dir);
    if (problem) throw badRequest(problem, 'BACKUP_DIR');
  }
  db.transaction(() => {
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      const old = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key);
      if (old === value) continue;
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, nowIso());
      audit(db, actorOf(req), { action: 'SETTINGS.UPDATE', entityType: 'setting', description: `${req.user!.username} changed setting ${key} from "${old ?? ''}" to "${value}".`, oldValue: { [key]: old }, newValue: { [key]: value } });
    }
  })();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  res.json({ data: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});
