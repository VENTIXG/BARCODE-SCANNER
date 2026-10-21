/**
 * Stock receipts (Stock IN / goods receiving) and stock dispatches (Stock OUT).
 * Both are multi-line documents; confirming one posts a ledger transaction per
 * line inside a single database transaction (all-or-nothing).
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb, getDefaultWarehouseId, nowIso, type DB } from '../db/index.js';
import { actorOf, requirePermission } from '../middleware/auth.js';
import { audit, type Actor } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { escapeLike, idParam, num, optText, pagination, str } from '../lib/http.js';
import { nextDocumentNumber, peekDocumentNumber } from '../lib/numbering.js';
import { idempotencyKeySchema, runIdempotent } from '../lib/idempotency.js';
import {
  InsufficientStockError,
  applyStockChange,
  getProductRef,
  getQuantity,
  negativeStockAllowed,
  reverseTransaction,
  round3,
} from '../lib/stock.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().positive().max(1_000_000_000),
  unitPrice: z.number().min(0).nullish(),
  notes: optText(500),
});

/** A receipt line from a supplier invoice also keeps the invoice's own text for it. */
export interface ReceiptItemInput extends z.infer<typeof itemSchema> {
  invoiceDescription?: string | null;
  supplierCode?: string | null;
}

export const receiptBody = z.object({
  idempotencyKey: idempotencyKeySchema,
  supplierId: z.number().int().positive().nullish(),
  invoiceNumber: optText(100),
  date: dateStr,
  notes: optText(2000),
  updatePurchasePrices: z.boolean().optional(),
  items: z.array(itemSchema).min(1, 'Add at least one product').max(2000),
});

const dispatchBody = z.object({
  idempotencyKey: idempotencyKeySchema,
  customerName: optText(200),
  reference: optText(100),
  date: dateStr,
  notes: optText(2000),
  /** Explicitly accept negative stock (only honoured when enabled in Settings). */
  force: z.boolean().optional(),
  items: z.array(itemSchema).min(1, 'Add at least one product').max(2000),
});

type Kind = 'receipt' | 'dispatch';
type ReceiptBody = Omit<z.infer<typeof receiptBody>, 'items'> & { items: ReceiptItemInput[] };
type DispatchBody = z.infer<typeof dispatchBody>;

const META = {
  receipt: {
    table: 'stock_receipts',
    itemsTable: 'stock_receipt_items',
    fk: 'receipt_id',
    numberCol: 'receipt_number',
    dateCol: 'receipt_date',
    priceCol: 'unit_cost',
    prefix: 'RCV' as const,
    source: 'RECEIPT' as const,
    permission: 'stock.in' as const,
    label: 'receipt',
  },
  dispatch: {
    table: 'stock_dispatches',
    itemsTable: 'stock_dispatch_items',
    fk: 'dispatch_id',
    numberCol: 'dispatch_number',
    dateCol: 'dispatch_date',
    priceCol: 'unit_price',
    prefix: 'DSP' as const,
    source: 'DISPATCH' as const,
    permission: 'stock.out' as const,
    label: 'dispatch',
  },
};

export async function loadDocument(kind: Kind, id: number) {
  const db = getDb();
  const m = META[kind];
  const doc = await db.get(
    `SELECT d.*, d.${m.numberCol} AS number, d.${m.dateCol} AS date, u.username AS created_by_username,
            u.full_name AS created_by_name ${kind === 'receipt' ? ', s.name AS supplier_name' : ''}
     FROM ${m.table} d
     LEFT JOIN users u ON u.id = d.created_by
     ${kind === 'receipt' ? 'LEFT JOIN suppliers s ON s.id = d.supplier_id' : ''}
     WHERE d.id = ?`,
    id,
  );
  if (!doc) return undefined;
  const items = await db.all(
    `SELECT it.id, it.product_id, it.quantity, it.${m.priceCol} AS unit_price, it.notes,
            ${kind === 'receipt' ? 'it.invoice_description, it.supplier_code,' : ''}
            p.sku, p.barcode, p.name, p.unit
     FROM ${m.itemsTable} it JOIN products p ON p.id = it.product_id
     WHERE it.${m.fk} = ? ORDER BY it.id`,
    id,
  );
  return { ...doc, items };
}

/**
 * Post a receipt or dispatch: check products and stock, number it, write its lines and one
 * ledger transaction per line. Must run inside a transaction (the router's runIdempotent, or
 * the invoice import); returns the document id.
 */
