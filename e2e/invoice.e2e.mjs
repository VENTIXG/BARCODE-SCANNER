/**
 * Supplier invoice to warehouse, in a real browser: a PDF invoice (printed by Chromium, like the
 * PDF of an invoicing program) and an Excel invoice. The first invoice of a supplier asks for
 * its columns once; the next one is read by itself and a second import of the same invoice
 * is stopped with a warning.
 *
 *   npm run e2e
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiLogin, launchBrowser, log, testServer, uiLogin, until } from './lib.mjs';
import { invoicePdf, invoiceXlsx } from './invoice-fixtures.mjs';

const srv = testServer(Number(process.env.E2E_INVOICE_PORT ?? 4714));
const BASE = srv.base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-invoices-'));
let browser;
let page;
let cookie;
const ids = {};
let supplierA;
let supplierB;

const api = async (method, url, body) => {
  const r = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = r.status === 204 ? null : await r.json();
  return { status: r.status, body: json };
};

const pdfLines = [
  // Same product, other letter case and spacing on the invoice.
  { code: 'C-330', description: 'COLA  330ML', quantity: '24', price: '0,35', value: '8,40' },
  // Similar only: must be confirmed.
  { code: '', description: 'ΕΛΑΙΟΛΑΔΟ ΕΞΑΙΡΕΤΙΚΟ ΠΑΡΘΕΝΟ 1L', quantity: '6', price: '7,20', value: '43,20' },
  // Not in the warehouse; Greek number format with a discount (1.200 pieces).
  { code: 'K-194', description: 'ΚΑΦΕΣ ΕΛΛΗΝΙΚΟΣ 194G', quantity: '1.200', price: '2,10', discount: '10,00', value: '2.268,00' },
];

before(async () => {
  await srv.start();
  cookie = await apiLogin(BASE, 'admin', 'admin123');
  supplierA = (await api('POST', '/suppliers', { name: 'Αφοί Δοκιμή Α.Ε.' })).body.data.id;
  supplierB = (await api('POST', '/suppliers', { name: 'Excel Supplier Ltd' })).body.data.id;
  for (const [key, body] of Object.entries({
    cola: { sku: 'COLA-330', name: 'Cola 330ml', purchasePrice: 0.3 },
    oil: { sku: 'OIL 1L', name: 'Ελαιόλαδο Παρθένο 1L', purchasePrice: 6.5 },
    water: { sku: 'NERO 500', name: 'Νερό Φυσικό 500ml', barcode: '0520000000123', purchasePrice: 0.2 },
  })) {
    const r = await api('POST', '/products', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids[key] = r.body.data.id;
  }
  browser = await launchBrowser();
  await invoicePdf(browser, { number: 'Α 100', supplier: 'ΑΦΟΙ ΔΟΚΙΜΗ Α.Ε.', lines: pdfLines }, path.join(dir, 'invoice-A100.pdf'));
  await invoiceXlsx(
    {
      number: 'B-55',
      lines: [
        { code: 'W500', description: 'ΝΕΡΟ   ΦΥΣΙΚΟ 500ML', quantity: 48, price: 0.18, value: 8.64 },
        { code: 'COLA-330', description: 'Κόλα κουτί', quantity: 12, price: 0.33, value: 3.96 },
      ],
    },
    path.join(dir, 'invoice-B55.xlsx'),
  );
  page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  await uiLogin(page, BASE, 'admin', 'admin123');
});

after(async () => {
  await browser?.close();
  srv.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function openInvoice(supplierName, number, file) {
  await page.goto(`${BASE}/stock-in?tab=invoice`);
  await page.getByLabel('Προμηθευτής').selectOption({ label: supplierName });
  await page.getByLabel('Αριθμός τιμολογίου').first().fill(number);
  await page.locator('input[type=file][accept*=".pdf"]').setInputFiles(file);
}

const productSelect = (n) => page.getByLabel(`Προϊόν για τη γραμμή ${n}`, { exact: true });
const lineRow = (n) => page.locator('tbody tr', { has: productSelect(n) });
const stockOf = async (id) => (await api('GET', `/products/${id}`)).body.data;
/** E2E_SCREENSHOTS=<folder>: pictures of the screens, to look at them. */
const shot = async (name) => process.env.E2E_SCREENSHOTS && page.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `${name}.png`), fullPage: true });

