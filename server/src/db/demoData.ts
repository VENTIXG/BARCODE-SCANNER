/**
 * Demo data: users, categories, suppliers, locations, ~80 products and twelve
 * months of realistic stock movements (receipts, dispatches, scans,
 * adjustments), all posted through the stock ledger so history is consistent.
 * Used by `npm run seed` and by the "Load demo data" button on an empty database.
 */
import bcrypt from 'bcryptjs';
import { getDefaultWarehouseId, type DB } from './index.js';
import type { Actor } from '../lib/audit.js';
import { findOrCreateLocation } from '../lib/locations.js';
import { applyStockChange, adjustToCount, getQuantity, setProductLocation, type TxType } from '../lib/stock.js';

export interface DemoStats {
  products: number;
  transactions: number;
  receipts: number;
  dispatches: number;
}

export function seedDemoData(db: DB, opts: { keepExistingUsers?: boolean } = {}): DemoStats {
  // Deterministic pseudo-random generator so every seed looks the same.
  let seed = 20260928;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (a: number, b: number) => Math.floor(rand() * (b - a + 1)) + a;
  const pick = <T>(arr: T[]) => arr[int(0, arr.length - 1)];

  function ean13(base12: string) {
    const sum = base12.split('').reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
    return base12 + ((10 - (sum % 10)) % 10);
  }

  // ---- Users -------------------------------------------------------------------
  const users = [
    { username: 'admin', full_name: 'Administrator', role: 'ADMIN', password: 'admin123' },
    { username: 'manager', full_name: 'Maria Papadopoulou', role: 'MANAGER', password: 'manager123' },
    { username: 'warehouse1', full_name: 'Nikos Georgiou', role: 'WAREHOUSE_USER', password: 'warehouse123' },
    { username: 'warehouse2', full_name: 'Eleni Dimitriou', role: 'WAREHOUSE_USER', password: 'warehouse123' },
  ];
  for (const u of users) {
    // From the app (opts.keepExistingUsers) existing accounts and passwords are left untouched.
    db.prepare(
      opts.keepExistingUsers
        ? `INSERT OR IGNORE INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)`
        : `INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role, full_name = excluded.full_name`,
    ).run(u.username, u.full_name, u.role, bcrypt.hashSync(u.password, 10));
  }
  const actorFor = (username: string): Actor => {
    const u = db.prepare('SELECT id, username, full_name, role FROM users WHERE username = ?').get(username) as {
      id: number; username: string; full_name: string; role: Actor['role'];
    };
    return { id: u.id, username: u.username, fullName: u.full_name, role: u.role, ip: '127.0.0.1' };
  };
  const admin = actorFor('admin');
  const manager = actorFor('manager');
  const staff = [actorFor('warehouse1'), actorFor('warehouse2')];

  db.prepare(`UPDATE settings SET value = 'Demo Trading S.A.' WHERE key = 'company_name'`).run();
  db.prepare(`UPDATE warehouses SET name = 'Κεντρική Αποθήκη', address = 'Βιομηχανική Περιοχή Σίνδου, Θεσσαλονίκη' WHERE is_default = 1`).run();
  const wh = getDefaultWarehouseId(db);

  // ---- Catalog -------------------------------------------------------------------
  const categories = ['Beverages', 'Food', 'Cleaning', 'Office Supplies', 'Electronics', 'Tools', 'Packaging', 'Personal Care'];
  const catId = new Map(categories.map((c) => [c, Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(c).lastInsertRowid)]));

  const suppliers = [
    { name: 'Αφοί Παπαδόπουλοι Α.Ε.', contact: 'Γιώργος Παπαδόπουλος', phone: '2310 555 100', email: 'orders@papadopoulos.gr', vat: 'EL094123456' },
    { name: 'Hellenic Beverages S.A.', contact: 'Anna Kosta', phone: '210 600 2000', email: 'sales@hellbev.gr', vat: 'EL998877665' },
    { name: 'CleanPro Hellas', contact: 'Dimitris Nikolaou', phone: '210 777 3300', email: 'info@cleanpro.gr', vat: 'EL801234567' },
    { name: 'OfficeLine Ltd', contact: 'Sofia Ioannou', phone: '2310 444 222', email: 'b2b@officeline.gr', vat: 'EL800111222' },
    { name: 'TechSource Europe', contact: 'Mark Weber', phone: '+49 30 1234 567', email: 'eu@techsource.com', vat: 'DE123456789' },
    { name: 'PackIt Solutions', contact: 'Kostas Lamprou', phone: '2410 333 111', email: 'hello@packit.gr', vat: 'EL099887766' },
  ];
  const supId = new Map(
    suppliers.map((s) => [
      s.name,
      Number(
        db.prepare('INSERT INTO suppliers (name, contact_name, phone, email, vat_number) VALUES (?, ?, ?, ?, ?)')
          .run(s.name, s.contact, s.phone, s.email, s.vat).lastInsertRowid,
      ),
    ]),
  );

  type Def = [name: string, category: string, supplier: string, unit: string, cost: number, margin: number, min: number, velocity: number];
  const S = suppliers.map((s) => s.name);
  const defs: Def[] = [
    ['Φυσικό Μεταλλικό Νερό 500ml', 'Beverages', S[1], 'pcs', 0.12, 2.5, 200, 40],
    ['Φυσικό Μεταλλικό Νερό 1.5L', 'Beverages', S[1], 'pcs', 0.22, 2.3, 150, 30],
    ['Χυμός Πορτοκάλι 1L', 'Beverages', S[1], 'pcs', 0.85, 1.9, 60, 12],
    ['Χυμός Μήλο 1L', 'Beverages', S[1], 'pcs', 0.8, 1.9, 50, 9],
    ['Cola 330ml Can', 'Beverages', S[1], 'pcs', 0.32, 2.4, 240, 45],
    ['Cola Zero 330ml Can', 'Beverages', S[1], 'pcs', 0.33, 2.4, 180, 30],
    ['Iced Tea Lemon 500ml', 'Beverages', S[1], 'pcs', 0.45, 2.2, 90, 16],
    ['Espresso Coffee Beans 1kg', 'Beverages', S[0], 'pcs', 11.5, 1.7, 20, 4],
    ['Ελληνικός Καφές 194g', 'Beverages', S[0], 'pcs', 2.1, 1.8, 40, 8],
    ['Πράσινο Τσάι 20 φακελάκια', 'Beverages', S[0], 'pcs', 1.3, 2.0, 30, 5],
    ['Ελαιόλαδο Extra Virgin 1L', 'Food', S[0], 'pcs', 6.9, 1.6, 40, 8],
    ['Ελαιόλαδο Extra Virgin 5L', 'Food', S[0], 'pcs', 31.0, 1.45, 12, 2],
    ['Μέλι Ανθέων 450g', 'Food', S[0], 'pcs', 4.2, 1.8, 25, 4],
    ['Φέτα ΠΟΠ 400g', 'Food', S[0], 'pcs', 3.6, 1.6, 40, 9],
    ['Ρύζι Καρολίνα 500g', 'Food', S[0], 'pcs', 1.1, 1.9, 60, 10],
    ['Μακαρόνια Νο10 500g', 'Food', S[0], 'pcs', 0.7, 2.0, 100, 18],
    ['Αλεύρι για όλες τις χρήσεις 1kg', 'Food', S[0], 'pcs', 0.65, 1.9, 60, 9],
    ['Ζάχαρη Λευκή 1kg', 'Food', S[0], 'pcs', 0.95, 1.6, 60, 10],
    ['Φακές Ψιλές 500g', 'Food', S[0], 'pcs', 1.4, 1.8, 40, 5],
    ['Ελιές Καλαμών 1kg', 'Food', S[0], 'kg', 5.5, 1.7, 15, 3],
    ['Τυρί Κεφαλοτύρι', 'Food', S[0], 'kg', 9.8, 1.5, 10, 2],
    ['Υγρό Πιάτων Λεμόνι 1.5L', 'Cleaning', S[2], 'pcs', 1.6, 2.0, 50, 8],
    ['Απορρυπαντικό Ρούχων 40 μεζούρες', 'Cleaning', S[2], 'pcs', 7.9, 1.6, 30, 5],
    ['Χλωρίνη 2L', 'Cleaning', S[2], 'pcs', 0.95, 2.1, 50, 8],
    ['Καθαριστικό Τζαμιών 750ml', 'Cleaning', S[2], 'pcs', 1.4, 2.0, 30, 4],
    ['Γάντια Νιτριλίου M (100τμχ)', 'Cleaning', S[2], 'box', 4.5, 1.8, 20, 4],
    ['Γάντια Νιτριλίου L (100τμχ)', 'Cleaning', S[2], 'box', 4.5, 1.8, 20, 4],
    ['Σακούλες Απορριμμάτων 80x110', 'Cleaning', S[2], 'pack', 2.2, 1.9, 40, 6],
    ['Χαρτί Κουζίνας 2 ρολά', 'Cleaning', S[2], 'pack', 1.8, 1.8, 60, 10],
    ['Microfiber Cloth 5-pack', 'Cleaning', S[2], 'pack', 2.9, 2.1, 25, 3],
    ['Χαρτί Φωτοτυπικό A4 80g (500φ)', 'Office Supplies', S[3], 'pack', 3.9, 1.5, 80, 14],
    ['Χαρτί Φωτοτυπικό A3 80g (500φ)', 'Office Supplies', S[3], 'pack', 8.2, 1.5, 15, 2],
    ['Στυλό Διαρκείας Μπλε (50τμχ)', 'Office Supplies', S[3], 'box', 6.5, 1.9, 15, 2],
    ['Μαρκαδόροι Υπογράμμισης 4 χρώματα', 'Office Supplies', S[3], 'pack', 2.3, 2.1, 20, 3],
    ['Κλασέρ 8/32 Μαύρο', 'Office Supplies', S[3], 'pcs', 1.9, 1.9, 40, 6],
    ['Συρραπτικό Μεταλλικό No.24', 'Office Supplies', S[3], 'pcs', 4.4, 1.8, 10, 1],
    ['Συρραπτικά 24/6 (1000τμχ)', 'Office Supplies', S[3], 'box', 0.6, 2.4, 40, 5],
    ['Post-it 76x76 κίτρινα', 'Office Supplies', S[3], 'pack', 1.2, 2.2, 30, 5],
    ['Ετικέτες Εκτυπωτή 100x150 (500τμχ)', 'Office Supplies', S[3], 'roll', 6.8, 1.7, 20, 4],
    ['Toner Laser Black TN-2420', 'Office Supplies', S[3], 'pcs', 38.0, 1.4, 5, 1],
    ['USB Barcode Scanner 1D/2D', 'Electronics', S[4], 'pcs', 42.0, 1.6, 5, 1],
    ['Bluetooth Barcode Scanner', 'Electronics', S[4], 'pcs', 69.0, 1.55, 4, 1],
    ['Thermal Label Printer 4"', 'Electronics', S[4], 'pcs', 165.0, 1.4, 2, 0.3],
    ['Wireless Mouse', 'Electronics', S[4], 'pcs', 7.5, 2.0, 15, 2],
    ['USB Keyboard GR/US', 'Electronics', S[4], 'pcs', 9.9, 1.9, 10, 1.5],
    ['USB-C Charger 65W', 'Electronics', S[4], 'pcs', 18.0, 1.8, 10, 1.5],
    ['HDMI Cable 2m', 'Electronics', S[4], 'pcs', 2.8, 2.5, 20, 2],
    ['Ethernet Cable Cat6 5m', 'Electronics', S[4], 'pcs', 2.4, 2.4, 20, 2],
    ['Power Strip 6 Sockets', 'Electronics', S[4], 'pcs', 6.5, 1.9, 12, 1.5],
    ['AA Alkaline Batteries (4-pack)', 'Electronics', S[4], 'pack', 1.9, 2.2, 50, 8],
    ['AAA Alkaline Batteries (4-pack)', 'Electronics', S[4], 'pack', 1.9, 2.2, 40, 6],
    ['LED Bulb E27 10W', 'Electronics', S[4], 'pcs', 1.6, 2.4, 40, 5],
    ['Κατσαβίδι Σετ 6τμχ', 'Tools', S[0], 'set', 6.8, 1.9, 8, 1],
    ['Μετροταινία 5m', 'Tools', S[0], 'pcs', 3.2, 2.0, 12, 1.5],
    ['Κόφτης Χαρτοκιβωτίων', 'Tools', S[5], 'pcs', 1.1, 2.6, 30, 4],
    ['Ανταλλακτικές Λάμες Κόφτη (10τμχ)', 'Tools', S[5], 'pack', 0.9, 2.5, 25, 3],
    ['Γάντια Εργασίας Νάιλον', 'Tools', S[0], 'pair', 1.2, 2.2, 40, 5],
    ['Γυαλιά Προστασίας', 'Tools', S[0], 'pcs', 2.5, 2.0, 12, 1],
    ['Σκάλα Αλουμινίου 5 σκαλοπάτια', 'Tools', S[0], 'pcs', 38.0, 1.5, 2, 0.2],
    ['Παλετοφόρο Χειροκίνητο 2.5t', 'Tools', S[0], 'pcs', 240.0, 1.35, 1, 0.05],
    ['Χαρτοκιβώτιο 30x20x20', 'Packaging', S[5], 'pcs', 0.35, 2.2, 300, 50],
    ['Χαρτοκιβώτιο 40x30x30', 'Packaging', S[5], 'pcs', 0.55, 2.1, 250, 40],
    ['Χαρτοκιβώτιο 60x40x40', 'Packaging', S[5], 'pcs', 0.95, 2.0, 120, 18],
    ['Ταινία Συσκευασίας Καφέ 48mm', 'Packaging', S[5], 'roll', 0.75, 2.2, 150, 25],
    ['Ταινία Συσκευασίας Διάφανη 48mm', 'Packaging', S[5], 'roll', 0.75, 2.2, 150, 25],
    ['Stretch Film 50cm 2.4kg', 'Packaging', S[5], 'roll', 6.2, 1.7, 30, 5],
    ['Φυσαλίδα Αέρος 1m x 100m', 'Packaging', S[5], 'roll', 18.0, 1.6, 6, 0.8],
    ['Φάκελοι Αποστολής A4 (100τμχ)', 'Packaging', S[5], 'pack', 5.4, 1.8, 20, 3],
    ['Παλέτα Ξύλινη EUR 120x80', 'Packaging', S[5], 'pcs', 9.5, 1.4, 20, 3],
    ['Αφρόλουτρο 750ml', 'Personal Care', S[2], 'pcs', 1.9, 2.0, 40, 6],
    ['Σαμπουάν 400ml', 'Personal Care', S[2], 'pcs', 2.3, 2.0, 40, 6],
    ['Οδοντόκρεμα 75ml', 'Personal Care', S[2], 'pcs', 1.3, 2.2, 50, 7],
    ['Υγρό Κρεμοσάπουνο 500ml', 'Personal Care', S[2], 'pcs', 1.1, 2.3, 60, 9],
    ['Αντισηπτικό Χεριών 1L', 'Personal Care', S[2], 'pcs', 3.4, 2.0, 30, 4],
    ['Χαρτί Υγείας 12 ρολά', 'Personal Care', S[2], 'pack', 3.9, 1.7, 60, 10],
    ['Χαρτομάντιλα Κουτί 100τμχ', 'Personal Care', S[2], 'pcs', 0.9, 2.3, 50, 7],
    ['Βαμβάκι 100g', 'Personal Care', S[2], 'pcs', 0.8, 2.4, 20, 2],
    ['Αποσμητικό Spray 150ml', 'Personal Care', S[2], 'pcs', 1.7, 2.3, 30, 4],
  ];

  const catPrefix: Record<string, string> = { Beverages: 'BEV', Food: 'FOD', Cleaning: 'CLN', 'Office Supplies': 'OFF', Electronics: 'ELC', Tools: 'TLS', Packaging: 'PKG', 'Personal Care': 'PRC' };
  const catZone: Record<string, string> = { Beverages: 'A', Food: 'A', Cleaning: 'B', 'Personal Care': 'B', 'Office Supplies': 'C', Electronics: 'C', Tools: 'D', Packaging: 'D' };

  interface P { id: number; sku: string; cost: number; price: number; min: number; velocity: number; supplier: string }
  const products: P[] = [];
  const counters: Record<string, number> = {};
  const DAYS = 365;
  const dayMs = 86_400_000;
  const startDate = Date.now() - DAYS * dayMs;

  db.transaction(() => {
    defs.forEach(([name, category, supplier, unit, cost, margin, min, velocity], idx) => {
      counters[category] = (counters[category] ?? 0) + 1;
      const sku = `${catPrefix[category]}-${String(counters[category]).padStart(3, '0')}`;
      const barcode = ean13(`520${String(1000 + idx).padStart(4, '0')}${String(int(10000, 99999))}`);
      const price = Math.round(cost * margin * 100) / 100;
      const id = Number(
        db.prepare(
          `INSERT INTO products (sku, barcode, name, category_id, supplier_id, unit, min_stock, purchase_price, selling_price, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        ).run(sku, barcode, name, catId.get(category), supId.get(supplier), unit, min, cost, price, admin.id,
          new Date(startDate - dayMs).toISOString(), new Date(startDate - dayMs).toISOString()).lastInsertRowid,
      );
      const zone = catZone[category];
      const loc = findOrCreateLocation(db, wh, `${zone}-${String(int(1, 6)).padStart(2, '0')}-${String(int(1, 5)).padStart(2, '0')}`);
      setProductLocation(db, id, wh, loc);
      products.push({ id, sku, cost, price, min, velocity, supplier });
    });
    // A couple of inactive / discontinued products
    db.prepare(`UPDATE products SET status = 'INACTIVE' WHERE sku IN ('OFF-010', 'ELC-003')`).run();
  })();

  // ---- Movements ----------------------------------------------------------------
  const seq = new Map<string, number>();
  const nextNumber = (prefix: 'RCV' | 'DSP', when: Date) => {
    const key = `${prefix}:${when.getFullYear()}`;
    const n = (seq.get(key) ?? 0) + 1;
    seq.set(key, n);
    return `${prefix}-${when.getFullYear()}-${String(n).padStart(5, '0')}`;
  };
  const customers = ['Super Market Κρήτη', 'Mini Market Ο Γιάννης', 'Cafe Lumiere', 'Hotel Aegean Blue', 'Office Center Α.Ε.', 'e-shop order', 'Ταβέρνα Το Λιμάνι', 'Φαρμακείο Νικολάου'];

  /** Post a ledger transaction and back-date it to `when`. */
  function post(actor: Actor, when: Date, input: Parameters<typeof applyStockChange>[2]) {
    const tx = applyStockChange(db, actor, input);
    const iso = when.toISOString();
    db.prepare('UPDATE inventory_transactions SET created_at = ? WHERE id = ?').run(iso, tx.id);
    db.prepare('UPDATE audit_logs SET created_at = ? WHERE entity_type = ? AND entity_id = ?').run(iso, 'inventory_transaction', tx.id);
    return tx;
  }

  // Monotonic clock so ledger order (id) and timestamps always agree.
  let clock = 0;
  const startDay = (day: number) => {
    const d = new Date(startDate + day * dayMs);
    d.setHours(8, 0, 0, 0);
    clock = d.getTime();
    return d;
  };
  const tick = () => {
    clock += int(3, 25) * 60_000 + int(0, 59) * 1000;
    return new Date(clock);
  };
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  db.transaction(() => {
    // Opening balance
    startDay(0);
    for (const p of products) {
      post(admin, tick(), { productId: p.id, warehouseId: wh, type: 'INITIAL_STOCK', quantity: Math.max(1, Math.round(p.min * (2 + rand() * 2))), notes: 'Opening balance', sourceType: 'IMPORT', unitCost: p.cost });
    }

    for (let day = 1; day < DAYS; day++) {
      const weekday = startDay(day).getDay();
      if (weekday === 0) continue; // closed on Sundays

      // Receipts: restock products below ~1.5x min, grouped per supplier, on Mon/Wed/Fri
      if ([1, 3, 5].includes(weekday)) {
        const needs = products.filter((p) => getQuantity(db, p.id, wh) < p.min * 1.5 && rand() < 0.85);
        const bySupplier = new Map<string, P[]>();
        for (const p of needs) bySupplier.set(p.supplier, [...(bySupplier.get(p.supplier) ?? []), p]);
        for (const [supplier, list] of bySupplier) {
          const when = tick();
          const number = nextNumber('RCV', when);
          const invoice = `ΤΔΑ ${int(1000, 9999)}`;
          const actor = pick([...staff, manager]);
          const lines = list.map((p) => ({ p, qty: Math.max(1, Math.round(p.min * (2 + rand() * 1.5))) }));
          const rid = Number(
            db.prepare(
              `INSERT INTO stock_receipts (receipt_number, warehouse_id, supplier_id, invoice_number, receipt_date, status, notes, total_quantity, total_value, created_by, confirmed_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'CONFIRMED', NULL, ?, ?, ?, ?, ?, ?)`,
            ).run(number, wh, supId.get(supplier), invoice, ymd(when), lines.reduce((s, l) => s + l.qty, 0), lines.reduce((s, l) => s + l.qty * l.p.cost, 0), actor.id, when.toISOString(), when.toISOString(), when.toISOString()).lastInsertRowid,
          );
          for (const l of lines) {
            db.prepare('INSERT INTO stock_receipt_items (receipt_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)').run(rid, l.p.id, l.qty, l.p.cost);
            post(actor, when, { productId: l.p.id, warehouseId: wh, type: 'STOCK_IN', quantity: l.qty, unitCost: l.p.cost, reference: `${number} / ${invoice}`, sourceType: 'RECEIPT', sourceId: rid });
          }
        }
      }

      // Dispatches: 1-4 customer orders per day; demand grows slightly over time
      const orders = int(1, weekday === 6 ? 2 : 4);
      for (let o = 0; o < orders; o++) {
        const when = tick();
        const lines = new Map<number, { p: P; qty: number }>();
        for (let k = 0; k < int(2, 7); k++) {
          const p = pick(products);
          const avail = getQuantity(db, p.id, wh) - (lines.get(p.id)?.qty ?? 0);
          const qty = Math.min(avail, Math.max(1, Math.round(p.velocity * (0.3 + rand()) * (0.8 + day / DAYS))));
          if (qty >= 1) lines.set(p.id, { p, qty: (lines.get(p.id)?.qty ?? 0) + qty });
        }
        if (!lines.size) continue;
        const number = nextNumber('DSP', when);
        const customer = pick(customers);
        const ref = `ΔΑ-${int(10000, 99999)}`;
        const actor = pick(staff);
        const list = [...lines.values()];
        const did = Number(
          db.prepare(
            `INSERT INTO stock_dispatches (dispatch_number, warehouse_id, customer_name, reference, dispatch_date, status, total_quantity, total_value, created_by, confirmed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?, ?)`,
          ).run(number, wh, customer, ref, ymd(when), list.reduce((s, l) => s + l.qty, 0), list.reduce((s, l) => s + l.qty * l.p.price, 0), actor.id, when.toISOString(), when.toISOString(), when.toISOString()).lastInsertRowid,
        );
        for (const l of list) {
          db.prepare('INSERT INTO stock_dispatch_items (dispatch_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)').run(did, l.p.id, l.qty, l.p.price);
          post(actor, when, { productId: l.p.id, warehouseId: wh, type: 'STOCK_OUT', quantity: l.qty, reference: `${number} / ${ref}`, sourceType: 'DISPATCH', sourceId: did });
        }
      }

      // Occasional barcode-scan movements, returns and adjustments
      if (rand() < 0.5) {
        const p = pick(products);
        const type: TxType = rand() < 0.5 ? 'STOCK_IN' : 'STOCK_OUT';
        const qty = int(1, 5);
        if (type === 'STOCK_IN' || getQuantity(db, p.id, wh) >= qty)
          post(pick(staff), tick(), { productId: p.id, warehouseId: wh, type, quantity: qty, notes: 'Barcode scan', sourceType: 'SCAN' });
      }
      if (rand() < 0.08) {
        const p = pick(products);
        post(pick(staff), tick(), { productId: p.id, warehouseId: wh, type: 'RETURN_IN', quantity: int(1, 3), reference: `RMA-${int(100, 999)}`, notes: 'Customer return — packaging damaged', sourceType: 'ADJUSTMENT' });
      }
      if (day % 30 === 0) {
        // Monthly cycle count on a few products
        for (let k = 0; k < 4; k++) {
          const p = pick(products);
          const q = getQuantity(db, p.id, wh);
          const counted = Math.max(0, q + pick([-3, -2, -1, -1, 1, 2]));
          const tx = adjustToCount(db, manager, { productId: p.id, warehouseId: wh, countedQuantity: counted, reason: pick(['Physical inventory count', 'Damaged goods', 'Cycle count correction']) });
          if (tx) {
            const iso = tick().toISOString();
            db.prepare('UPDATE inventory_transactions SET created_at = ? WHERE id = ?').run(iso, tx.id);
            db.prepare('UPDATE audit_logs SET created_at = ? WHERE entity_type = ? AND entity_id = ?').run(iso, 'inventory_transaction', tx.id);
          }
        }
      }
    }

    // Today: a few scans in the last hours, then force some low / out-of-stock items.
    clock = Date.now() - 4 * 3600_000;
    for (let k = 0; k < 6; k++) {
      const p = pick(products.filter((x) => x.velocity >= 2));
      post(pick(staff), tick(), { productId: p.id, warehouseId: wh, type: k % 3 === 0 ? 'STOCK_IN' : 'STOCK_OUT', quantity: int(1, 4), notes: 'Barcode scan', sourceType: 'SCAN' });
    }
    // Make sure the Low Stock page has something to show.
    for (const sku of ['BEV-008', 'ELC-002', 'PKG-006']) {
      const p = products.find((x) => x.sku === sku)!;
      const q = getQuantity(db, p.id, wh);
      if (q > 0) post(staff[0], tick(), { productId: p.id, warehouseId: wh, type: 'STOCK_OUT', quantity: q, reference: 'DEMO', notes: 'Large order', sourceType: 'SCAN' });
    }
    for (const sku of ['FOD-001', 'CLN-004', 'OFF-001', 'PRC-006']) {
      const p = products.find((x) => x.sku === sku)!;
      const q = getQuantity(db, p.id, wh);
      const target = Math.max(1, Math.floor(p.min * 0.6));
      if (q > target) post(staff[1], tick(), { productId: p.id, warehouseId: wh, type: 'STOCK_OUT', quantity: q - target, reference: 'DEMO', notes: 'Large order', sourceType: 'SCAN' });
    }

    for (const [key, value] of seq) {
      const [name, year] = key.split(':');
      db.prepare('INSERT OR REPLACE INTO sequences (name, year, value) VALUES (?, ?, ?)').run(name, Number(year), value);
    }
  })();

  const stats = db
    .prepare(
      'SELECT (SELECT COUNT(*) FROM products) products, (SELECT COUNT(*) FROM inventory_transactions) transactions, (SELECT COUNT(*) FROM stock_receipts) receipts, (SELECT COUNT(*) FROM stock_dispatches) dispatches',
    )
    .get() as DemoStats;
  return stats;
}
