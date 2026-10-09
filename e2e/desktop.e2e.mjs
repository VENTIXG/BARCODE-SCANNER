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
    assert.ok(fs.existsSync(path.join(userData, 'data', 'inventory.db')), 'database in the profile folder');
    const backups = fs.readdirSync(path.join(userData, 'data', 'backups')).filter((f) => f.endsWith('_auto.db'));
    assert.ok(backups.length >= 1, 'backup taken on exit');
  });

  it('upgrade from 1.x: existing local data opens without the start screen', async () => {
    fs.rmSync(configFile);
    const { app, win } = await launch();
    try {
      await until(async () => /^http:\/\/127\.0\.0\.1:\d+\//.test(win.url()), 'local server window without asking', 30000);
      assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { mode: 'local' });
    } finally {
      await quit(app);
    }
  });
});
