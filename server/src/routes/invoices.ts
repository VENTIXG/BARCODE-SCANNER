/**
 * Supplier invoice import (Stock In -> From invoice): match the lines of an invoice to
 * products, then post the confirmed invoice as a goods receipt. See lib/invoices.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb, getDefaultWarehouseId, nowIso } from '../db/index.js';
import { actorOf } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { idParam, optText } from '../lib/http.js';
import { idempotencyKeySchema, runIdempotent } from '../lib/idempotency.js';
import {
  findDuplicateInvoice,
  invoiceLineSchema,
  layoutSchema,
  matchInvoiceLines,
  nextAutoSku,
  rememberAlias,
} from '../lib/invoices.js';
import { keysFor } from '../lib/matching.js';
import { can } from '../lib/permissions.js';
import { setProductLocation } from '../lib/stock.js';
import { loadDocument, postDocument, type ReceiptItemInput } from './documents.js';

export const invoicesRouter = Router();

const supplierOf = async (id: number) => {
  const s = await getDb().get<{ id: number; name: string }>('SELECT id, name FROM suppliers WHERE id = ?', id);
  if (!s) throw notFound('Supplier not found');
  return s;
};

/** Column layout of a supplier's invoices (null: not set yet). */
invoicesRouter.get('/layout/:supplierId', async (req, res) => {
  const supplierId = idParam(req.params.supplierId);
  await supplierOf(supplierId);
  const row = await getDb().get<{ layout: string; updated_at: string }>('SELECT layout, updated_at FROM invoice_layouts WHERE supplier_id = ?', supplierId);
  res.json({ data: row ? { ...JSON.parse(row.layout), updatedAt: row.updated_at } : null });
});

invoicesRouter.put('/layout/:supplierId', async (req, res) => {
  const supplierId = idParam(req.params.supplierId);
  await supplierOf(supplierId);
  const layout = layoutSchema.parse(req.body);
  await saveLayout(supplierId, layout, actorOf(req).id);
  res.json({ data: layout });
});

