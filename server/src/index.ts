import { config } from './config.js';
import { startServer } from './server.js';

const { url } = await startServer({ host: process.env.HOST || undefined });
console.log(`Warehouse IMS listening on ${url} (${config.env})`);
console.log(`Database: ${config.dbFile}`);