export async function postDocument(db: DB, actor: Actor, kind: Kind, body: ReceiptBody | DispatchBody): Promise<number> {
  const m = META[kind];
  const warehouseId = await getDefaultWarehouseId(db);
  // Validate products (and stock for dispatches) before writing anything.
  const totals = new Map<number, number>();
  for (const it of body.items) totals.set(it.productId, round3((totals.get(it.productId) ?? 0) + it.quantity));
  const products = new Map<number, Awaited<ReturnType<typeof getProductRef>>>();
  for (const pid of totals.keys()) products.set(pid, await getProductRef(db, pid));

  if (kind === 'receipt') {
    const inactive = [...products.values()].filter((p) => p.status === 'INACTIVE');
    if (inactive.length)
      throw badRequest(`Inactive products cannot be received: ${inactive.map((p) => p.sku).join(', ')}`);
  } else {
    const short = [];
    for (const [pid, requested] of totals) {
      const available = await getQuantity(db, pid, warehouseId);
      if (requested > available)
        short.push({ productId: pid, sku: products.get(pid)!.sku, name: products.get(pid)!.name, available, requested });
    }
    const force = (body as z.infer<typeof dispatchBody>).force && (await negativeStockAllowed(db));
    if (short.length && !force) throw new InsufficientStockError(short);
  }

  const number = await nextDocumentNumber(db, m.prefix, new Date(`${body.date}T12:00:00`));
  const totalQty = round3(body.items.reduce((s, it) => s + it.quantity, 0));
  const totalValue = round3(body.items.reduce((s, it) => s + it.quantity * (it.unitPrice ?? 0), 0));
  let docId: number;
  let reference: string;
  if (kind === 'receipt') {
    const b = body as z.infer<typeof receiptBody>;
    if (b.supplierId && !(await db.get('SELECT 1 FROM suppliers WHERE id = ?', b.supplierId)))
      throw badRequest('Supplier not found');
    docId = (
      await db.run(
        `INSERT INTO stock_receipts (receipt_number, warehouse_id, supplier_id, invoice_number, receipt_date,
           status, notes, total_quantity, total_value, created_by, confirmed_at)
         VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?) RETURNING id`,
        number, warehouseId, b.supplierId ?? null, b.invoiceNumber, b.date, b.notes, totalQty, totalValue,
        actor.id, nowIso(),
      )
    ).rows[0].id;
    reference = b.invoiceNumber ? `${number} / ${b.invoiceNumber}` : number;
  } else {
    const b = body as z.infer<typeof dispatchBody>;
    docId = (
      await db.run(
        `INSERT INTO stock_dispatches (dispatch_number, warehouse_id, customer_name, reference, dispatch_date,
           status, notes, total_quantity, total_value, created_by, confirmed_at)
         VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?) RETURNING id`,
        number, warehouseId, b.customerName, b.reference, b.date, b.notes, totalQty, totalValue, actor.id,
        nowIso(),
      )
    ).rows[0].id;
    reference = b.reference ? `${number} / ${b.reference}` : number;
  }

  for (const it of body.items) {
    if (kind === 'receipt') {
      const r = it as ReceiptItemInput;
      await db.run(
        `INSERT INTO stock_receipt_items (receipt_id, product_id, quantity, unit_cost, notes, invoice_description, supplier_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        docId, r.productId, r.quantity, r.unitPrice ?? null, r.notes, r.invoiceDescription ?? null, r.supplierCode ?? null,
      );
    } else {
      await db.run(
        'INSERT INTO stock_dispatch_items (dispatch_id, product_id, quantity, unit_price, notes) VALUES (?, ?, ?, ?, ?)',
        docId, it.productId, it.quantity, it.unitPrice ?? null, it.notes,
      );
    }
    await applyStockChange(db, actor, {
      productId: it.productId,
      warehouseId,
      type: kind === 'receipt' ? 'STOCK_IN' : 'STOCK_OUT',
      quantity: it.quantity,
      unitCost: kind === 'receipt' ? (it.unitPrice ?? null) : null,
      reference,
      notes: it.notes,
      sourceType: m.source,
      sourceId: docId,
      allowNegative: kind === 'dispatch' && (body as z.infer<typeof dispatchBody>).force,
    });
    if (kind === 'receipt' && (body as z.infer<typeof receiptBody>).updatePurchasePrices && it.unitPrice != null) {
      await db.run(
        'UPDATE products SET purchase_price = ?, updated_at = ? WHERE id = ? AND purchase_price IS DISTINCT FROM ?',
        it.unitPrice, nowIso(), it.productId, it.unitPrice,
      );
    }
  }

  const party =
    kind === 'receipt'
      ? await db.value<string>('SELECT name FROM suppliers WHERE id = ?', (body as z.infer<typeof receiptBody>).supplierId ?? 0)
      : (body as z.infer<typeof dispatchBody>).customerName;
  await audit(db, actor, {
    action: kind === 'receipt' ? 'RECEIPT.CONFIRM' : 'DISPATCH.CONFIRM',
    entityType: m.table,
    entityId: docId,
    description:
      kind === 'receipt'
        ? `${actor.username} confirmed receipt ${number}${party ? ` from ${party}` : ''}: ${body.items.length} lines, ${totalQty} units.`
        : `${actor.username} confirmed dispatch ${number}${party ? ` to ${party}` : ''}: ${body.items.length} lines, ${totalQty} units.`,
    newValue: { number, items: body.items.length, totalQuantity: totalQty },
  });
  return docId;
}

export function makeDocumentRouter(kind: Kind) {
  const m = META[kind];
  const router = Router();

  router.get('/next-number', async (_req, res) => {
    res.json({ data: await peekDocumentNumber(getDb(), m.prefix) });
  });

  router.get('/', async (req, res) => {
    const db = getDb();
    const { page, pageSize, offset } = pagination(req.query);
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    const q = str(req.query.q);
    if (q) {
      params.like = `%${escapeLike(q)}%`;
      where.push(
        kind === 'receipt'
          ? `(d.receipt_number ILIKE @like OR d.invoice_number ILIKE @like OR s.name ILIKE @like OR d.notes ILIKE @like)`
          : `(d.dispatch_number ILIKE @like OR d.customer_name ILIKE @like OR d.reference ILIKE @like OR d.notes ILIKE @like)`,
      );
    }
    const from = str(req.query.from);
    const to = str(req.query.to);
    if (from) (where.push(`d.${m.dateCol} >= @from`), (params.from = from));
    if (to) (where.push(`d.${m.dateCol} <= @to`), (params.to = to));
    const status = str(req.query.status);
    if (status) (where.push('d.status = @status'), (params.status = status));
    const supplierId = num(req.query.supplierId);
    if (kind === 'receipt' && supplierId) (where.push('d.supplier_id = @supplierId'), (params.supplierId = supplierId));
    const productId = num(req.query.productId);
    if (productId)
      (where.push(`d.id IN (SELECT ${m.fk} FROM ${m.itemsTable} WHERE product_id = @productId)`),
        (params.productId = productId));

    const joins = `LEFT JOIN users u ON u.id = d.created_by ${
      kind === 'receipt' ? 'LEFT JOIN suppliers s ON s.id = d.supplier_id' : ''
    }`;
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.value<number>(`SELECT COUNT(*) FROM ${m.table} d ${joins} ${w}`, params);
    const rows = await db.all(
      `SELECT d.*, d.${m.numberCol} AS number, d.${m.dateCol} AS date, u.username AS created_by_username,
              (SELECT COUNT(*) FROM ${m.itemsTable} it WHERE it.${m.fk} = d.id) AS item_count
              ${kind === 'receipt' ? ', s.name AS supplier_name' : ''}
       FROM ${m.table} d ${joins} ${w}
       ORDER BY d.${m.dateCol} DESC, d.id DESC LIMIT @limit OFFSET @offset`,
      { ...params, limit: pageSize, offset },
    );
    res.json({ data: rows, total, page, pageSize });
  });

  router.get('/:id', async (req, res) => {
    const doc = await loadDocument(kind, idParam(req.params.id));
    if (!doc) throw notFound(`${m.label} not found`);
    res.json({ data: doc });
  });

  /** Create and confirm in one step: stock is updated immediately. */
  router.post('/', requirePermission(m.permission), async (req, res) => {
    const db = getDb();
    const actor = actorOf(req);
    const body = kind === 'receipt' ? receiptBody.parse(req.body) : dispatchBody.parse(req.body);

    // runIdempotent runs the work in one transaction: the document is posted completely or not at all.
    const out = await runIdempotent(db, actor, body.idempotencyKey, kind, async () => {
      const docId = await postDocument(db, actor, kind, body);
      return { status: 201, body: { data: await loadDocument(kind, docId) } };
    });
    res.status(out.status).json(out.body);
  });

  /** Cancel a confirmed document: every posted transaction is reversed. */
  router.post('/:id/cancel', requirePermission('transactions.reverse'), async (req, res) => {
    const db = getDb();
    const actor = actorOf(req);
    const id = idParam(req.params.id);
    const reason = z.object({ reason: optText(500) }).parse(req.body ?? {}).reason;
    await db.tx(async (t) => {
      const doc = await t.get<{ id: number; status: string; number: string }>(
        `SELECT id, status, ${m.numberCol} AS number FROM ${m.table} WHERE id = ?`,
        id,
      );
      if (!doc) throw notFound(`${m.label} not found`);
      if (doc.status !== 'CONFIRMED') throw badRequest(`Only confirmed documents can be cancelled`);
      const txs = await t.column<number>(
        `SELECT id FROM inventory_transactions WHERE source_type = ? AND source_id = ? AND reversal_of_id IS NULL
         AND id NOT IN (SELECT reversal_of_id FROM inventory_transactions WHERE reversal_of_id IS NOT NULL)
         ORDER BY id`,
        m.source,
        id,
      );
      for (const txId of txs) await reverseTransaction(t, actor, txId, `${m.label} ${doc.number} cancelled`);
      await t.run(`UPDATE ${m.table} SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, nowIso(), id);
      await audit(t, actor, {
        action: kind === 'receipt' ? 'RECEIPT.CANCEL' : 'DISPATCH.CANCEL',
        entityType: m.table,
        entityId: id,
        description: `${actor.username} cancelled ${m.label} ${doc.number}${reason ? `: ${reason}` : ''}. ${txs.length} transactions reversed.`,
      });
    });
    res.json({ data: await loadDocument(kind, id) });
  });

  return router;
}
