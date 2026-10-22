/**
 * The whole warehouse day in a real browser, through the screens only: create a product by hand
 * (decimal comma), reload, search, change its prices (Greek and English number formats) and
 * count its stock, import more products from Excel (with a bad row and an existing product),
 * receive a supplier invoice, try both files again (duplicate warnings), export the products and
 * compare every exported value with what was entered.
 *
 *   npm run e2e
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { apiLogin, launchBrowser, testServer, uiLogin, until } from './lib.mjs';
import { invoiceXlsx } from './invoice-fixtures.mjs';

const srv = testServer(Number(process.env.E2E_WORKFLOW_PORT ?? 4717));
const BASE = srv.base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-workflow-'));
let browser;
let page;
let cookie;
let id = 0;

const api = async (url, init = {}) => (await fetch(`${BASE}/api${url}`, { ...init, headers: { 'Content-Type': 'application/json', Cookie: cookie } })).json();
const bySku = async (sku) => {
  const p = (await api(`/products?q=${encodeURIComponent(sku)}`)).data.find((x) => x.sku === sku);
  return p && (await api(`/products/${p.id}`)).data;
};
const five = (p) => [p.sku, p.barcode, p.quantity, p.purchasePrice, p.sellingPrice];
const field = (label) => page.locator('main label', { hasText: label }).locator('input, textarea').first();
async function fill(label, value) {
  const f = field(label);
  await f.click();
  await f.fill(value);
}
const shot = async (name) => process.env.E2E_SCREENSHOTS && page.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `wf-${name}.png`), fullPage: true });

async function xlsx(name, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');
  ws.getColumn(1).numFmt = '@';
  ws.getColumn(2).numFmt = '@';
  for (const r of rows) ws.addRow(r);
  const file = path.join(dir, name);
  await wb.xlsx.writeFile(file);
  return file;
}

before(async () => {
  await srv.start();
  cookie = await apiLogin(BASE, 'admin', 'admin123');
  await api('/suppliers', { method: 'POST', body: JSON.stringify({ name: 'ACME Supplies' }) });
  browser = await launchBrowser();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })).newPage();
  await uiLogin(page, BASE, 'admin', 'admin123');
});

after(async () => {
  await browser?.close();
  srv.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a warehouse day, end to end', () => {
  it('1-3. create a product by hand: SKU with spaces, leading-zero barcode, description, quantity, both prices', async () => {
    await page.goto(`${BASE}/products/new`);
    await fill('SKU', 'WF 001');
    await fill('Barcode', '0012345678905');
    await fill('Όνομα προϊόντος', 'Workflow product 500ml');
    await fill('Περιγραφή', 'ACME brand — description with spaces,  punctuation; "quotes" & more.');
    await fill('Αρχική ποσότητα', '15');
    await fill('Τιμή αγοράς', '12,50');
    await fill('Τιμή πώλησης', '19.90');
    await page.getByRole('button', { name: 'Δημιουργία προϊόντος' }).click();
    await page.waitForURL(/\/products\/\d+$/);
    id = Number(page.url().split('/').pop());
    assert.deepEqual(five(await bySku('WF 001')), ['WF 001', '0012345678905', 15, 12.5, 19.9]);
    assert.equal((await bySku('WF 001')).description, 'ACME brand — description with spaces,  punctuation; "quotes" & more.');
  });

  it('4-5. after reloading, the product list finds it by SKU with other spacing and shows its values', async () => {
    await page.goto(`${BASE}/products`);
    await page.reload();
    await page.locator('main input[placeholder^="Αναζήτηση"]').fill('wf    001');
    const row = page.locator('tbody tr', { hasText: 'WF 001' });
    await row.waitFor();
    const text = await row.innerText();
    for (const v of ['0012345678905', '15', '12,50', '19,90']) assert.ok(text.includes(v), `${v} in ${text}`);
  });

  it('6. edit the prices with thousands separators, and count the stock', async () => {
    await page.goto(`${BASE}/products/${id}/edit`);
    await field('Τιμή αγοράς').waitFor();
    await fill('Τιμή αγοράς', '1.250,50');
    await fill('Τιμή πώλησης', '1,999.90');
    await page.getByRole('button', { name: 'Αποθήκευση αλλαγών' }).click();
    await page.waitForURL(new RegExp(`/products/${id}$`));
    assert.deepEqual(five(await bySku('WF 001')), ['WF 001', '0012345678905', 15, 1250.5, 1999.9]);

    await page.getByRole('button', { name: 'Διόρθωση αποθέματος' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'Φυσική καταμέτρηση' }).click().catch(() => {});
    await dialog.locator('input[inputmode=decimal]').first().fill('20');
    await dialog.getByRole('button', { name: 'Αποθήκευση διόρθωσης' }).click();
    await until(async () => (await bySku('WF 001')).quantity === 20, 'stock counted to 20');
    await page.reload();
    assert.deepEqual(five(await bySku('WF 001')), ['WF 001', '0012345678905', 20, 1250.5, 1999.9]);
  });

  it('7. Excel import: three new products, one bad row, and the existing product (delivery: +5)', async () => {
    const file = await xlsx('more.xlsx', [
      ['SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price'],
      ['WF 002', '0000000000017', 8, '3,20', '5,50'],
      ['WF 003', null, '1.250', '1.234,50', null],
      ['WF 004', '0098765432109', 0, 0, 0],
      ['WF BAD', null, 'many', 1, 1],
      ['wf   001', '0012345678905', 5, null, null],
    ]);
    await page.goto(`${BASE}/import-export`);
    await page.locator('input[type=file][accept=".xlsx,.xls,.csv"]').setInputFiles(file);
    await page.getByRole('button', { name: 'Έλεγχος 5 γραμμών' }).click();
    await page.getByText('Επιλέξτε τι σημαίνουν οι ποσότητες των υπαρχόντων προϊόντων').waitFor();
    assert.match(await page.locator('tbody tr', { hasText: 'WF BAD' }).innerText(), /not a valid number/);
    await page.getByRole('radio', { name: /^Προσθήκη στο απόθεμα/ }).click();
    await shot('excel-preview');
    await page.getByRole('button', { name: 'Εισαγωγή 4 έγκυρων γραμμών' }).click();
    await page.getByText('Η εισαγωγή ολοκληρώθηκε').waitFor();
    assert.deepEqual(five(await bySku('WF 001')), ['WF 001', '0012345678905', 25, 1250.5, 1999.9]);
    assert.deepEqual(five(await bySku('WF 002')), ['WF 002', '0000000000017', 8, 3.2, 5.5]);
    assert.deepEqual(five(await bySku('WF 003')), ['WF 003', null, 1250, 1234.5, null]);
    assert.deepEqual(five(await bySku('WF 004')), ['WF 004', '0098765432109', 0, 0, 0]);
    assert.equal(await bySku('WF BAD'), undefined);
  });

  it('8. supplier invoice: the existing product by its code, a new product from a line', async () => {
    await invoiceXlsx(
      { number: 'ACME-77', lines: [{ code: 'WF 001', description: 'WORKFLOW PRODUCT 500ML', quantity: 10, price: 13, value: 130 }, { code: 'NEW-9', description: 'ACME NEW ITEM', quantity: 4, price: 2.5, value: 10 }] },
      path.join(dir, 'acme-77.xlsx'),
    );
    await page.goto(`${BASE}/stock-in?tab=invoice`);
    await page.getByLabel('Προμηθευτής').selectOption({ label: 'ACME Supplies' });
    await page.getByLabel('Αριθμός τιμολογίου').first().fill('ACME-77');
    await page.locator('input[type=file][accept*=".pdf"]').setInputFiles(path.join(dir, 'acme-77.xlsx'));
    await page.getByRole('button', { name: 'Έλεγχος γραμμών' }).click();
    await page.getByText('Αντιστοιχίστηκαν').waitFor();
    await page.getByRole('button', { name: /Νέο προϊόν για τις 1 γραμμές/ }).click();
    const receive = page.getByRole('button', { name: /Παραλαβή 2 γραμμών/ });
    await until(async () => !(await receive.isDisabled()), 'receive enabled');
    await shot('invoice-review');
    await receive.click();
    await page.getByText('Το τιμολόγιο παρελήφθη').waitFor();
    assert.deepEqual(five(await bySku('WF 001')), ['WF 001', '0012345678905', 35, 13, 1999.9]);
    assert.deepEqual(five(await bySku('NEW-9')), ['NEW-9', null, 4, 2.5, null]);
    assert.equal((await bySku('NEW-9')).name, 'ACME NEW ITEM');
  });

  it('9. the same Excel file and the same invoice again are both caught before anything is added', async () => {
    await page.goto(`${BASE}/import-export`);
    await page.locator('input[type=file][accept=".xlsx,.xls,.csv"]').setInputFiles(path.join(dir, 'more.xlsx'));
    await page.getByRole('button', { name: 'Έλεγχος 5 γραμμών' }).click();
    await page.getByText('Αυτό το αρχείο έχει ήδη εισαχθεί').waitFor();
    await page.getByRole('radio', { name: /^Προσθήκη στο απόθεμα/ }).click();
    assert.equal(await page.getByRole('button', { name: /Εισαγωγή \d+ έγκυρων γραμμών/ }).isDisabled(), true);

    await page.goto(`${BASE}/stock-in?tab=invoice`);
    await page.getByLabel('Προμηθευτής').selectOption({ label: 'ACME Supplies' });
    await page.getByLabel('Αριθμός τιμολογίου').first().fill('ACME-77');
    await page.locator('input[type=file][accept*=".pdf"]').setInputFiles(path.join(dir, 'acme-77.xlsx'));
    await page.getByText('Αυτό το τιμολόγιο έχει ήδη παραληφθεί').waitFor();
    assert.equal((await bySku('WF 001')).quantity, 35);
  });

  it('10-12. export from the screen, and every value of every product is what was entered', async () => {
    await page.goto(`${BASE}/import-export?tab=export`);
    const row = page.locator('div.px-4.py-3', { has: page.getByText('Όλα τα προϊόντα', { exact: true }) });
    const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: '.xlsx' }).click()]);
    const file = path.join(dir, 'export.xlsx');
    await download.saveAs(file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0];
    assert.deepEqual(ws.getRow(1).values.slice(1), ['SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price']);
    const rows = {};
    ws.eachRow((r, n) => n > 1 && (rows[r.getCell(1).value] = [r.getCell(1).value, r.getCell(2).value ?? null, r.getCell(3).value, r.getCell(4).value, r.getCell(5).value ?? null]));
    assert.deepEqual(rows, {
      'WF 001': ['WF 001', '0012345678905', 35, 13, 1999.9],
      'WF 002': ['WF 002', '0000000000017', 8, 3.2, 5.5],
      'WF 003': ['WF 003', null, 1250, 1234.5, null],
      'WF 004': ['WF 004', '0098765432109', 0, 0, 0],
      'NEW-9': ['NEW-9', null, 4, 2.5, null],
    });
    // The same in the database, after a reload of the application.
    await page.goto(`${BASE}/products`);
    await page.reload();
    for (const [sku, values] of Object.entries(rows)) assert.deepEqual(five(await bySku(sku)), values, sku);
  });
});
