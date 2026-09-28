import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { actorOf, requirePermission } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { optText } from '../lib/http.js';
import { getProduct, lookupByCode, serializeProduct } from '../lib/products.js';
import { adjustToCount, applyStockChange, getQuantity, round3 } from '../lib/stock.js';

export const stockRouter = Router();

const positiveQty = z.number().positive().max(1_000_000_000);

// ---- Barcode scanner -----------------------------------------------------

const scanBody = z
  .object({
    code: z.string().trim().max(64).optional(),
    productId: z.number().int().positive().optional(),
    mode: z.enum(['IN', 'OUT']),
    quantity: positiveQty.default(1),
    reference: optText(100),
    notes: optText(500),
  })
  .refine((b) => b.code || b.productId, 'code or productId is required');

/**
 * One scan = one stock movement. STOCK IN adds, STOCK OUT removes.
 * When a barcode matches several products (confirmed duplicates) the client
 * is asked to pick one and re-submits with productId.
 */
stockRouter.post('/scan', requirePermission('stock.scan'), (req, res) => {
  const db = getDb();
  const body = scanBody.parse(req.body);
  let productId = body.productId;
  if (!productId) {
    const matches = lookupByCode(db, body.code!);
    if (matches.length === 0)
      throw new HttpError(404, `No product found for code "${body.code}"`, 'PRODUCT_NOT_FOUND', { code: body.code });
    if (matches.length > 1)
      throw new HttpError(409, 'Several products share this barcode — choose one', 'MULTIPLE_MATCHES', {
        products: matches.map(serializeProduct),
      });
    productId = matches[0].id;
  }
  const product = getProduct(db, productId);
  if (!product) throw notFound('Product not found');
  if (product.status === 'INACTIVE' && body.mode === 'IN')
    throw badRequest(`Product ${product.sku} is inactive. Activate it before receiving stock.`, 'PRODUCT_INACTIVE');

  const tx = applyStockChange(db, actorOf(req), {
    productId,
    type: body.mode === 'IN' ? 'STOCK_IN' : 'STOCK_OUT',
    quantity: body.quantity,
    reference: body.reference,
    notes: body.notes ?? 'Barcode scan',
    sourceType: 'SCAN',
  });
  res.status(201).json({ data: { product: serializeProduct(getProduct(db, productId)!), transaction: tx } });
});

// ---- Manual movements & adjustments ------------------------------------

const adjustBody = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('count'),
    productId: z.number().int().positive(),
    countedQuantity: z.number().min(0),
    reason: z.string().trim().min(1, 'Reason is required').max(500),
    reference: optText(100),
  }),
  z.object({
    mode: z.enum(['ADJUSTMENT_PLUS', 'ADJUSTMENT_MINUS', 'RETURN_IN', 'RETURN_OUT']),
    productId: z.number().int().positive(),
    quantity: positiveQty,
    reason: z.string().trim().min(1, 'Reason is required').max(500),
    reference: optText(100),
  }),
]);

stockRouter.post('/adjust', requirePermission('stock.adjust'), (req, res) => {
  const db = getDb();
  const body = adjustBody.parse(req.body);
  const actor = actorOf(req);
  let tx;
  if (body.mode === 'count') {
    tx = adjustToCount(db, actor, {
      productId: body.productId,
      countedQuantity: body.countedQuantity,
      reason: body.reason,
      reference: body.reference,
    });
  } else {
    tx = applyStockChange(db, actor, {
      productId: body.productId,
      type: body.mode,
      quantity: body.quantity,
      notes: body.reason,
      reference: body.reference,
      sourceType: 'ADJUSTMENT',
    });
  }
  const product = getProduct(db, body.productId);
  if (!product) throw notFound('Product not found');
  res.json({ data: { product: serializeProduct(product), transaction: tx ?? null } });
});

/** Stock take: submit counted quantities for many products at once. */
const countBody = z.object({
  reason: z.string().trim().min(1).max(500),
  reference: optText(100),
  items: z
    .array(z.object({ productId: z.number().int().positive(), countedQuantity: z.number().min(0) }))
    .min(1)
    .max(5000),
});

stockRouter.post('/count', requirePermission('stock.adjust'), (req, res) => {
  const db = getDb();
  const body = countBody.parse(req.body);
  const actor = actorOf(req);
  const result = db.transaction(() => {
    let adjusted = 0;
    let unchanged = 0;
    let netChange = 0;
    for (const item of body.items) {
      const before = getQuantity(db, item.productId);
      const tx = adjustToCount(db, actor, { ...item, reason: body.reason, reference: body.reference });
      if (tx) {
        adjusted++;
        netChange += round3(item.countedQuantity - before);
      } else unchanged++;
    }
    audit(db, actor, {
      action: 'INVENTORY.COUNT',
      entityType: 'inventory',
      description: `${actor.username} completed a stock count of ${body.items.length} products (${adjusted} adjusted, ${unchanged} unchanged)${body.reference ? `, ref ${body.reference}` : ''}.`,
      newValue: { adjusted, unchanged, netChange: round3(netChange) },
    });
    return { adjusted, unchanged, netChange: round3(netChange) };
  })();
  res.json({ data: result });
});
