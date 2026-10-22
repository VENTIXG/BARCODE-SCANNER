/**
 * Every screen, for every role, on a desktop and on a phone: it opens without a browser error,
 * without a failed request and without the error screen; its tabs and sortable columns work;
 * on the phone nothing is wider than the screen. Demo data fills every list.
 *
 *   npm run e2e
 */
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiLogin, createUser, launchBrowser, log, testServer, uiLogin } from './lib.mjs';

const srv = testServer(Number(process.env.E2E_SCREENS_PORT ?? 4716));
const BASE = srv.base;
let browser;
let cookie;
const ids = {};

const api = async (url, init = {}) => {
  const r = await fetch(`${BASE}/api${url}`, { ...init, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) } });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};

const ROLES = {
  admin: { password: 'admin123' },
  e2e_manager: { role: 'MANAGER', password: 'manager-pass-1' },
  e2e_worker: { role: 'WAREHOUSE_USER', password: 'worker-pass-1' },
};

/** [path, who may open it] — the others see "Access denied" (and no failing request). */
const screens = () => [
  ['/', 'all'],
  ['/products', 'all'],
  ['/products/new', 'mgmt'],
  [`/products/${ids.product}`, 'all'],
  [`/products/${ids.product}/edit`, 'mgmt'],
  ['/scanner', 'all'],
  ['/stock-in', 'all'],
  ['/stock-in?tab=invoice', 'all'],
  ['/stock-in?tab=history', 'all'],
  [`/stock-in/${ids.receipt}`, 'all'],
  ['/stock-out', 'all'],
  ['/stock-out?tab=history', 'all'],
  [`/stock-out/${ids.dispatch}`, 'all'],
  ['/inventory', 'all'],
  ['/low-stock', 'all'],
  ['/transactions', 'mgmt'],
  ['/suppliers', 'all'],
  ['/categories', 'all'],
  ['/import-export', 'mgmt'],
  ['/import-export?tab=export', 'mgmt'],
  ['/reports', 'mgmt'],
  ['/activity', 'mgmt'],
  ['/users', 'admin'],
  ['/settings', 'all'],
  ['/profile', 'all'],
];
const allowed = (who, user) => who === 'all' || (who === 'mgmt' && user !== 'e2e_worker') || (who === 'admin' && user === 'admin');

before(async () => {
  await srv.start();
  cookie = await apiLogin(BASE, 'admin', 'admin123');
  const demo = await api('/settings/demo-data', { method: 'POST' });
  assert.equal(demo.status, 201, JSON.stringify(demo.body));
  for (const [username, u] of Object.entries(ROLES))
    if (u.role) await createUser(BASE, cookie, { username, fullName: username, role: u.role, password: u.password, isActive: true });
  ids.product = (await api('/products?pageSize=1')).body.data[0].id;
  ids.receipt = (await api('/receipts?pageSize=1')).body.data[0].id;
  ids.dispatch = (await api('/dispatches?pageSize=1')).body.data[0].id;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  srv.cleanup();
});

for (const [device, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
]) {
  for (const user of Object.keys(ROLES)) {
    describe(`${user} on a ${device}`, () => {
      let page;
      const problems = [];
      before(async () => {
        page = await (await browser.newContext({ viewport, isMobile: device === 'phone', hasTouch: device === 'phone' })).newPage();
        page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
        page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
        page.on('response', (r) => r.status() >= 400 && r.url().includes('/api/') && problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
        await uiLogin(page, BASE, user, ROLES[user].password);
      });
      after(() => page?.context().close());

      it('every screen', async () => {
        const report = [];
        for (const [route, who] of screens()) {
          problems.length = 0;
          await page.goto(`${BASE}${route}`);
          await page.waitForLoadState('networkidle');
          const denied = await page.getByText('Δεν επιτρέπεται η πρόσβαση').count();
          if (!allowed(who, user)) {
            assert.ok(denied > 0, `${route}: ${user} should see "access denied"`);
          } else {
            assert.equal(denied, 0, `${route}: ${user} should be allowed`);
            // Tabs and sortable columns of the screen.
            for (const tab of await page.locator('main [role=tablist] [role=tab], main nav [role=tab]').all()) await tab.click().catch(() => {});
            // Sortable columns that are shown at this width.
            const sorters = await page.locator('main thead button').all();
            for (const sorter of sorters.slice(0, 10)) {
              if (!(await sorter.isVisible())) continue;
              await sorter.click();
              await page.waitForLoadState('networkidle');
            }
          }
          const crashed = await page.getByText('Η σελίδα δεν μπόρεσε να εμφανιστεί.').count();
          const overflow = device === 'phone' ? await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) : 0;
          const issues = [...problems, ...(crashed ? ['error screen shown'] : []), ...(overflow > 1 ? [`${overflow}px wider than the screen`] : [])];
          if (issues.length) report.push(`${route}: ${[...new Set(issues)].join(' | ')}`);
          if (device === 'phone' && user === 'admin' && process.env.E2E_SCREENSHOTS)
            await page.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `phone${route.replace(/[/?=]/g, '_')}.png`), fullPage: true });
        }
        log(`${user} / ${device}: ${screens().length} screens, ${report.length} with problems`);
        assert.deepEqual(report, []);
      });
    });
  }
}