async function saveLayout(supplierId: number, layout: z.infer<typeof layoutSchema>, userId: number, db = getDb()) {
  await db.run(
    `INSERT INTO invoice_layouts (supplier_id, layout, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (supplier_id) DO UPDATE SET layout = excluded.layout, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    supplierId,
    JSON.stringify(layout),
    userId,
    nowIso(),
  );
}

const matchBody = z.object({
  supplierId: z.number().int().positive(),
  invoiceNumber: z.string().trim().max(100).nullish(),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
  lines: z.array(invoiceLineSchema).min(1, 'No product lines were found in the invoice').max(2000),
});

/** Match every line; also tells whether this invoice was imported before. */
invoicesRouter.post('/match', async (req, res) => {
  const db = getDb();
  const body = matchBody.parse(req.body);
  await supplierOf(body.supplierId);
  const lines = await matchInvoiceLines(db, body.supplierId, body.lines);
  const duplicates = await findDuplicateInvoice(db, body.supplierId, body.invoiceNumber, body.fileHash);
  const count = (s: string) => lines.filter((l) => l.status === s).length;
  res.json({
    data: {
      lines,
      duplicates,
      summary: { total: lines.length, matched: count('matched'), review: count('review'), new: count('new'), errors: count('error') },
    },
  });
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const commitBody = z.object({
  idempotencyKey: idempotencyKeySchema,
  supplierId: z.number().int().positive(),
  invoiceNumber: z.string().trim().min(1, 'The invoice number is required').max(100),
  date: dateStr,
  fileName: optText(255),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
  notes: optText(2000),
  updatePurchasePrices: z.boolean().default(false),
  /** The person was warned that this invoice was imported before and wants it again. */
  allowDuplicate: z.boolean().default(false),
  /** Saved for this supplier, so the next invoice needs no column choices. */
  layout: layoutSchema.nullish(),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().min(0),
        description: text(500),
        sku: text(64),
        barcode: text(64),
        quantity: z.number().positive().max(1_000_000_000),
        unitPrice: z.number().min(0).nullish(),
        action: z.enum(['product', 'new', 'skip']),
        productId: z.number().int().positive().nullish(),
        newProduct: z
          .object({
            sku: text(64),
            name: text(200),
            barcode: text(64),
            sellingPrice: z.number().min(0).nullish(),
            unit: text(20),
          })
          .nullish(),
        /** Save the supplier's description / code for this product (default yes). */
        remember: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(2000),
});

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Post the confirmed invoice as a goods receipt (all lines or nothing). */
invoicesRouter.post('/commit', async (req, res) => {
  const db = getDb();
  const actor = actorOf(req);
  const body = commitBody.parse(req.body);
  const supplier = await supplierOf(body.supplierId);
  const used = body.lines.filter((l) => l.action !== 'skip');
  if (!used.length) throw badRequest('Every line is skipped: nothing to receive');
  if (used.some((l) => l.action === 'new') && !can(actor.role, 'products.manage'))
    throw forbidden('Creating new products needs a manager: choose existing products or skip those lines');

  const out = await runIdempotent(db, actor, body.idempotencyKey, 'invoice', async () => {
    if (!body.allowDuplicate) {
      const duplicates = await findDuplicateInvoice(db, body.supplierId, body.invoiceNumber, body.fileHash);
      if (duplicates.length)
        throw new HttpError(
          409,
          `This invoice was already received (${duplicates.map((d) => d.receiptNumber).join(', ')}). Confirm to receive it again.`,
          'DUPLICATE_INVOICE',
          { duplicates },
        );
    }
    const warehouseId = await getDefaultWarehouseId(db);
    const keys = await keysFor(db, used.flatMap((l) => [l.description, l.sku, l.newProduct?.sku, l.newProduct?.name]));
    const keyOf = (v: string | null | undefined) => (v ? (keys.get(v)?.key ?? '') : '');
    const items: ReceiptItemInput[] = [];
    const created: { lineNo: number; id: number; sku: string }[] = [];
    let remembered = 0;

    for (const line of used) {
      const where = `Line ${line.lineNo}`;
      let product: { id: number; sku: string; name: string; status: string };
      if (line.action === 'product') {
        if (!line.productId) throw badRequest(`${where}: choose the product`);
        const p = await db.get<{ id: number; sku: string; name: string; status: string }>(
          'SELECT id, sku::text AS sku, name, status FROM products WHERE id = ?',
          line.productId,
        );
        if (!p) throw badRequest(`${where}: the chosen product no longer exists`);
        product = p;
      } else {
        // A new product, named exactly as on the invoice unless the person changed it.
        const np = line.newProduct ?? { sku: null, name: null, barcode: null, sellingPrice: null, unit: null };
        const name = np.name ?? line.description ?? line.sku;
        if (!name) throw badRequest(`${where}: the new product needs a name`);
        const sku = np.sku ?? line.sku ?? (await nextAutoSku(db));
        if (CONTROL.test(sku) || CONTROL.test(name)) throw badRequest(`${where}: tabs or line breaks in the SKU or name`);
        const taken = await db.get<{ sku: string; name: string }>(
          'SELECT sku::text AS sku, name FROM products WHERE ims_key(sku::text) = ims_key(?)',
          sku,
        );
        if (taken) throw conflict(`${where}: SKU ${sku} is already used by "${taken.name}" (${taken.sku}): choose that product instead`, 'DUPLICATE_SKU');
        const barcode = np.barcode ?? line.barcode;
        if (barcode) {
          const owner = await db.get<{ sku: string }>('SELECT sku::text AS sku FROM products WHERE ims_compact(barcode::text) = ims_compact(?)', barcode);
          if (owner) throw conflict(`${where}: barcode ${barcode} already belongs to ${owner.sku}: choose that product instead`, 'DUPLICATE_BARCODE');
        }
        const id = (await db.value<number>(
          `INSERT INTO products (sku, barcode, name, supplier_id, unit, purchase_price, selling_price, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?) RETURNING id`,
          sku,
          barcode,
          name,
          body.supplierId,
          np.unit ?? 'pcs',
          line.unitPrice ?? 0,
          np.sellingPrice ?? null,
          actor.id,
        ))!;
        await setProductLocation(db, id, warehouseId, null);
        await audit(db, actor, {
          action: 'PRODUCT.CREATE',
          entityType: 'product',
          entityId: id,
          productId: id,
          description: `${actor.username} added new product ${sku} (${name}) from invoice ${body.invoiceNumber} of ${supplier.name}.`,
          newValue: { sku, name, barcode, purchasePrice: line.unitPrice ?? 0, sellingPrice: np.sellingPrice ?? null },
        });
        created.push({ lineNo: line.lineNo, id, sku });
        product = { id, sku, name, status: 'ACTIVE' };
      }
      if (product.status === 'INACTIVE') throw badRequest(`${where}: product ${product.sku} is inactive; activate it first`);

      // Next time this supplier's text finds the product by itself.
      if (line.remember) {
        if (line.description && keyOf(line.description) !== keyOf(product.name)) {
          await rememberAlias(db, { productId: product.id, supplierId: body.supplierId, kind: 'description', value: line.description, userId: actor.id });
          remembered++;
        }
        if (line.sku && !(await db.value<boolean>('SELECT ims_key(?) = ims_key(?)', line.sku, product.sku))) {
          await rememberAlias(db, { productId: product.id, supplierId: body.supplierId, kind: 'code', value: line.sku, userId: actor.id });
          remembered++;
        }
      }
      items.push({
        productId: product.id,
        quantity: line.quantity,
        unitPrice: line.unitPrice ?? null,
        notes: null,
        invoiceDescription: line.description,
        supplierCode: line.sku,
      });
    }

    const receiptId = await postDocument(db, actor, 'receipt', {
      supplierId: body.supplierId,
      invoiceNumber: body.invoiceNumber,
      date: body.date,
      notes: body.notes,
      updatePurchasePrices: body.updatePurchasePrices,
      items,
    });
    await db.run(
      `INSERT INTO invoice_imports (supplier_id, invoice_number, invoice_date, file_name, file_hash, receipt_id, line_count, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      body.supplierId,
      body.invoiceNumber,
      body.date,
      body.fileName,
      body.fileHash ?? null,
      receiptId,
      items.length,
      actor.id,
    );
    if (body.layout) await saveLayout(body.supplierId, body.layout, actor.id, db);
    await audit(db, actor, {
      action: 'INVOICE.IMPORT',
      entityType: 'stock_receipts',
      entityId: receiptId,
      description:
        `${actor.username} received invoice ${body.invoiceNumber} of ${supplier.name}${body.fileName ? ` (${body.fileName})` : ''}: ` +
        `${items.length} lines, ${created.length} new products, ${body.lines.length - used.length} skipped.` +
        (body.allowDuplicate ? ' Received again after the duplicate warning.' : ''),
      newValue: { invoiceNumber: body.invoiceNumber, lines: items.length, created: created.map((c) => c.sku), remembered },
    });
    return {
      status: 201,
      body: { data: { receipt: await loadDocument('receipt', receiptId), created, skipped: body.lines.length - used.length, remembered } },
    };
  });
  res.status(out.status).json(out.body);
});

/** The latest imported invoices. */
invoicesRouter.get('/', async (_req, res) => {
  const rows = await getDb().all(
    `SELECT ii.id, ii.invoice_number, ii.invoice_date, ii.file_name, ii.line_count, ii.created_at,
            s.name AS supplier_name, r.id AS receipt_id, r.receipt_number, r.status AS receipt_status, u.username
     FROM invoice_imports ii
     LEFT JOIN suppliers s ON s.id = ii.supplier_id
     LEFT JOIN stock_receipts r ON r.id = ii.receipt_id
     LEFT JOIN users u ON u.id = ii.created_by
     ORDER BY ii.id DESC LIMIT 30`,
  );
  res.json({ data: rows });
});
