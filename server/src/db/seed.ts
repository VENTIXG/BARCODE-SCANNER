/**
 * Command-line demo seed.
 *
 *   npm run seed            -> seed only if the database has no products
 *   npm run seed -- --reset -> delete all data and start over
 */
import fs from 'node:fs';
import { config } from '../config.js';
import { connect, openDatabase } from './index.js';
import { seedDemoData } from './demoData.js';

const reset = process.argv.includes('--reset');
if (reset) {
  if (config.databaseUrl) {
    // A PostgreSQL server: empty the application's tables (the database itself stays).
    const db = await connect();
    await db.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await db.close();
  } else {
    fs.rmSync(config.pgliteDir, { recursive: true, force: true });
  }
  console.log('Database deleted.');
}

// Demo data replaces everything: never copy the data of an older version into it.
const db = await openDatabase({ quiet: true, importLegacy: !reset });
const existing = (await db.value<number>('SELECT COUNT(*) FROM products')) ?? 0;
if (existing > 0 && !reset) {
  console.log(`Database already has ${existing} products — skipping demo seed. Use "npm run seed -- --reset" to start over.`);
  await db.close();
  process.exit(0);
}

const stats = await seedDemoData(db);
console.log(`Demo data created: ${stats.products} products, ${stats.transactions} transactions, ${stats.receipts} receipts, ${stats.dispatches} dispatches.`);
console.log('Users: admin/admin123 · manager/manager123 · warehouse1/warehouse123 · warehouse2/warehouse123');
await db.close();
