/**
 * Excel product import in a real browser: SKU | Barcode Number | Quantity | Purchase Price |
 * Selling Price are all saved and shown after a refresh; for products that already exist the
 * quantity rule is chosen (add / set / leave) and the same file is not added to stock twice
 * unnoticed. Column titles in Greek and English are recognised.
 *
 *   npm run e2e
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { apiLogin, launchBrowser, testServer, uiLogin } from './lib.mjs';

const srv = testServer(Number(process.env.E2E_IMPORT_PORT ?? 4715));
const BASE = srv.base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-import-'));
let browser;
let page;
let cookie;

const api = async (url) => (await fetch(`${BASE}/api${url}`, { headers: { Cookie: cookie } })).json();
const product = async (sku) => {
  const p = (await api(`/products?q=${encodeURIComponent(sku)}`)).data.find((x) => x.sku === sku);
  return p && (await api(`/products/${p.id}`)).data;
};
const five = (p) => [p.sku, p.barcode, p.quantity, p.purchasePrice, p.sellingPrice];

/** An .xlsx with these rows; codes in text cells, as the template has them. */
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
const HEADER = ['SKU', 'Barcode Number', 'Quantity', 'Purchase Price', 'Selling Price'];

async function upload(file, rows) {
  await page.goto(`${BASE}/import-export`);
  await page.locator('input[type=file][accept=".xlsx,.xls,.csv"]').setInputFiles(file);
  await page.getByRole('button', { name: `Έλεγχος ${rows} γραμμών` }).waitFor();
}
const mapping = () => page.locator('tbody select').evaluateAll((els) => els.map((e) => e.value));
const importButton = (n) => page.getByRole('button', { name: `Εισαγωγή ${n} έγκυρων γραμμών` });
/** The text of each cell of the product's row in the product list, after a full reload. */
async function listRow(sku) {
  await page.goto(`${BASE}/products?q=${encodeURIComponent(sku)}`);
  await page.reload();
  const row = page.locator('tbody tr', { hasText: sku });
  await row.waitFor();
  const headers = await page.locator('thead th').allInnerTexts();
  const cells = await row.locator('td').allInnerTexts();
  return Object.fromEntries(headers.map((h, i) => [h.trim().toUpperCase(), (cells[i] ?? '').trim()]));
}
const shot = async (name) => process.env.E2E_SCREENSHOTS && page.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true });

before(async () => {
  await srv.start();
  cookie = await apiLogin(BASE, 'admin', 'admin123');
  browser = await launchBrowser();
  page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await uiLogin(page, BASE, 'admin', 'admin123');
});

