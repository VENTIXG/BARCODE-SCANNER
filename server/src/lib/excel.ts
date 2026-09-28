import ExcelJS from 'exceljs';
import type { Response } from 'express';

export interface Column {
  header: string;
  key: string;
  width?: number;
  /** Excel number format, e.g. '#,##0.00' or '@' (text). */
  numFmt?: string;
}

const MONEY = '#,##0.00';
const QTY = '#,##0.###';
const DATETIME = 'dd/mm/yyyy hh:mm';
export const FMT = { MONEY, QTY, DATETIME, TEXT: '@', DATE: 'dd/mm/yyyy' };

/** Excel sheet names: max 31 chars, no []:*?/\ and unique within the workbook. */
export function safeSheetName(wb: ExcelJS.Workbook, name: string): string {
  const base = (name || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (wb.getWorksheet(candidate)) candidate = `${base.slice(0, 26)} ${n++}`;
  return candidate;
}

export function addSheet(wb: ExcelJS.Workbook, name: string, columns: Column[], rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(safeSheetName(wb, name), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 4) }));
  for (const r of rows) ws.addRow(r);
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  columns.forEach((c, i) => {
    if (c.numFmt) ws.getColumn(i + 1).numFmt = c.numFmt;
  });
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

export function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Warehouse IMS';
  wb.created = new Date();
  return wb;
}

export async function sendWorkbook(res: Response, wb: ExcelJS.Workbook, baseName: string) {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${baseName}_${date}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  const buf = await wb.xlsx.writeBuffer();
  res.end(Buffer.from(buf));
}

/** ISO string -> JS Date for Excel date cells. */
export const toDate = (iso: unknown) => (typeof iso === 'string' && iso ? new Date(iso) : null);

/**
 * Column layout shared by the import template and the product export, so an
 * exported file can be edited and re-imported directly.
 */
export const PRODUCT_COLUMNS: Column[] = [
  { header: 'SKU', key: 'sku', width: 16, numFmt: '@' },
  { header: 'Barcode', key: 'barcode', width: 18, numFmt: '@' },
  { header: 'Product Name', key: 'name', width: 36 },
  { header: 'Description', key: 'description', width: 36 },
  { header: 'Category', key: 'category', width: 18 },
  { header: 'Supplier', key: 'supplier', width: 22 },
  { header: 'Unit', key: 'unit', width: 8 },
  { header: 'Quantity', key: 'quantity', width: 11, numFmt: QTY },
  { header: 'Minimum Stock', key: 'minStock', width: 15, numFmt: QTY },
  { header: 'Location', key: 'location', width: 12, numFmt: '@' },
  { header: 'Purchase Price', key: 'purchasePrice', width: 15, numFmt: MONEY },
  { header: 'Selling Price', key: 'sellingPrice', width: 14, numFmt: MONEY },
  { header: 'Status', key: 'status', width: 10 },
];