describe('supplier invoice to warehouse', () => {
  it('PDF invoice, first time: the columns are recognised from the invoice titles', async () => {
    await openInvoice('Αφοί Δοκιμή Α.Ε.', 'Α 100', path.join(dir, 'invoice-A100.pdf'));
    await page.getByText('Στήλες του τιμολογίου').waitFor();
    const field = async (title) => page.getByLabel(`Στήλη ${title}`, { exact: true }).inputValue();
    assert.equal(await field('Περιγραφή'), 'description');
    assert.equal(await field('Κωδικός'), 'sku');
    assert.equal(await field('Ποσότητα'), 'quantity');
    assert.equal(await field('Τιμή'), 'unitPrice');
    assert.equal(await field('Αξία'), 'lineTotal');
    assert.equal(await field('Έκπτ.%'), '');
    await page.getByText('Βρέθηκαν 3 γραμμές ειδών').waitFor();
    await shot('invoice-columns');
    await page.getByRole('button', { name: 'Έλεγχος γραμμών' }).click();
  });

  it('review: sure matches are ready, the rest waits for a decision', async () => {
    await page.getByText('Αντιστοιχίστηκαν').waitFor();
    // Line 1: same description, other case and spacing.
    assert.equal(await productSelect(1).inputValue(), `p${ids.cola}`);
    assert.match(await lineRow(1).textContent(), /ίδια περιγραφή/);
    // Line 2: only similar, not chosen by itself; the similar product is offered.
    assert.equal(await productSelect(2).inputValue(), '');
    const options = await productSelect(2).locator('option').allInnerTexts();
    assert.ok(options.some((o) => o.includes('OIL 1L') && o.includes('παρόμοια περιγραφή')), options.join(' | '));
    // Line 3: 1.200 pieces, net cost after the 10% discount (2.268,00 / 1.200).
    assert.equal(await lineRow(3).getByLabel('Ποσότητα').inputValue(), '1200');
    assert.equal(await lineRow(3).getByLabel('Τιμή μονάδας').inputValue(), '1,89');
    const receive = page.getByRole('button', { name: /Παραλαβή \d+ γραμμών/ });
    await shot('invoice-review');
    assert.equal(await receive.isDisabled(), true, 'cannot receive with undecided lines');
    await productSelect(2).selectOption(`p${ids.oil}`);
    await page.getByRole('button', { name: /Νέο προϊόν για τις 1 γραμμές/ }).click();
    assert.equal(await lineRow(3).getByLabel('Όνομα').inputValue(), 'ΚΑΦΕΣ ΕΛΛΗΝΙΚΟΣ 194G');
    await until(async () => !(await receive.isDisabled()), 'receive enabled');
    await receive.click();
    await page.getByText('Το τιμολόγιο παρελήφθη').waitFor();
    log('PDF invoice received');
  });

  it('stock, costs and the new product are right; the receipt keeps the invoice text', async () => {
    assert.equal((await stockOf(ids.cola)).quantity, 24);
    assert.deepEqual([(await stockOf(ids.oil)).quantity, (await stockOf(ids.oil)).purchasePrice], [6, 7.2]);
    const created = (await api('GET', '/products?q=ΚΑΦΕΣ ΕΛΛΗΝΙΚΟΣ 194G')).body.data[0];
    assert.deepEqual(
      { name: created.name, sku: created.sku, quantity: created.quantity, purchasePrice: created.purchasePrice, sellingPrice: created.sellingPrice },
      { name: 'ΚΑΦΕΣ ΕΛΛΗΝΙΚΟΣ 194G', sku: 'K-194', quantity: 1200, purchasePrice: 1.89, sellingPrice: null },
    );
    await page.getByRole('button', { name: 'Προβολή παραλαβής' }).click();
    await page.getByText('Στο τιμολόγιο: ΕΛΑΙΟΛΑΔΟ ΕΞΑΙΡΕΤΙΚΟ ΠΑΡΘΕΝΟ 1L').waitFor();
    await page.getByText('Α 100').first().waitFor();
  });

  it('the next invoice of the supplier is read by itself; the same invoice again is stopped', async () => {
    await openInvoice('Αφοί Δοκιμή Α.Ε.', 'Α 100', path.join(dir, 'invoice-A100.pdf'));
    await page.getByText('διαβάστηκε με την αποθηκευμένη μορφή του προμηθευτή').waitFor();
    // The supplier's description saved on the first invoice now matches by itself.
    assert.equal(await productSelect(2).inputValue(), `p${ids.oil}`);
    assert.equal(await productSelect(3).inputValue(), `p${(await api('GET', '/products?q=K-194')).body.data[0].id}`);
    await page.getByText('Αυτό το τιμολόγιο έχει ήδη παραληφθεί').waitFor();
    await shot('invoice-duplicate');
    const receive = page.getByRole('button', { name: /Παραλαβή 3 γραμμών/ });
    assert.equal(await receive.isDisabled(), true, 'a duplicate needs confirmation');
    await page.getByText('Να παραληφθεί ξανά').click();
    assert.equal(await receive.isDisabled(), false);
    // Not received twice in this test: cancel.
    await page.getByRole('button', { name: 'Ακύρωση' }).click();
    assert.equal((await stockOf(ids.cola)).quantity, 24);
  });

  it('Excel invoice of another supplier: supplier code and leading-zero barcode products', async () => {
    await openInvoice('Excel Supplier Ltd', 'B-55', path.join(dir, 'invoice-B55.xlsx'));
    await page.getByText('Στήλες του τιμολογίου').waitFor();
    assert.equal(await page.getByLabel('Στήλη Τιμή μονάδας', { exact: true }).inputValue(), 'unitPrice');
    assert.equal(await page.getByLabel('Στήλη Καθαρή αξία', { exact: true }).inputValue(), 'lineTotal');
    await page.getByRole('button', { name: 'Έλεγχος γραμμών' }).click();
    await page.getByText('Αντιστοιχίστηκαν').waitFor();
    // "ΝΕΡΟ   ΦΥΣΙΚΟ 500ML": same description as "Νερό Φυσικό 500ml", spaces and accents aside.
    assert.equal(await productSelect(1).inputValue(), `p${ids.water}`);
    // Our SKU in the supplier's code column.
    assert.equal(await productSelect(2).inputValue(), `p${ids.cola}`);
    // The description is shown exactly as on the invoice (three spaces).
    assert.ok((await lineRow(1).textContent()).includes('ΝΕΡΟ   ΦΥΣΙΚΟ 500ML'));
    await page.getByRole('button', { name: /Παραλαβή 2 γραμμών/ }).click();
    await page.getByText('Το τιμολόγιο παρελήφθη').waitFor();
    assert.deepEqual([(await stockOf(ids.water)).quantity, (await stockOf(ids.cola)).quantity], [48, 36]);
    assert.equal((await stockOf(ids.water)).barcode, '0520000000123');
  });
});

