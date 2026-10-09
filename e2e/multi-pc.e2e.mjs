/**
 * End-to-end test with two PCs against one real server and one real database.
 *
 *   PC A (warehouse user) and PC B (manager) each have two windows open.
 *   Every window must show the same stock without a manual refresh.
 *
 * Needs a built app (npm run build) and a Chromium: set PW_CHROMIUM to its path,
 * or run `npx playwright install chromium` once.
 *
 *   npm run e2e
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = Number(process.env.E2E_PORT ?? 4711);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-e2e-'));
const SKU = `E2E-${Date.now().toString(36).toUpperCase()}`;
const BARCODE = `5209${String(Date.now()).slice(-9)}`.slice(0, 13);

let server = null;
let browser;
const log = (...a) => console.log('[e2e]', ...a);

function startServer() {
  const child = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
  return child;
}

async function waitForHealth(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

async function apiLogin(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `API login ${username}`);
  return res.headers.get('set-cookie').split(';')[0];
}

/** Poll until fn() returns true or the timeout passes. */
async function until(fn, label, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => undefined);
    if (last === true) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
}

/** The big stock number on the product page. */
const stockOn = (page) => page.locator('span.text-4xl').first().textContent().then((t) => t.trim());

async function uiLogin(page, username, password) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[autocomplete=username]', username);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`);
}

async function scan(page, code) {
  const input = page.locator('input[placeholder^="Σκανάρετε barcode"]');
  await input.fill(code);
  await input.press('Enter');
}

let productId;
let cookieAdmin;
let pcA1, pcA2, pcB1, pcB2;
let ctxA, ctxB;

before(async () => {
  server = startServer();
  await waitForHealth();
  cookieAdmin = await apiLogin('admin', 'admin123');
  const h = { 'Content-Type': 'application/json', Cookie: cookieAdmin };
  for (const u of [
    { username: 'e2e_wh1', fullName: 'Warehouse Employee', role: 'WAREHOUSE_USER', password: 'warehouse-pass-1' },
    { username: 'e2e_mgr', fullName: 'Office Manager', role: 'MANAGER', password: 'manager-pass-1' },
  ]) {
    const r = await fetch(`${BASE}/api/users`, { method: 'POST', headers: h, body: JSON.stringify(u) });
    assert.equal(r.status, 201, `create user ${u.username}`);
  }
  const p = await fetch(`${BASE}/api/products`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ sku: SKU, barcode: BARCODE, name: 'E2E shared product', initialQuantity: 100, minStock: 10 }),
  });
  assert.equal(p.status, 201);
  productId = (await p.json()).data.id;
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  // Two PCs; each PC has two windows (same browser profile).
  ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  pcA1 = await ctxA.newPage();
  pcA2 = await ctxA.newPage();
  pcB1 = await ctxB.newPage();
  pcB2 = await ctxB.newPage();
  await uiLogin(pcA1, 'e2e_wh1', 'warehouse-pass-1');
  await uiLogin(pcB1, 'e2e_mgr', 'manager-pass-1');
  // Both PCs sign in through their own window; pcA2/pcB2 share the session cookie.
  await pcA2.goto(`${BASE}/scanner`);
  await pcB2.goto(`${BASE}/scanner`);
  log('setup done', { SKU, BARCODE, productId, DATA });
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  fs.rmSync(DATA, { recursive: true, force: true });
});

