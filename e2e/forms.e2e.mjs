/**
 * Typing in forms, the way a person types: one key at a time, with pauses.
 *
 * Regression test for "New user: every letter typed in Username, Email or Password
 * jumped back to Full name". Every dialog and form page is checked the same way.
 *
 *   npm run e2e
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiLogin, launchBrowser, log, testServer, uiLogin, until } from './lib.mjs';

const srv = testServer(Number(process.env.E2E_FORMS_PORT ?? 4712));
const BASE = srv.base;
/** Slower than the dialog's own focus timer (20 ms), like a person typing. */
const KEY_DELAY = 60;

let browser;
let page;
let productId;

before(async () => {
  await srv.start();
  const cookie = await apiLogin(BASE, 'admin', 'admin123');
  const r = await fetch(`${BASE}/api/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ sku: 'FORM-TEE', barcode: '5201111111111', name: 'T-shirt for form test', initialQuantity: 10 }),
  });
  assert.equal(r.status, 201);
  productId = (await r.json()).data.id;
  browser = await launchBrowser();
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await uiLogin(page, BASE, 'admin', 'admin123');
});

after(async () => {
  await browser?.close();
  srv.cleanup();
});

const dialog = () => page.getByRole('dialog').last();

/** What to type into a field so that it is accepted as it is. */
async function sampleFor(field, i) {
  const type = (await field.getAttribute('type')) ?? 'text';
  const mode = await field.getAttribute('inputmode');
  if (['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type)) return null;
  if (type === 'number' || mode === 'decimal' || mode === 'numeric') return '12';
  if (type === 'email') return `qa${i}@test.gr`;
  const max = Number(await field.getAttribute('maxlength')) || Infinity;
  return `Qa${i}x`.slice(0, max);
}

/**
 * Clicks every editable field inside `scope`, types into it key by key and checks that
 * the text landed in that field and the field still has the cursor.
 */
async function typeInEveryField(scope, label) {
  const fields = scope.locator(
    'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])',
  );
  let checked = 0;
  for (let i = 0; i < (await fields.count()); i++) {
    const field = fields.nth(i);
    if (!(await field.isVisible())) continue;
    const text = await sampleFor(field, i);
    if (!text) continue;
    await field.click();
    await field.press('ControlOrMeta+a');
    await field.press('Delete');
    await field.pressSequentially(text, { delay: KEY_DELAY });
    // Give a stray focus change time to happen before checking.
    await page.waitForTimeout(80);
    const value = await field.inputValue();
    const name = (await field.getAttribute('aria-label')) ?? (await field.getAttribute('placeholder')) ?? `field #${i}`;
    assert.equal(value.toLowerCase(), text.toLowerCase(), `${label}: "${name}" should contain what was typed`);
    assert.ok(await field.evaluate((el) => el === document.activeElement), `${label}: "${name}" lost the cursor while typing`);
    checked++;
  }
  assert.ok(checked > 0, `${label}: no fields found`);
  log(`${label}: ${checked} fields OK`);
  return checked;
}

async function openDialog(path, buttonName, setup) {
  await page.goto(`${BASE}${path}`);
  if (setup) await setup();
  await page.getByRole('button', { name: buttonName, exact: true }).first().click();
  await until(async () => (await page.getByRole('dialog').count()) > 0, `dialog ${buttonName} opens`);
  // The dialog moves the cursor to its first field once; wait for that before typing.
  await page.waitForTimeout(100);
}

async function closeDialog() {
  await page.keyboard.press('Escape');
  await until(async () => (await page.getByRole('dialog').count()) === 0, 'dialog closes with Escape');
}

describe('typing in forms, key by key', () => {
  it('New user: every field keeps what is typed, the user is saved and can sign in', async () => {
    await openDialog('/users', 'Νέος χρήστης');
    const d = dialog();
    const values = {
      'Ονοματεπώνυμο': 'Μαρία Παπαδοπούλου',
      'Όνομα χρήστη': 'maria.p',
      Email: 'maria@example.gr',
      'Κωδικός': 'maria-pass-123',
    };
    for (const [label, text] of Object.entries(values)) {
      const field = d.getByLabel(label, { exact: false }).first();
      await field.click();
      await field.pressSequentially(text, { delay: KEY_DELAY });
    }
    await d.getByLabel('Ρόλος', { exact: false }).selectOption('MANAGER');
    for (const [label, text] of Object.entries(values)) {
      assert.equal(await d.getByLabel(label, { exact: false }).first().inputValue(), text, `field ${label}`);
    }
    await d.getByRole('button', { name: 'Αποθήκευση' }).click();
    await until(async () => (await page.getByRole('dialog').count()) === 0, 'dialog closes after save');
    await until(async () => (await page.locator('tbody tr', { hasText: 'maria.p' }).count()) === 1, 'new user listed');

    // The new user signs in on another PC.
    const other = await (await browser.newContext()).newPage();
    await uiLogin(other, BASE, 'maria.p', 'maria-pass-123');
    assert.equal(new URL(other.url()).pathname, '/');
    await other.context().close();
  });

  it('Edit user: changing the e-mail keeps the cursor in the e-mail field', async () => {
    await page.goto(`${BASE}/users`);
    await page.locator('tbody tr', { hasText: 'maria.p' }).getByRole('button', { name: 'Επεξεργασία' }).click();
    const email = dialog().getByLabel('Email').first();
    await email.click();
    await email.press('ControlOrMeta+a');
    await email.pressSequentially('maria.new@example.gr', { delay: KEY_DELAY });
    assert.equal(await email.inputValue(), 'maria.new@example.gr');
    assert.equal(await dialog().getByLabel('Ονοματεπώνυμο').first().inputValue(), 'Μαρία Παπαδοπούλου');
    await closeDialog();
  });

  for (const [path, button] of [
    ['/users', 'Νέος χρήστης'],
    ['/categories', 'Νέα κατηγορία'],
    ['/suppliers', 'Νέος προμηθευτής'],
    ['/inventory?tab=locations', 'Νέα θέση'],
  ]) {
    it(`dialog "${button}" (${path})`, async () => {
      await openDialog(path, button);
      await typeInEveryField(dialog(), button);
      await closeDialog();
    });
  }

  it('dialogs on the product page: adjust stock, add sizes', async () => {
    await openDialog(`/products/${productId}`, 'Διόρθωση αποθέματος');
    await typeInEveryField(dialog(), 'Adjust stock');
    await closeDialog();
    await openDialog(`/products/${productId}`, 'Προσθήκη μεγεθών');
    // Two sizes first, so the rows with SKU / barcode / opening stock appear.
    const sizes = dialog().locator('input').first();
    await sizes.click();
    await sizes.press('ControlOrMeta+a');
    await sizes.press('Delete');
    await sizes.pressSequentially('S, M', { delay: KEY_DELAY });
    await until(async () => (await dialog().locator('input').count()) >= 7, 'size rows appear');
    const fields = dialog().locator('input');
    for (let i = 1; i < (await fields.count()); i++) {
      const field = fields.nth(i);
      const text = (await field.getAttribute('inputmode')) === 'decimal' ? '3' : `X${i}`;
      await field.click();
      await field.press('ControlOrMeta+a');
      await field.pressSequentially(text, { delay: KEY_DELAY });
      assert.equal(await field.inputValue(), text, `size row field #${i}`);
    }
    assert.equal(await sizes.inputValue(), 'S, M', 'the sizes field kept its text');
    await closeDialog();
  });

  for (const [path, label] of [
    ['/products/new', 'New product page'],
    ['/stock-in', 'Stock in document'],
    ['/stock-out', 'Stock out document'],
    ['/settings', 'Settings page'],
    ['/profile', 'Profile page'],
  ]) {
    it(label, async () => {
      await page.goto(`${BASE}${path}`);
      await page.locator('main input').first().waitFor();
      await page.waitForTimeout(150);
      await typeInEveryField(page.locator('main'), label);
    });
  }
});
