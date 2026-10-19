/** Categories, suppliers, warehouses and warehouse locations. */
import { Router } from 'express';
import { z } from 'zod';
import { getDb, getDefaultWarehouseId, nowIso } from '../db/index.js';
import { actorOf, requirePermission } from '../middleware/auth.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { checkWritableDir, runBackup } from '../lib/backup.js';
import { seedDemoData } from '../db/demoData.js';
import { idParam, num, optText } from '../lib/http.js';
import { normalizeLocationCode, parseLocationCode } from '../lib/locations.js';

// ---- Categories ------------------------------------------------------------

export const categoriesRouter = Router();
const categoryBody = z.object({ name: z.string().trim().min(1).max(100), description: optText(500) });

categoriesRouter.get('/', async (_req, res) => {
  const db = getDb();
  const wh = await getDefaultWarehouseId(db);
  res.json({
    data: await db.all(
      `SELECT c.*, COUNT(p.id) AS product_count,
              COALESCE(SUM(i.quantity), 0) AS total_quantity,
              COALESCE(SUM(i.quantity * p.purchase_price), 0) AS stock_value
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id
       LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
       GROUP BY c.id ORDER BY c.name`,
      wh,
    ),
  });
});

categoriesRouter.post('/', requirePermission('catalog.manage'), async (req, res) => {
  const db = getDb();
  const body = categoryBody.parse(req.body);
  const id = await db.tx(async (t) => {
    if (await t.get('SELECT 1 FROM categories WHERE name = ?', body.name)) throw conflict('Category already exists');
    const newId = (await t.value<number>('INSERT INTO categories (name, description) VALUES (?, ?) RETURNING id', body.name, body.description)) as number;
    await audit(t, actorOf(req), { action: 'CATEGORY.CREATE', entityType: 'category', entityId: newId, description: `${req.user!.username} created category "${body.name}".` });
    return newId;
  });
  res.status(201).json({ data: await db.get('SELECT * FROM categories WHERE id = ?', id) });
});

categoriesRouter.put('/:id', requirePermission('catalog.manage'), async (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const body = categoryBody.parse(req.body);
  await db.tx(async (t) => {
    const before = await t.get<Record<string, unknown>>('SELECT * FROM categories WHERE id = ?', id);
    if (!before) throw notFound('Category not found');
    if (await t.get('SELECT 1 FROM categories WHERE name = ? AND id <> ?', body.name, id)) throw conflict('Category already exists');
    await t.run('UPDATE categories SET name = ?, description = ?, updated_at = ? WHERE id = ?', body.name, body.description, nowIso(), id);
    const d = diff(before, { name: body.name, description: body.description }, { name: 'name', description: 'description' });
    if (d.changed)
      await audit(t, actorOf(req), { action: 'CATEGORY.UPDATE', entityType: 'category', entityId: id, description: `${req.user!.username} changed category ${d.phrases.join('; ')}.`, oldValue: d.oldValue, newValue: d.newValue });
  });
  res.json({ data: await db.get('SELECT * FROM categories WHERE id = ?', id) });
});

categoriesRouter.delete('/:id', requirePermission('catalog.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  await getDb().tx(async (t) => {
    const c = await t.get<{ name: string }>('SELECT * FROM categories WHERE id = ?', id);
    if (!c) throw notFound('Category not found');
    const count = await t.value<number>('SELECT COUNT(*) FROM products WHERE category_id = ?', id);
    await t.run('DELETE FROM categories WHERE id = ?', id);
    await audit(t, actorOf(req), { action: 'CATEGORY.DELETE', entityType: 'category', entityId: id, description: `${req.user!.username} deleted category "${c.name}" (${count} products left uncategorised).` });
  });
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

suppliersRouter.get('/', async (_req, res) => {
  const db = getDb();
  const wh = await getDefaultWarehouseId(db);
  res.json({
    data: await db.all(
      `SELECT s.*, COUNT(p.id) AS product_count,
              COALESCE(SUM(i.quantity * p.purchase_price), 0) AS stock_value,
              (SELECT MAX(receipt_date) FROM stock_receipts r WHERE r.supplier_id = s.id AND r.status = 'CONFIRMED') AS last_receipt_date
       FROM suppliers s
       LEFT JOIN products p ON p.supplier_id = s.id
       LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
       GROUP BY s.id ORDER BY s.name`,
      wh,
    ),
  });
});

function supplierParams(b: z.infer<typeof supplierBody>) {
  return [b.name, b.contactName, b.email, b.phone, b.address, b.vatNumber, b.notes, b.isActive ? 1 : 0];
}

