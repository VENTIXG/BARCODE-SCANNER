import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll } from 'vitest';

// Each test file gets its own throw-away data directory and database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-test-'));
process.env.DATA_DIR = dir;
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'admin123';

// Default: the built-in PostgreSQL (PGlite) in memory. With TEST_DATABASE_URL (a PostgreSQL
// server, e.g. postgres://postgres:postgres@localhost:5432/postgres) every test file gets a
// new database on that server, dropped at the end.
const server = process.env.TEST_DATABASE_URL?.trim();
if (server) {
  const name = `ims_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(server);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  afterAll(async () => {
    const { closeDb } = await import('../src/db/index.js');
    await closeDb();
    const c = new pg.Client({ connectionString: server });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.end();
  });
} else {
  process.env.DATABASE_URL = 'memory://';
}
