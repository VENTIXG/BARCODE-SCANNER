/**
 * Stock receipts (Stock IN / goods receiving) and stock dispatches (Stock OUT).
 * Both are multi-line documents; confirming one posts a ledger transaction per
 * line inside a single database transaction (all-or-nothing).
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb, getDefaultWarehouseId, nowIso } from '../db/index.js';
import { actorOf, requirePermission } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { escapeLike, idParam, num, optText, pagination, str } from '../lib/http.js';
import { nextDocumentNumber, peekDocumentNumber } from '../lib/numbering.js';
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

const receiptBody = z.object({
  supplierId: z.number().int().positive().nullish(),
  invoiceNumber: optText(100),
  date: dateStr,
  notes: optText(2000),
  updatePurchasePrices: z.boolean().optional(),
  items: z.array(itemSchema).min(1, 'Add at least one product').max(2000),
});

const dispatchBody = z.object({
  customerName: optText(200),
  reference: optText(100),
  date: dateStr,
  notes: optText(2000),
  /** Explicitly accept negative stock (only honoured when enabled in Settings). */
  force: z.boolean().optional(),
  items: z.array(itemSchema).min(1, 'Add at least one product').max(2000),
});

type Kind = 'receipt' | 'dispatch';

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

function loadDocument(kind: Kind, id: number) {
  const db = getDb();
  const m = META[kind];
  const doc = db
    .prepare(
      `SELECT d.*, d.${m.numberCol} AS number, d.${m.dateCol} AS date, u.username AS created_by_username,
              u.full_name AS created_by_name ${kind === 'receipt' ? ', s.name AS supplier_name' : ''}
       FROM ${m.table} d
       LEFT JOIN users u ON u.id = d.created_by
       ${kind === 'receipt' ? 'LEFT JOIN suppliers s ON s.id = d.supplier_id' : ''}
       WHERE d.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!doc) return undefined;
  const items = db
    .prepare(
      `SELECT it.id, it.product_id, it.quantity, it.${m.priceCol} AS unit_price, it.notes,
              p.sku, p.barcode, p.name, p.unit
       FROM ${m.itemsTable} it JOIN products p ON p.id = it.product_id
       WHERE it.${m.fk} = ? ORDER BY it.id`,
    )
    .all(id);
  return { ...doc, items };
}

export function makeDocumentRouter(kind: Kind) {
  const m = META[kind];
  const router = Router();

  router.get('/next-number', (_req, res) => {
    res.json({ data: peekDocumentNumber(getDb(), m.prefix) });
  });

  router.get('/', (req, res) => {
    const db = getDb();
    const { page, pageSize, offset } = pagination(req.query);
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    const q = str(req.query.q);
    if (q) {
      params.like = `%${escapeLike(q)}%`;
      where.push(
        kind === 'receipt'
          ? `(d.receipt_number LIKE @like ESCAPE '\\' OR d.invoice_number LIKE @like ESCAPE '\\' OR s.name LIKE @like ESCAPE '\\' OR d.notes LIKE @like ESCAPE '\\')`
          : `(d.dispatch_number LIKE @like ESCAPE '\\' OR d.customer_name LIKE @like ESCAPE '\\' OR d.reference LIKE @like ESCAPE '\\' OR d.notes LIKE @like ESCAPE '\\')`,
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
    const total = db.prepare(`SELECT COUNT(*) FROM ${m.table} d ${joins} ${w}`).pluck().get(params);
    const rows = db
      .prepare(
        `SELECT d.*, d.${m.numberCol} AS number, d.${m.dateCol} AS date, u.username AS created_by_username,
                (SELECT COUNT(*) FROM ${m.itemsTable} it WHERE it.${m.fk} = d.id) AS item_count
                ${kind === 'receipt' ? ', s.name AS supplier_name' : ''}
         FROM ${m.table} d ${joins} ${w}
         ORDER BY d.${m.dateCol} DESC, d.id DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset });
    res.json({ data: rows, total, page, pageSize });
  });

  router.get('/:id', (req, res) => {
    const doc = loadDocument(kind, idParam(req.params.id));
    if (!doc) throw notFound(`${m.label} not found`);
    res.json({ data: doc });
  });

  /** Create and confirm in one step: stock is updated immediately. */
  router.post('/', requirePermission(m.permission), (req, res) => {
    const db = getDb();
    const actor = actorOf(req);
    const warehouseId = getDefaultWarehouseId(db);
    const body = kind === 'receipt' ? receiptBody.parse(req.body) : dispatchBody.parse(req.body);

    const id = db.transaction(() => {
      // Validate products (and stock for dispatches) before writing anything.
      const totals = new Map<number, number>();
      for (const it of body.items) totals.set(it.productId, round3((totals.get(it.productId) ?? 0) + it.quantity));
      const products = new Map([...totals.keys()].map((pid) => [pid, getProductRef(db, pid)]));

      if (kind === 'receipt') {
        const inactive = [...products.values()].filter((p) => p.status === 'INACTIVE');
        if (inactive.length)
          throw badRequest(`Inactive products cannot be received: ${inactive.map((p) => p.sku).join(', ')}`);
      } else {
        const short = [...totals.entries()]
          .map(([pid, requested]) => ({ pid, requested, available: getQuantity(db, pid, warehouseId) }))
          .filter((x) => x.requested > x.available)
          .map((x) => ({
            productId: x.pid,
            sku: products.get(x.pid)!.sku,
            name: products.get(x.pid)!.name,
            available: x.available,
            requested: x.requested,
          }));
        const force = (body as z.infer<typeof dispatchBody>).force && negativeStockAllowed(db);
        if (short.length && !force) throw new InsufficientStockError(short);
      }

      const number = nextDocumentNumber(db, m.prefix, new Date(`${body.date}T12:00:00`));
      const totalQty = round3(body.items.reduce((s, it) => s + it.quantity, 0));
      const totalValue = round3(body.items.reduce((s, it) => s + it.quantity * (it.unitPrice ?? 0), 0));
      let docId: number;
      let reference: string;
      if (kind === 'receipt') {
        const b = body as z.infer<typeof receiptBody>;
        if (b.supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(b.supplierId))
          throw badRequest('Supplier not found');
        docId = Number(
          db
            .prepare(
              `INSERT INTO stock_receipts (receipt_number, warehouse_id, supplier_id, invoice_number, receipt_date,
                 status, notes, total_quantity, total_value, created_by, confirmed_at)
               VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?)`,
            )
            .run(number, warehouseId, b.supplierId ?? null, b.invoiceNumber, b.date, b.notes, totalQty, totalValue,
              actor.id, nowIso()).lastInsertRowid,
        );
        reference = b.invoiceNumber ? `${number} / ${b.invoiceNumber}` : number;
      } else {
        const b = body as z.infer<typeof dispatchBody>;
        docId = Number(
          db
            .prepare(
              `INSERT INTO stock_dispatches (dispatch_number, warehouse_id, customer_name, reference, dispatch_date,
                 status, notes, total_quantity, total_value, created_by, confirmed_at)
               VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?)`,
            )
            .run(number, warehouseId, b.customerName, b.reference, b.date, b.notes, totalQty, totalValue, actor.id,
              nowIso()).lastInsertRowid,
        );
        reference = b.reference ? `${number} / ${b.reference}` : number;
      }

      const insertItem = db.prepare(
        `INSERT INTO ${m.itemsTable} (${m.fk}, product_id, quantity, ${m.priceCol}, notes) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const it of body.items) {
        insertItem.run(docId, it.productId, it.quantity, it.unitPrice ?? null, it.notes);
        applyStockChange(db, actor, {
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
          db.prepare('UPDATE products SET purchase_price = ?, updated_at = ? WHERE id = ? AND purchase_price <> ?').run(
            it.unitPrice, nowIso(), it.productId, it.unitPrice);
        }
      }

      const party =
        kind === 'receipt'
          ? (db.prepare('SELECT name FROM suppliers WHERE id = ?').pluck().get((body as z.infer<typeof receiptBody>).supplierId ?? 0) as string | undefined)
          : (body as z.infer<typeof dispatchBody>).customerName;
      audit(db, actor, {
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
    })();

    res.status(201).json({ data: loadDocument(kind, id) });
  });

  /** Cancel a confirmed document: every posted transaction is reversed. */
  router.post('/:id/cancel', requirePermission('transactions.reverse'), (req, res) => {
    const db = getDb();
    const actor = actorOf(req);
    const id = idParam(req.params.id);
    const reason = z.object({ reason: optText(500) }).parse(req.body ?? {}).reason;
    db.transaction(() => {
      const doc = db.prepare(`SELECT id, status, ${m.numberCol} AS number FROM ${m.table} WHERE id = ?`).get(id) as
        | { id: number; status: string; number: string }
        | undefined;
      if (!doc) throw notFound(`${m.label} not found`);
      if (doc.status !== 'CONFIRMED') throw badRequest(`Only confirmed documents can be cancelled`);
      const txs = db
        .prepare(
          `SELECT id FROM inventory_transactions WHERE source_type = ? AND source_id = ? AND reversal_of_id IS NULL
           AND id NOT IN (SELECT reversal_of_id FROM inventory_transactions WHERE reversal_of_id IS NOT NULL)`,
        )
        .pluck()
        .all(m.source, id) as number[];
      for (const txId of txs) reverseTransaction(db, actor, txId, `${m.label} ${doc.number} cancelled`);
      db.prepare(`UPDATE ${m.table} SET status = 'CANCELLED', updated_at = ? WHERE id = ?`).run(nowIso(), id);
      audit(db, actor, {
        action: kind === 'receipt' ? 'RECEIPT.CANCEL' : 'DISPATCH.CANCEL',
        entityType: m.table,
        entityId: id,
        description: `${actor.username} cancelled ${m.label} ${doc.number}${reason ? `: ${reason}` : ''}. ${txs.length} transactions reversed.`,
      });
    })();
    res.json({ data: loadDocument(kind, id) });
  });

  return router;
}