after(async () => {
  await browser?.close();
  srv.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Excel import: quantity and prices', () => {
  it('new product ABC 123: the five values are saved and shown after a refresh', async () => {
    const file = await xlsx('abc.xlsx', [HEADER, ['ABC 123', '5201234567890', 15, '12.50', 19.9]]);
    await upload(file, 1);
    assert.deepEqual(await mapping(), ['sku', 'barcode', 'quantity', 'purchasePrice', 'sellingPrice']);
    await page.getByRole('button', { name: 'Έλεγχος 1 γραμμών' }).click();
    await importButton(1).waitFor();
    // The preview shows the quantity and both prices of the file.
    const preview = await page.locator('tbody tr', { hasText: 'ABC 123' }).innerText();
    for (const v of ['15', '12.50', '19.9']) assert.ok(preview.includes(v), `${v} in ${preview}`);
    await shot('import-1-new');
    await importButton(1).click();
    await page.getByText('Η εισαγωγή ολοκληρώθηκε').waitFor();

    assert.deepEqual(five(await product('ABC 123')), ['ABC 123', '5201234567890', 15, 12.5, 19.9]);
    const row = await listRow('ABC 123');
    assert.equal(row.SKU, 'ABC 123');
    assert.equal(row.BARCODE, '5201234567890');
    assert.equal(row['ΑΠΟΘΕΜΑ'], '15');
    assert.match(row['ΤΙΜΗ ΑΓΟΡΑΣ'], /^12,50\s€$/);
    assert.match(row['ΤΙΜΗ ΠΩΛΗΣΗΣ'], /^19,90\s€$/);
    await shot('import-2-list');
  });

  it('existing product: the quantity rule is asked; "add" gives 15 + 5 = 20, an empty selling price keeps 19,90', async () => {
    const file = await xlsx('delivery.xlsx', [HEADER, ['ABC 123', '5201234567890', 5, '13,00', null]]);
    await upload(file, 1);
    await page.getByRole('button', { name: 'Έλεγχος 1 γραμμών' }).click();
    await importButton(1).waitFor();
    assert.equal(await importButton(1).isDisabled(), true, 'quantity rule not chosen yet');
    await page.getByText('Επιλέξτε τι σημαίνουν οι ποσότητες των υπαρχόντων προϊόντων').waitFor();
    await page.getByRole('radio', { name: /^Προσθήκη στο απόθεμα/ }).click();
    const preview = await page.locator('tbody tr', { hasText: 'ABC 123' }).innerText();
    assert.ok(preview.includes('15 → 20'), preview);
    assert.match(preview, /μένει 19,90\s€/);
    await shot('import-3-existing');
    await importButton(1).click();
    await page.getByText('Η εισαγωγή ολοκληρώθηκε').waitFor();
    assert.deepEqual(five(await product('ABC 123')), ['ABC 123', '5201234567890', 20, 13, 19.9]);
    const row = await listRow('ABC 123');
    assert.equal(row['ΑΠΟΘΕΜΑ'], '20');
    assert.match(row['ΤΙΜΗ ΑΓΟΡΑΣ'], /^13,00\s€$/);
    assert.match(row['ΤΙΜΗ ΠΩΛΗΣΗΣ'], /^19,90\s€$/);
  });

  it('the same file again: warned; adding needs confirmation; "set" makes the stock 5', async () => {
    await upload(path.join(dir, 'delivery.xlsx'), 1);
    await page.getByRole('button', { name: 'Έλεγχος 1 γραμμών' }).click();
    await page.getByText('Αυτό το αρχείο έχει ήδη εισαχθεί').waitFor();
    await page.getByRole('radio', { name: /^Προσθήκη στο απόθεμα/ }).click();
    assert.equal(await importButton(1).isDisabled(), true, 'adding the same file again needs confirmation');
    await page.getByText('Να προστεθούν ξανά οι ποσότητές του στο απόθεμα').waitFor();
    await shot('import-4-duplicate');
    await page.getByRole('radio', { name: /^Ορισμός αποθέματος/ }).click();
    assert.ok((await page.locator('tbody tr', { hasText: 'ABC 123' }).innerText()).includes('20 → 5'));
    await importButton(1).click();
    await page.getByText('Η εισαγωγή ολοκληρώθηκε').waitFor();
    assert.equal((await product('ABC 123')).quantity, 5);
    assert.equal((await listRow('ABC 123'))['ΑΠΟΘΕΜΑ'], '5');
  });

  it('Greek and English column titles; totals are never taken as a price', async () => {
    const greek = await xlsx('greek.xlsx', [
      ['Κωδικός', 'Περιγραφή', 'Τεμάχια', 'Τιμή Αγοράς', 'Τιμή Πώλησης', 'Σύνολο'],
      ['GR-1', 'Δοκιμή', 2, '1,50', '2,90', '3,00'],
    ]);
    await upload(greek, 1);
    assert.deepEqual(await mapping(), ['sku', 'description', 'quantity', 'purchasePrice', 'sellingPrice', '']);
    const english = await xlsx('english.xlsx', [
      ['Code', 'Name', 'Qty', 'Unit Cost', 'Unit Price', 'Line Total', 'Minimum Stock Level'],
      ['EN-1', 'Test', 2, 1.5, 2.9, 3, 1],
    ]);
    await upload(english, 1);
    assert.deepEqual(await mapping(), ['sku', 'name', 'quantity', 'purchasePrice', 'sellingPrice', '', 'minStock']);
    await page.getByRole('button', { name: 'Έλεγχος 1 γραμμών' }).click();
    await importButton(1).click();
    await page.getByText('Η εισαγωγή ολοκληρώθηκε').waitFor();
    const p = await product('EN-1');
    assert.deepEqual([p.name, p.quantity, p.purchasePrice, p.sellingPrice, p.minStock], ['Test', 2, 1.5, 2.9, 1]);
  });
});