suppliersRouter.post('/', requirePermission('catalog.manage'), async (req, res) => {
  const db = getDb();
  const body = supplierBody.parse(req.body);
  const id = await db.tx(async (t) => {
    if (await t.get('SELECT 1 FROM suppliers WHERE name = ?', body.name)) throw conflict('Supplier already exists');
    const newId = (await t.value<number>(
      'INSERT INTO suppliers (name, contact_name, email, phone, address, vat_number, notes, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      ...supplierParams(body),
    )) as number;
    await audit(t, actorOf(req), { action: 'SUPPLIER.CREATE', entityType: 'supplier', entityId: newId, description: `${req.user!.username} created supplier "${body.name}".` });
    return newId;
  });
  res.status(201).json({ data: await db.get('SELECT * FROM suppliers WHERE id = ?', id) });
});

suppliersRouter.put('/:id', requirePermission('catalog.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const body = supplierBody.parse(req.body);
  const after = await getDb().tx(async (t) => {
    const before = await t.get<Record<string, unknown>>('SELECT * FROM suppliers WHERE id = ?', id);
    if (!before) throw notFound('Supplier not found');
    if (await t.get('SELECT 1 FROM suppliers WHERE name = ? AND id <> ?', body.name, id)) throw conflict('Supplier already exists');
    await t.run(
      `UPDATE suppliers SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, vat_number = ?, notes = ?, is_active = ?, updated_at = ? WHERE id = ?`,
      ...supplierParams(body),
      nowIso(),
      id,
    );
    const row = (await t.get<Record<string, unknown>>('SELECT * FROM suppliers WHERE id = ?', id))!;
    const d = diff(before, row, { name: 'name', contact_name: 'contact', email: 'email', phone: 'phone', address: 'address', vat_number: 'VAT number', is_active: 'active' });
    if (d.changed)
      await audit(t, actorOf(req), { action: 'SUPPLIER.UPDATE', entityType: 'supplier', entityId: id, description: `${req.user!.username} changed supplier "${body.name}": ${d.phrases.join('; ')}.`, oldValue: d.oldValue, newValue: d.newValue });
    return row;
  });
  res.json({ data: after });
});

suppliersRouter.delete('/:id', requirePermission('catalog.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  await getDb().tx(async (t) => {
    const s = await t.get<{ name: string }>('SELECT * FROM suppliers WHERE id = ?', id);
    if (!s) throw notFound('Supplier not found');
    await t.run('DELETE FROM suppliers WHERE id = ?', id);
    await audit(t, actorOf(req), { action: 'SUPPLIER.DELETE', entityType: 'supplier', entityId: id, description: `${req.user!.username} deleted supplier "${s.name}".` });
  });
  res.status(204).end();
});

// ---- Warehouses & locations -------------------------------------------------

export const warehousesRouter = Router();

warehousesRouter.get('/', async (_req, res) => {
  res.json({ data: await getDb().all('SELECT * FROM warehouses ORDER BY is_default DESC, name') });
});

warehousesRouter.put('/:id', requirePermission('settings.manage'), async (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const body = z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(100), address: optText(500) }).parse(req.body);
  await db.tx(async (t) => {
    const before = await t.get<Record<string, unknown>>('SELECT * FROM warehouses WHERE id = ?', id);
    if (!before) throw notFound('Warehouse not found');
    await t.run('UPDATE warehouses SET code = ?, name = ?, address = ?, updated_at = ? WHERE id = ?', body.code, body.name, body.address, nowIso(), id);
    const d = diff(before, body as unknown as Record<string, unknown>, { code: 'code', name: 'name', address: 'address' });
    if (d.changed)
      await audit(t, actorOf(req), { action: 'WAREHOUSE.UPDATE', entityType: 'warehouse', entityId: id, description: `${req.user!.username} changed warehouse ${d.phrases.join('; ')}.` });
  });
  res.json({ data: await db.get('SELECT * FROM warehouses WHERE id = ?', id) });
});

export const locationsRouter = Router();

locationsRouter.get('/', async (req, res) => {
  const db = getDb();
  const wh = num(req.query.warehouseId) ?? (await getDefaultWarehouseId(db));
  res.json({
    data: await db.all(
      `SELECT l.*, COUNT(i.id) AS product_count, COALESCE(SUM(i.quantity), 0) AS total_quantity
       FROM warehouse_locations l LEFT JOIN inventory i ON i.location_id = l.id
       WHERE l.warehouse_id = ? GROUP BY l.id ORDER BY l.code`,
      wh,
    ),
  });
});

const locationBody = z.object({ code: z.string().trim().min(1).max(40), description: optText(200), isActive: z.boolean().default(true) });