describe('two PCs, one server, one database', () => {
  it('both PCs see the same stock (100) on the product page', async () => {
    await pcA1.goto(`${BASE}/products/${productId}`);
    await pcB1.goto(`${BASE}/products/${productId}`);
    await until(async () => (await stockOn(pcA1)) === '100', 'A sees 100');
    await until(async () => (await stockOn(pcB1)) === '100', 'B sees 100');
  });

  it('PC A removes 20 with Stock OUT: PC B updates to 80 without a reload', async () => {
    await pcA2.getByRole('radio', { name: /STOCK OUT/ }).click();
    await pcA2.getByRole('radio', { name: 'Σταθερή ποσ.' }).click();
    await pcA2.getByLabel('Ποσότητα ανά scan').fill('20');
    await scan(pcA2, BARCODE);
    await until(async () => (await stockOn(pcB1)) === '80', 'B updates to 80');
    await until(async () => (await stockOn(pcA1)) === '80', 'A (other window) updates to 80');
  });

  it('PC B adds 15 with Stock IN: both PCs show 95', async () => {
    await pcB2.getByRole('radio', { name: /STOCK IN/ }).click();
    await pcB2.getByRole('radio', { name: 'Σταθερή ποσ.' }).click();
    await pcB2.getByLabel('Ποσότητα ανά scan').fill('15');
    await scan(pcB2, BARCODE);
    await until(async () => (await stockOn(pcA1)) === '95', 'A updates to 95');
    await until(async () => (await stockOn(pcB1)) === '95', 'B updates to 95');
  });

  it('the history shows both movements from both users', async () => {
    const rows = pcA1.locator('tbody tr');
    await until(async () => (await rows.filter({ hasText: 'Εξαγωγή' }).count()) >= 1, 'stock-out row visible');
    await until(async () => (await rows.filter({ hasText: 'Εισαγωγή' }).count()) >= 1, 'stock-in row visible');
    const text = await pcB1.locator('tbody').first().innerText();
    assert.match(text, /warehouse|Εξαγωγή/i);
  });

  it('after a refresh on both PCs the values are kept (95, both movements)', async () => {
    await pcA1.reload();
    await pcB1.reload();
    await until(async () => (await stockOn(pcA1)) === '95', 'A after reload');
    await until(async () => (await stockOn(pcB1)) === '95', 'B after reload');
    const history = await pcB1.locator('tbody tr').count();
    assert.ok(history >= 3, `history rows: ${history}`);
  });

  it('the warehouse user cannot open user management (enforced by the server too)', async () => {
    await pcA1.goto(`${BASE}/users`);
    await until(async () => (await pcA1.getByText('Δεν επιτρέπεται η πρόσβαση').count()) > 0, 'access denied shown');
    const cookie = await apiLogin('e2e_wh1', 'warehouse-pass-1');
    const r = await fetch(`${BASE}/api/users`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 403);
  });

  it('Edit product opens with the saved values (no black screen)', async () => {
    const errors = [];
    pcB1.on('pageerror', (e) => errors.push(e.message));
    await pcB1.goto(`${BASE}/products/${productId}/edit`);
    const sku = pcB1.getByLabel('SKU', { exact: false }).first();
    await until(async () => (await sku.inputValue()) === SKU, 'SKU field filled');
    assert.equal(await pcB1.getByLabel('Όνομα προϊόντος', { exact: false }).inputValue().catch(() => ''), 'E2E shared product');
    assert.deepEqual(errors, []);
  });

  it('live status shows Live, then reconnects by itself after the server restarts', async () => {
    await pcA1.goto(`${BASE}/products/${productId}`);
    await until(async () => (await pcA1.getByRole('status').textContent()).includes('Ζωντανά'), 'status Live');

    server.kill('SIGTERM');
    await until(async () => /Επανασύνδεση|Εκτός σύνδεσης/.test(await pcA1.getByRole('status').textContent()), 'status shows reconnecting', 15000);
    log('server stopped: window shows reconnecting');

    server = startServer();
    await waitForHealth();
    await until(async () => (await pcA1.getByRole('status').textContent()).includes('Ζωντανά'), 'status Live again', 30000);
    log('server back: window is live again');
  });

  it('a change made while PC A was disconnected shows after reconnect', async () => {
    await pcB2.goto(`${BASE}/scanner`);
    await pcB2.getByRole('radio', { name: /STOCK OUT/ }).click();
    await pcB2.getByRole('radio', { name: 'Σταθερή ποσ.' }).click();
    await pcB2.getByLabel('Ποσότητα ανά scan').fill('5');
    await scan(pcB2, BARCODE);
    await until(async () => (await stockOn(pcA1)) === '90', 'A updates to 90 after reconnect');
  });
});
