import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { actorOf } from '../middleware/auth.js';
import { forbidden, notFound } from '../lib/errors.js';
import { idParam, optText, pagination } from '../lib/http.js';
import { can } from '../lib/permissions.js';
import { getProduct, serializeProduct } from '../lib/products.js';
import { reverseTransaction, type TransactionRow } from '../lib/stock.js';
import { listTransactions, readTxFilters } from '../lib/transactions.js';

export const transactionsRouter = Router();

/** Window in which warehouse users may undo their own scans. */
const OWN_SCAN_UNDO_MINUTES = 30;

transactionsRouter.get('/', (req, res) => {
  if (!can(req.user!.role, 'transactions.view')) throw forbidden();
  const { page, pageSize, offset } = pagination(req.query, 50);
  const { total, rows } = listTransactions(getDb(), readTxFilters(req.query), pageSize, offset);
  res.json({ data: rows, total, page, pageSize });
});

/**
 * Reverse a transaction with an opposite adjustment. Managers can reverse any
 * transaction; other users only their own barcode scans from the last 30 minutes
 * (the "Undo" button on the scanner screen).
 */
transactionsRouter.post('/:id/reverse', (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const { reason } = z.object({ reason: optText(500) }).parse(req.body ?? {});
  const tx = db.prepare('SELECT * FROM inventory_transactions WHERE id = ?').get(id) as TransactionRow | undefined;
  if (!tx) throw notFound('Transaction not found');
  const actor = actorOf(req);
  const ownRecentScan =
    tx.user_id === actor.id &&
    tx.source_type === 'SCAN' &&
    Date.now() - Date.parse(tx.created_at) < OWN_SCAN_UNDO_MINUTES * 60_000;
  if (!can(actor.role, 'transactions.reverse') && !ownRecentScan)
    throw forbidden('You can only undo your own scans from the last 30 minutes');
  if (['RECEIPT', 'DISPATCH'].includes(tx.source_type) && tx.source_id)
    throw forbidden('This transaction belongs to a document. Cancel the whole document instead.');
  const reversal = reverseTransaction(db, actor, id, reason ?? undefined);
  res.json({ data: { transaction: reversal, product: serializeProduct(getProduct(db, tx.product_id)!) } });
});