locationsRouter.post('/', requirePermission('catalog.manage'), async (req, res) => {
  const db = getDb();
  const body = locationBody.parse(req.body);
  const code = normalizeLocationCode(body.code);
  const id = await db.tx(async (t) => {
    const wh = await getDefaultWarehouseId(t);
    if (await t.get('SELECT 1 FROM warehouse_locations WHERE warehouse_id = ? AND code = ?', wh, code)) throw conflict(`Location ${code} already exists`);
    const { zone, rack, shelf } = parseLocationCode(code);
    const newId = (await t.value<number>(
      'INSERT INTO warehouse_locations (warehouse_id, code, zone, rack, shelf, description, is_active) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      wh,
      code,
      zone,
      rack,
      shelf,
      body.description,
      body.isActive ? 1 : 0,
    )) as number;
    await audit(t, actorOf(req), { action: 'LOCATION.CREATE', entityType: 'location', entityId: newId, description: `${req.user!.username} created location ${code}.` });
    return newId;
  });
  res.status(201).json({ data: await db.get('SELECT * FROM warehouse_locations WHERE id = ?', id) });
});

locationsRouter.put('/:id', requirePermission('catalog.manage'), async (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const body = locationBody.parse(req.body);
  await db.tx(async (t) => {
    const before = await t.get<{ warehouse_id: number; code: string }>('SELECT * FROM warehouse_locations WHERE id = ?', id);
    if (!before) throw notFound('Location not found');
    const code = normalizeLocationCode(body.code);
    if (await t.get('SELECT 1 FROM warehouse_locations WHERE warehouse_id = ? AND code = ? AND id <> ?', before.warehouse_id, code, id))
      throw conflict(`Location ${code} already exists`);
    const { zone, rack, shelf } = parseLocationCode(code);
    await t.run(
      'UPDATE warehouse_locations SET code = ?, zone = ?, rack = ?, shelf = ?, description = ?, is_active = ?, updated_at = ? WHERE id = ?',
      code,
      zone,
      rack,
      shelf,
      body.description,
      body.isActive ? 1 : 0,
      nowIso(),
      id,
    );
    if (before.code !== code)
      await audit(t, actorOf(req), { action: 'LOCATION.UPDATE', entityType: 'location', entityId: id, description: `${req.user!.username} renamed location ${before.code} to ${code}.` });
  });
  res.json({ data: await db.get('SELECT * FROM warehouse_locations WHERE id = ?', id) });
});

locationsRouter.delete('/:id', requirePermission('catalog.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  await getDb().tx(async (t) => {
    const l = await t.get<{ code: string }>('SELECT code FROM warehouse_locations WHERE id = ?', id);
    if (!l) throw notFound('Location not found');
    const used = await t.value<number>('SELECT COUNT(*) FROM inventory WHERE location_id = ?', id);
    if (used) throw conflict(`Location ${l.code} is assigned to ${used} products. Move them first.`);
    await t.run('DELETE FROM warehouse_locations WHERE id = ?', id);
    await audit(t, actorOf(req), { action: 'LOCATION.DELETE', entityType: 'location', entityId: id, description: `${req.user!.username} deleted location ${l.code}.` });
  });
  res.status(204).end();
});

// ---- Settings ---------------------------------------------------------------

export const settingsRouter = Router();

/** Fill an empty database with demo data (products, suppliers, 12 months of movements). */
settingsRouter.post('/demo-data', requirePermission('settings.manage'), async (req, res) => {
  const db = getDb();
  const products = await db.value<number>('SELECT COUNT(*) FROM products');
  if (products) throw conflict('Demo data can only be loaded into an empty database');
  // Restoring this backup later removes the demo data again.
  await runBackup('before-demo', db);
  const stats = await db.tx(async (t) => {
    const s = await seedDemoData(t, { keepExistingUsers: true });
    await audit(t, actorOf(req), {
      action: 'SETTINGS.DEMO_DATA',
      entityType: 'setting',
      description: `${req.user!.username} loaded demo data: ${s.products} products, ${s.transactions} transactions.`,
    });
    return s;
  });
  res.status(201).json({ data: stats });
});

async function allSettings() {
  const rows = await getDb().all<{ key: string; value: string }>('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

settingsRouter.get('/', async (_req, res) => {
  res.json({ data: await allSettings() });
});

settingsRouter.put('/', requirePermission('settings.manage'), async (req, res) => {
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
  await getDb().tx(async (t) => {
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      const old = await t.value<string>('SELECT value FROM settings WHERE key = ?', key);
      if (old === value) continue;
      await t.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        value,
        nowIso(),
      );
      await audit(t, actorOf(req), { action: 'SETTINGS.UPDATE', entityType: 'setting', description: `${req.user!.username} changed setting ${key} from "${old ?? ''}" to "${value}".`, oldValue: { [key]: old }, newValue: { [key]: value } });
    }
  });
  res.json({ data: await allSettings() });
});
