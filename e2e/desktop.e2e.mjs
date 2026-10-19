/**
 * The desktop app (Electron), started for real: start screen, company server, offline page,
 * this-PC-only mode with its own database, and the backup taken when it closes.
 *
 * Needs a staged app (npm run stage --prefix desktop) and a display (on Linux: xvfb-run).
 *   xvfb-run -a node --test --test-timeout=300000 e2e/desktop.e2e.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { ROOT, log, testServer, until } from './lib.mjs';

const APP = path.join(ROOT, 'desktop', 'app');
const ELECTRON = path.join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const srv = testServer(Number(process.env.E2E_DESKTOP_PORT ?? 4713));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-desktop-'));
const userData = path.join(home, 'Warehouse IMS');
const configFile = path.join(userData, 'config.json');

/** Start the app with its own profile folder; the start screen or main window is returned. */
async function launch(extraEnv = {}) {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: ['--no-sandbox', APP],
    env: { ...process.env, XDG_CONFIG_HOME: home, APPDATA: home, IMS_NO_RELAUNCH: '1', ...extraEnv },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

async function quit(app) {
  const closed = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
  await Promise.race([closed, new Promise((r) => setTimeout(r, 15000))]);
}

before(async () => {
  assert.ok(fs.existsSync(path.join(APP, 'main.cjs')), 'stage the app first: npm run stage --prefix desktop');
  await srv.start();
});

after(() => {
  srv.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Windows app', () => {
  it('first start: the start screen checks a server address and saves it', async () => {
    const { app, win } = await launch();
    try {
      assert.match(await win.title(), /σύνδεση/);
      await win.fill('#url', 'http://127.0.0.1:1');
      await win.click('#test');
      await until(async () => /Δεν έγινε σύνδεση|δεν απαντά/.test(await win.textContent('#remote-msg')), 'error for a dead address', 15000);
      await win.fill('#url', srv.base);
      await win.click('#test');
      await until(async () => (await win.textContent('#remote-msg')).includes('server Warehouse IMS'), 'server recognised', 15000);
      const closed = new Promise((r) => app.process().once('exit', r));
      await win.click('#connect');
      await closed; // restarts (without relaunch in tests)
      assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { mode: 'remote', serverUrl: srv.base });
    } finally {
      if (app.process().exitCode === null) await quit(app);
    }
  });

  it('company server mode: opens the server, signs in, no access to local folders', async () => {
    const { app, win } = await launch();
    try {
      await until(async () => win.url().startsWith(srv.base), 'window shows the server', 15000);
      await win.waitForSelector('input[autocomplete=username]');
      const bridge = await win.evaluate(() => ({
        mode: window.imsDesktop?.mode,
        folders: typeof window.imsDesktop?.chooseFolder,
        updates: typeof window.imsDesktop?.updates?.check,
      }));
      assert.deepEqual(bridge, { mode: 'remote', folders: 'undefined', updates: 'function' });
      const update = await win.evaluate(() => window.imsDesktop.updates.status());
      assert.equal(update.state, 'disabled', 'a development copy does not update itself');
      await win.fill('input[autocomplete=username]', 'admin');
      await win.fill('input[type=password]', 'admin123');
      await win.click('button[type=submit]');
      await win.waitForURL(`${srv.base}/`);
      log('remote mode: signed in through the desktop app');
    } finally {
      await quit(app);
    }
  });

  it('server unreachable: a waiting page that comes back by itself', async () => {
    srv.stop();
    const { app, win } = await launch();
    try {
      await until(async () => win.url().includes('offline.html'), 'offline page', 20000);
      assert.match(await win.textContent('h1'), /Δεν υπάρχει σύνδεση/);
      await srv.start();
      await win.click('#retry');
      await until(async () => win.url().startsWith(srv.base), 'back on the server after retry', 20000);
    } finally {
      await quit(app);
    }
  });

  it('this-PC-only mode: own database, folder picker, backup on exit', async () => {
    fs.writeFileSync(configFile, JSON.stringify({ mode: 'local' }));
    const { app, win } = await launch();
    try {
      await until(async () => /^http:\/\/127\.0\.0\.1:\d+\//.test(win.url()), 'local server window', 30000);
      await win.waitForSelector('input[autocomplete=username]');
      const bridge = await win.evaluate(() => ({ mode: window.imsDesktop?.mode, folders: typeof window.imsDesktop?.chooseFolder }));
      assert.deepEqual(bridge, { mode: 'local', folders: 'function' });
      await win.fill('input[autocomplete=username]', 'admin');
      await win.fill('input[type=password]', 'admin123');
      await win.click('button[type=submit]');
      await win.waitForURL(/\/$/);
    } finally {
      await quit(app);
    }
    assert.ok(fs.existsSync(path.join(userData, 'data', 'pgdata', 'PG_VERSION')), 'database in the profile folder');
    assert.ok(!fs.existsSync(path.join(userData, 'data', 'pgdata.lock')), 'database closed on exit');
    const backups = fs.readdirSync(path.join(userData, 'data', 'backups')).filter((f) => f.endsWith('_auto.json.gz'));
    assert.ok(backups.length >= 1, 'backup taken on exit');
  });

  it('local data of this version opens without the start screen', async () => {
    fs.rmSync(configFile);
    const { app, win } = await launch();
    try {
      await until(async () => /^http:\/\/127\.0\.0\.1:\d+\//.test(win.url()), 'local server window without asking', 30000);
      assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { mode: 'local' });
    } finally {
      await quit(app);
    }
  });

  it('upgrade from 1.2: the SQLite database of this PC is copied at the first start', async () => {
    // A profile of version 1.2: only data\inventory.db, no settings file.
    const oldHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-desktop-12-'));
    const oldData = path.join(oldHome, 'Warehouse IMS', 'data');
    fs.mkdirSync(oldData, { recursive: true });
    const { default: Database } = await import('better-sqlite3');
    const { migrations } = await import(pathToFileURL(path.join(APP, 'server', 'dist', 'db', 'legacy', 'sqliteMigrations.js')).href);
    const bcrypt = (await import('bcryptjs')).default;
    const db = new Database(path.join(oldData, 'inventory.db'));
    const norm = (v) => (v == null ? null : String(v).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase());
    db.function('ims_norm', { deterministic: true }, norm);
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT '')`);
    for (const m of migrations) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    }
    db.exec(`INSERT INTO warehouses (id, code, name, is_default) VALUES (1, 'MAIN', 'Main', 1);
             INSERT INTO products (id, sku, name) VALUES (1, 'FROM-1-2', 'Προϊόν της 1.2');
             INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (1, 1, 42);`);
    db.prepare(`INSERT INTO users (id, username, full_name, password_hash, role) VALUES (1, 'admin', 'Admin', ?, 'ADMIN')`).run(
      bcrypt.hashSync('password-of-1.2', 4),
    );
    db.close();

    const { app, win } = await launch({ XDG_CONFIG_HOME: oldHome, APPDATA: oldHome });
    try {
      await until(async () => /^http:\/\/127\.0\.0\.1:\d+\//.test(win.url()), 'local server window without asking', 60000);
      await win.waitForSelector('input[autocomplete=username]');
      const products = await win.evaluate(async () => {
        const login = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'password-of-1.2' }),
        });
        if (!login.ok) return `login ${login.status}`;
        const res = await fetch('/api/products');
        return (await res.json()).data.map((p) => `${p.sku}:${p.quantity}`);
      });
      assert.deepEqual(products, ['FROM-1-2:42']);
    } finally {
      await quit(app);
    }
    assert.ok(fs.existsSync(path.join(oldData, 'pgdata', 'PG_VERSION')), 'new database created');
    assert.ok(fs.existsSync(path.join(oldData, 'inventory.db')), 'old database kept');
    fs.rmSync(oldHome, { recursive: true, force: true });
  });
});
