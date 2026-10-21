/**
 * Test invoices: a supplier invoice as a real PDF (rendered by Chromium, text with embedded
 * fonts, like the PDF of an invoicing program) and as an Excel file.
 */
import ExcelJS from 'exceljs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** lines: [{ code, description, unit, quantity, price, discount, value }] */
export function invoiceHtml({ number, supplier, lines }) {
  const rows = lines
    .map(
      (l) => `<tr><td>${esc(l.code ?? '')}</td><td class="d">${esc(l.description)}</td><td>${esc(l.unit ?? 'ΤΕΜ')}</td>
      <td class="n">${esc(l.quantity)}</td><td class="n">${esc(l.price)}</td><td class="n">${esc(l.discount ?? '0,00')}</td><td class="n">${esc(l.value)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: sans-serif; font-size: 10pt; margin: 24px; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { border-bottom: 1px solid #ccc; padding: 4px 6px; text-align: left; }
    td.n { text-align: right; }
    td.d { white-space: pre; }
  </style></head><body>
    <h2>${esc(supplier)}</h2>
    <div>ΑΦΜ 099999999 · ΔΟΥ Αθηνών</div>
    <div>ΤΙΜΟΛΟΓΙΟ ΠΩΛΗΣΗΣ Α ${esc(number)} · Ημερομηνία 20/10/2026</div>
    <table>
      <thead><tr><th>Κωδικός</th><th>Περιγραφή</th><th>Μ.Μ.</th><th>Ποσότητα</th><th>Τιμή</th><th>Έκπτ.%</th><th>Αξία</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:16px">Σύνολο αξίας: 123,45 · ΦΠΑ 24%: 29,63 · Πληρωτέο: 153,08</div>
  </body></html>`;
}

/** The same invoice as a PDF file (Chromium print). */
export async function invoicePdf(browser, data, file) {
  const page = await browser.newPage();
  await page.setContent(invoiceHtml(data));
  await page.pdf({ path: file, format: 'A4' });
  await page.close();
}

/** An Excel invoice: a few title rows, then Κωδικός | Περιγραφή | Ποσότητα | Τιμή μονάδας | Καθαρή αξία. */
export async function invoiceXlsx({ number, lines }, file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Τιμολόγιο');
  ws.addRow(['ΤΙΜΟΛΟΓΙΟ', number]);
  ws.addRow([]);
  ws.addRow(['Κωδικός', 'Περιγραφή', 'Ποσότητα', 'Τιμή μονάδας', 'Καθαρή αξία']);
  for (const l of lines) ws.addRow([l.code ?? null, l.description, l.quantity, l.price, l.value]);
  ws.addRow([]);
  ws.addRow([null, 'ΣΥΝΟΛΟ', null, null, 99.5]);
  ws.getColumn(1).numFmt = '@';
  await wb.xlsx.writeFile(file);
}
