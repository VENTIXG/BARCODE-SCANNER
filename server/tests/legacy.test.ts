/**
 * Update from 1.2 (SQLite) to 1.3 (PostgreSQL): the data of the old version is copied at the
 * first start, without touching the old file, and old .db backups can still be restored.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { getDb, getSetting, initDb } from '../src/db/index.js';
import { makeLegacyDb } from './helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const app = createApp();
const admin = request.agent(app);
let untouched = false;

beforeAll(async () => {
  // A 1.0 database (schema 1: the import has to run the old upgrades too), closed without a
  // checkpoint, so the latest rows are only in its -wal file.
  const legacy = makeLegacyDb(config.legacyDbFile, 1);
  legacy.pragma('wal_autocheckpoint = 0');
  const hash = bcrypt.hashSync('old-admin-password', 4);
  legacy.exec(`
    INSERT INTO warehouses (id, code, name, is_default) VALUES (1, 'MAIN', 'Αποθήκη', 1);
    INSERT INTO categories (id, name) VALUES (1, 'Ποτά'), (2, 'ΠΟΤΆ');
    INSERT INTO settings (key, value) VALUES ('company_name', 'Παλιά Εταιρεία Α.Ε.');
  `);
  const user = legacy.prepare('INSERT INTO users (id, username, full_name, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  user.run(1, 'admin', 'Administrator', hash, 'ADMIN');
  user.run(2, 'μαρια', 'Μαρία', hash, 'WAREHOUSE_USER');
  user.run(3, 'ΜΑΡΙΑ', 'Μαρία Β', hash, 'WAREHOUSE_USER');
  legacy
    .prepare(
      `INSERT INTO products (id, sku, barcode, name, category_id, unit, min_stock, purchase_price, selling_price, image_path)
       VALUES (?, ?, ?, ?, ?, 'pcs', 5, 1.5, 3, ?)`,
    )
    .run(7, 'OLD-7', '5200000000007', 'Χυμός Πορτοκάλι', 2, 'old-photo.png');
  legacy.prepare(`INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (7, 1, 12)`).run();
  const tx = legacy.prepare(
    `INSERT INTO inventory_transactions (id, product_id, warehouse_id, type, quantity_before, quantity_change, quantity_after, source_type, user_id, created_at)
     VALUES (?, 7, 1, ?, ?, ?, ?, 'SCAN', 1, ?)`,
  );
  tx.run(1, 'INITIAL_STOCK', 0, 20, 20, '2026-01-02T09:00:00.000Z');
  tx.run(2, 'STOCK_OUT', 20, -8, 12, '2026-02-03T10:00:00.000Z');
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadsDir, 'old-photo.png'), PNG);
  expect(fs.existsSync(`${config.legacyDbFile}-wal`)).toBe(true);
  const files = [config.legacyDbFile, `${config.legacyDbFile}-wal`];
  const before = files.map(sha);

  await initDb();
  untouched = files.map(sha).join() === before.join();
  legacy.close();
  expect((await admin.post('/api/auth/login').send({ username: 'admin', password: 'old-admin-password' })).status).toBe(200);
});

afterAll(() => {
  fs.rmSync(`${config.legacyDbFile}-wal`, { force: true });
});

describe('first start after the update from 1.2', () => {
  it('copies users, products, stock, history and settings', async () => {
    const p = (await admin.get('/api/products/7')).body.data;
    expect(p).toMatchObject({ sku: 'OLD-7', name: 'Χυμός Πορτοκάλι', quantity: 12, categoryName: 'ΠΟΤΆ-2' });
    const history = (await admin.get('/api/products/7/transactions')).body;
    expect(history.total).toBe(2);
    expect(await getSetting('company_name')).toBe('Παλιά Εταιρεία Α.Ε.');
    expect(await getSetting('legacy_imported_from')).toContain('inventory.db');
    // No second administrator with the default password was created.
    expect(await getDb().value('SELECT COUNT(*) FROM users')).toBe(3);
  });

  it('renames names that differ only in Greek letter case (unique in PostgreSQL)', async () => {
    expect(await getDb().column('SELECT username::text FROM users ORDER BY id')).toEqual(['admin', 'μαρια', 'ΜΑΡΙΑ-2']);
    expect(await getDb().column('SELECT name::text FROM categories ORDER BY id')).toEqual(['Ποτά', 'ΠΟΤΆ-2']);
  });

  it('moves the product photo into the database', async () => {
    const res = await admin.get('/uploads/old-photo.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body, PNG)).toBe(0);
    expect((await request(app).get('/uploads/old-photo.png')).status).toBe(401);
  });

  it('finds the old products by Greek text without accents', async () => {
    const res = await admin.get('/api/products').query({ q: 'χυμος πορτοκαλι' });
    expect(res.body.data.map((p: { sku: string }) => p.sku)).toEqual(['OLD-7']);
  });

  it('continues numbering after the copied rows and posts new movements', async () => {
    const created = await admin.post('/api/products').send({ sku: 'NEW-1', name: 'Νέο προϊόν', initialQuantity: 1 });
    expect(created.status).toBe(201);
    expect(created.body.data.id).toBeGreaterThan(7);
    const scan = await admin.post('/api/stock/scan').send({ code: '5200000000007', mode: 'OUT', quantity: 2 });
    expect(scan.status).toBe(201);
    expect(scan.body.data.transaction).toMatchObject({ id: 4, quantity_before: 12, quantity_after: 10 });
  });

  it('leaves the old database file untouched (a rollback to 1.2 still finds it)', () => {
    expect(untouched).toBe(true);
  });
});

describe('backups of versions up to 1.2', () => {
  it('an uploaded .db backup is restored', async () => {
    const file = path.join(config.dataDir, 'old-backup.db');
    const db = makeLegacyDb(file);
    db.exec(`
      INSERT INTO warehouses (id, code, name, is_default) VALUES (1, 'MAIN', 'Main', 1);
      INSERT INTO products (id, sku, name) VALUES (1, 'FROM-OLD-BACKUP', 'Από παλιό backup');
    `);
    db.prepare(`INSERT INTO users (id, username, full_name, password_hash, role) VALUES (1, 'admin', 'Admin', ?, 'ADMIN')`).run(
      bcrypt.hashSync('backup-password', 4),
    );
    db.close();
    const res = await admin.post('/api/backups/restore-upload').attach('file', fs.readFileSync(file), 'inventory_old.db');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.safetyBackup).toMatch(/_before-restore\.json\.gz$/);
    const again = request.agent(app);
    expect((await again.post('/api/auth/login').send({ username: 'admin', password: 'backup-password' })).status).toBe(200);
    const list = (await again.get('/api/products')).body.data.map((p: { sku: string }) => p.sku);
    expect(list).toEqual(['FROM-OLD-BACKUP']);
  });
});
