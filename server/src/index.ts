import { config } from './config.js';
import { startServer } from './server.js';

const { url } = await startServer({ host: process.env.HOST || undefined });
console.log(`Warehouse IMS listening on ${url} (${config.env})`);
console.log(`Database: ${config.databaseUrl ? `PostgreSQL ${describeUrl(config.databaseUrl)}` : `built-in (${config.pgliteDir})`}`);

/** Host and database name only: the URL carries the password. */
function describeUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(invalid DATABASE_URL)';
  }
}
