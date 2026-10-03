/**
 * Command-line demo seed.
 *
 *   npm run seed            -> seed only if the database has no products
 *   npm run seed -- --reset -> delete the database and start over
 */
import fs from 'node:fs';
import { config } from '../config.js';
import { openDatabase, type DB } from './index.js';
import { seedDemoData } from './demoData.js';

const reset = process.argv.includes('--reset');
if (reset) {
  for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) fs.rmSync(f, { force: true });
  console.log('Database deleted.');
}

const db: DB = openDatabase(config.dbFile, { quiet: true });
const existing = db.prepare('SELECT COUNT(*) FROM products').pluck().get() as number;
if (existing > 0 && !reset) {
  console.log(`Database already has ${existing} products — skipping demo seed. Use "npm run seed -- --reset" to start over.`);
  process.exit(0);
}

const stats = seedDemoData(db);
console.log(`Demo data created: ${stats.products} products, ${stats.transactions} transactions, ${stats.receipts} receipts, ${stats.dispatches} dispatches.`);
console.log('Users: admin/admin123 · manager/manager123 · warehouse1/warehouse123 · warehouse2/warehouse123');
db.close();
