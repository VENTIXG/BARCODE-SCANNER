/**
 * Stock ledger service.
 *
 * This is the ONLY place where `inventory.quantity` is modified. Every change
 * writes an immutable row to `inventory_transactions` (previous quantity,
 * signed change, new quantity, user, reference, notes) and an audit log entry,
 * inside a single database transaction.
 */
import { getDefaultWarehouseId, getSetting, type DB } from '../db/index.js';
import { audit, type Actor } from './audit.js';
import { HttpError, badRequest, notFound } from './errors.js';

export const TX_TYPES = [
  'STOCK_IN',
  'STOCK_OUT',
  'ADJUSTMENT_PLUS',
  'ADJUSTMENT_MINUS',
  'RETURN_IN',
  'RETURN_OUT',
  'INITIAL_STOCK',
] as const;
export type TxType = (typeof TX_TYPES)[number];

export type SourceType = 'RECEIPT' | 'DISPATCH' | 'SCAN' | 'ADJUSTMENT' | 'IMPORT' | 'PRODUCT' | 'REVERSAL' | 'MANUAL';

const INBOUND: ReadonlySet<TxType> = new Set(['STOCK_IN', 'ADJUSTMENT_PLUS', 'RETURN_IN', 'INITIAL_STOCK']);

export const isInbound = (type: TxType) => INBOUND.has(type);

/** Avoid floating point drift on decimal units (kg, m, lt). */
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface StockChangeInput {
  productId: number;
  warehouseId?: number;
  type: TxType;
  /** Positive magnitude; the sign is derived from the transaction type. */
  quantity: number;
  reference?: string | null;
  notes?: string | null;
  sourceType: SourceType;
  sourceId?: number | null;
  unitCost?: number | null;
  reversalOfId?: number | null;
  /** Caller explicitly accepts going below zero (only honoured if enabled in settings). */
  allowNegative?: boolean;
}

export interface TransactionRow {
  id: number;
  product_id: number;
  warehouse_id: number;
  type: TxType;
  quantity_before: number;
  quantity_change: number;
  quantity_after: number;
  unit_cost: number | null;
  reference: string | null;
  notes: string | null;
  source_type: SourceType;
  source_id: number | null;
  reversal_of_id: number | null;
  user_id: number | null;
  created_at: string;
}

interface ProductRef {
  id: number;
  sku: string;
  name: string;
  unit: string;
  status: string;
}

export class InsufficientStockError extends HttpError {
  constructor(items: { productId: number; sku: string; name: string; available: number; requested: number }[]) {
    const first = items[0];
    super(
      409,
      items.length === 1
        ? `Insufficient stock for ${first.sku} (${first.name}): available ${first.available}, requested ${first.requested}`
        : `Insufficient stock for ${items.length} products`,
      'INSUFFICIENT_STOCK',
      { items },
    );
  }
}

export function negativeStockAllowed(db: DB) {
  return getSetting('allow_negative_stock', db) === 'true';
}

export function getProductRef(db: DB, productId: number): ProductRef {
  const p = db.prepare('SELECT id, sku, name, unit, status FROM products WHERE id = ?').get(productId) as
    | ProductRef
    | undefined;
  if (!p) throw notFound(`Product #${productId} not found`);
  return p;
}

/** Current quantity of a product in a warehouse (0 if never stocked). */
export function getQuantity(db: DB, productId: number, warehouseId = getDefaultWarehouseId(db)): number {
  const q = db
    .prepare('SELECT quantity FROM inventory WHERE product_id = ? AND warehouse_id = ?')
    .pluck()
    .get(productId, warehouseId) as number | undefined;
  return q ?? 0;
}

export function ensureInventoryRow(db: DB, productId: number, warehouseId: number) {
  db.prepare('INSERT OR IGNORE INTO inventory (product_id, warehouse_id, quantity) VALUES (?, ?, 0)').run(
    productId,
    warehouseId,
  );
}

export function setProductLocation(db: DB, productId: number, warehouseId: number, locationId: number | null) {
  ensureInventoryRow(db, productId, warehouseId);
  db.prepare(
    `UPDATE inventory SET location_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE product_id = ? AND warehouse_id = ?`,
  ).run(locationId, productId, warehouseId);
}

const fmtQty = (n: number) => String(round3(n));

function describe(actor: Actor | null, p: ProductRef, tx: TransactionRow): string {
  const who = actor?.username ?? 'system';
  const qty = fmtQty(Math.abs(tx.quantity_change));
  const unit = p.unit === 'pcs' ? 'units' : p.unit;
  const ref = tx.reference ? ` (ref: ${tx.reference})` : '';
  switch (tx.type) {
    case 'STOCK_IN':
      return `${who} added ${qty} ${unit} to ${p.sku}${ref}. Stock ${fmtQty(tx.quantity_before)} → ${fmtQty(tx.quantity_after)}.`;
    case 'STOCK_OUT':
      return `${who} removed ${qty} ${unit} from ${p.sku}${ref}. Stock ${fmtQty(tx.quantity_before)} → ${fmtQty(tx.quantity_after)}.`;
    case 'RETURN_IN':
      return `${who} received a return of ${qty} ${unit} of ${p.sku}${ref}.`;
    case 'RETURN_OUT':
      return `${who} returned ${qty} ${unit} of ${p.sku} to supplier${ref}.`;
    case 'INITIAL_STOCK':
      return `${who} set initial stock of ${p.sku} to ${fmtQty(tx.quantity_after)} ${unit}.`;
    default:
      return `${who} adjusted stock of ${p.sku} from ${fmtQty(tx.quantity_before)} to ${fmtQty(tx.quantity_after)} (${tx.quantity_change > 0 ? '+' : ''}${fmtQty(tx.quantity_change)})${tx.notes ? `: ${tx.notes}` : ''}.`;
  }
}

