/**
 * Prepares desktop/app: the built server + web app + Electron entry files and
 * the server's production dependencies. electron-builder packages this folder.
 *
 *   node scripts/stage.mjs            (expects `npm run build` at the repo root first)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const app = path.join(desktop, 'app');

const need = (p, hint) => {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${path.relative(root, p)} — ${hint}`);
    process.exit(1);
  }
};
need(path.join(root, 'server', 'dist', 'server.js'), 'run `npm run build` in the project root first');
need(path.join(root, 'client', 'dist', 'index.html'), 'run `npm run build` in the project root first');

fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });

const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(app, to), { recursive: true, filter: (src) => !src.endsWith('.map') });
copy('server/dist', 'server/dist');
copy('client/dist', 'client/dist');
fs.writeFileSync(path.join(app, 'server', 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
for (const f of ['main.cjs', 'preload.cjs', 'setup.html', 'setup.js', 'offline.html', 'offline.js']) fs.copyFileSync(path.join(desktop, f), path.join(app, f));
fs.copyFileSync(path.join(desktop, 'build', 'icon.png'), path.join(app, 'icon.png'));

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'warehouse-ims',
      productName: 'Warehouse IMS',
      version: rootPkg.version,
      description: 'Inventory management with barcode scanning',
      author: 'Warehouse IMS',
      license: 'UNLICENSED',
      main: 'main.cjs',
      // The server's dependencies plus the updater of the desktop app.
      dependencies: { ...serverPkg.dependencies, ...desktopPkg.dependencies },
      overrides: rootPkg.overrides,
    },
    null,
    2,
  ),
);

console.log('Installing production dependencies…');
execSync('npm install --omit=dev --no-audit --no-fund --ignore-scripts', { cwd: app, stdio: 'inherit' });

// better-sqlite3 ships prebuilt N-API binaries for every platform (they work in
// Electron as-is). Keep only Windows x64 (and the build machine's own, for testing).
const prebuilds = path.join(app, 'node_modules', 'better-sqlite3', 'prebuilds');
const keep = new Set(['win32-x64.node', `${process.platform}-${process.arch}.node`]);
for (const f of fs.readdirSync(prebuilds)) if (!keep.has(f)) fs.rmSync(path.join(prebuilds, f));
for (const dir of ['deps', 'src']) fs.rmSync(path.join(app, 'node_modules', 'better-sqlite3', dir), { recursive: true, force: true });

console.log(`Staged ${path.relative(root, app)}`);
