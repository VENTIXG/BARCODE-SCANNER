import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src or server/dist -> server/
const serverRoot = path.resolve(here, '..');

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(serverRoot, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

/**
 * JWT secret: taken from the environment, otherwise generated once and
 * persisted in the data directory so sessions survive restarts.
 */
function resolveJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, '.jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 4000),
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  dbFile: process.env.DB_FILE ?? path.join(dataDir, 'inventory.db'),
  jwtSecret: resolveJwtSecret(),
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  /** Set COOKIE_SECURE=true when the app is served over HTTPS. */
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  /** Number of reverse proxies in front of the app (for correct client IPs). */
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  clientDist: path.resolve(serverRoot, '..', 'client', 'dist'),
};