/**
 * Apply one stock movement. Safe to call inside an outer db.transaction()
 * (better-sqlite3 turns nested transactions into savepoints).
 */
export function applyStockChange(db: DB, actor: Actor | null, input: StockChangeInput): TransactionRow {
  if (!TX_TYPES.includes(input.type)) throw badRequest(`Invalid transaction type ${input.type}`);
  const magnitude = round3(Number(input.quantity));
  if (!Number.isFinite(magnitude) || magnitude <= 0) throw badRequest('Quantity must be greater than zero');

  return db.transaction(() => {
    const product = getProductRef(db, input.productId);
    const warehouseId = input.warehouseId ?? getDefaultWarehouseId(db);
    ensureInventoryRow(db, product.id, warehouseId);

    const before = getQuantity(db, product.id, warehouseId);
    const change = isInbound(input.type) ? magnitude : -magnitude;
    const after = round3(before + change);

    if (after < 0 && !(input.allowNegative && negativeStockAllowed(db))) {
      throw new InsufficientStockError([
        { productId: product.id, sku: product.sku, name: product.name, available: before, requested: magnitude },
      ]);
    }

    db.prepare(
      `UPDATE inventory SET quantity = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE product_id = ? AND warehouse_id = ?`,
    ).run(after, product.id, warehouseId);

    const info = db
      .prepare(
        `INSERT INTO inventory_transactions
          (product_id, warehouse_id, type, quantity_before, quantity_change, quantity_after, unit_cost,
           reference, notes, source_type, source_id, reversal_of_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        product.id,
        warehouseId,
        input.type,
        before,
        change,
        after,
        input.unitCost ?? null,
        input.reference?.trim() || null,
        input.notes?.trim() || null,
        input.sourceType,
        input.sourceId ?? null,
        input.reversalOfId ?? null,
        actor?.id ?? null,
      );
    const tx = db
      .prepare('SELECT * FROM inventory_transactions WHERE id = ?')
      .get(info.lastInsertRowid) as TransactionRow;

    audit(db, actor, {
      action: `STOCK.${input.type}`,
      entityType: 'inventory_transaction',
      entityId: tx.id,
      productId: product.id,
      description: describe(actor, product, tx),
      oldValue: { quantity: before },
      newValue: { quantity: after },
    });
    return tx;
  })();
}

/**
 * Inventory adjustment to a physically counted quantity.
 * Returns null when the count equals the system quantity.
 */
export function adjustToCount(
  db: DB,
  actor: Actor,
  input: { productId: number; warehouseId?: number; countedQuantity: number; reason: string; reference?: string | null },
): TransactionRow | null {
  const counted = round3(input.countedQuantity);
  if (!Number.isFinite(counted) || counted < 0) throw badRequest('Counted quantity must be zero or greater');
  if (!input.reason?.trim()) throw badRequest('A reason is required for inventory adjustments');
  const warehouseId = input.warehouseId ?? getDefaultWarehouseId(db);
  const current = getQuantity(db, input.productId, warehouseId);
  const delta = round3(counted - current);
  if (delta === 0) return null;
  return applyStockChange(db, actor, {
    productId: input.productId,
    warehouseId,
    type: delta > 0 ? 'ADJUSTMENT_PLUS' : 'ADJUSTMENT_MINUS',
    quantity: Math.abs(delta),
    reference: input.reference ?? null,
    notes: input.reason,
    sourceType: 'ADJUSTMENT',
    // An adjustment to a physical count may correct an erroneous negative balance.
    allowNegative: true,
  });
}

/**
 * Reverse a transaction by posting an opposite adjustment. The original row is
 * never modified, so the audit trail stays intact.
 */
export function reverseTransaction(db: DB, actor: Actor, transactionId: number, reason?: string): TransactionRow {
  return db.transaction(() => {
    const original = db.prepare('SELECT * FROM inventory_transactions WHERE id = ?').get(transactionId) as
      | TransactionRow
      | undefined;
    if (!original) throw notFound('Transaction not found');
    if (original.reversal_of_id) throw badRequest('A reversal cannot itself be reversed');
    const already = db.prepare('SELECT id FROM inventory_transactions WHERE reversal_of_id = ?').get(transactionId);
    if (already) throw badRequest('This transaction has already been reversed');

    return applyStockChange(db, actor, {
      productId: original.product_id,
      warehouseId: original.warehouse_id,
      type: original.quantity_change > 0 ? 'ADJUSTMENT_MINUS' : 'ADJUSTMENT_PLUS',
      quantity: Math.abs(original.quantity_change),
      reference: original.reference,
      notes: `Reversal of transaction #${original.id} (${original.type})${reason ? `: ${reason}` : ''}`,
      sourceType: 'REVERSAL',
      sourceId: original.id,
      reversalOfId: original.id,
    });
  })();
}