describe('Excel stock file: SKU | Barcode Number | Quantity | Purchase Price | Selling Price', () => {
  it('a file without a header row is read by position; spaces, leading zeros and empty prices kept', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.getColumn(1).numFmt = '@';
    ws.getColumn(2).numFmt = '@';
    ws.addRow(['ΧΑΡΤΙ  A4 80G', '0012345678905', 10, '3,90', null]);
    ws.addRow(['cola-330', null, 5, null, 0.9]);
    const file = path.join(dir, 'stock.xlsx');
    await wb.xlsx.writeFile(file);

    await page.goto(`${BASE}/import-export`);
    await page.locator('input[type=file][accept=".xlsx,.xls,.csv"]').setInputFiles(file);
    await page.getByRole('button', { name: 'Έλεγχος 2 γραμμών' }).waitFor();
    const mapped = await page.locator('tbody select').evaluateAll((els) => els.map((e) => e.value));
    assert.deepEqual(mapped, ['sku', 'barcode', 'quantity', 'purchasePrice', 'sellingPrice']);
    await page.getByLabel('Στήλη ποσότητας για υπάρχοντα προϊόντα', { exact: false }).selectOption('add').catch(async () => {
      await page.locator('select').filter({ has: page.locator('option[value=add]') }).selectOption('add');
    });
    await page.getByRole('radio', { name: 'Ενημέρωση υπάρχοντος', exact: true }).click();
    await page.getByRole('button', { name: 'Έλεγχος 2 γραμμών' }).click();
    await page.getByRole('button', { name: 'Εισαγωγή 2 έγκυρων γραμμών' }).click();
    await page.getByText('Η εισαγωγή ολοκληρώθηκε').waitFor();

    const paper = (await api('GET', '/products?q=ΧΑΡΤΙ  A4 80G')).body.data[0];
    assert.deepEqual(
      { sku: paper.sku, name: paper.name, barcode: paper.barcode, quantity: paper.quantity, purchasePrice: paper.purchasePrice, sellingPrice: paper.sellingPrice },
      { sku: 'ΧΑΡΤΙ  A4 80G', name: 'ΧΑΡΤΙ  A4 80G', barcode: '0012345678905', quantity: 10, purchasePrice: 3.9, sellingPrice: null },
    );
    const cola = await stockOf(ids.cola);
    assert.deepEqual([cola.sku, cola.quantity, cola.sellingPrice, cola.purchasePrice], ['COLA-330', 41, 0.9, 0.33]);
  });
});
