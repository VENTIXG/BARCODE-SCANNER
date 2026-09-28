import type { DB } from '../db/index.js';
import { escapeLike, num, str } from './http.js';
import { TX_TYPES } from './stock.js';

export interface TxFilters {
  from?: string;
  to?: string;
  types?: string[];
  productId?: number;
  userId?: number;
  sourceType?: string;
  q?: string;
}

export function readTxFilters(query: Record<string, unknown>): TxFilters {
  const types = (str(query.type) ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => (TX_TYPES as readonly string[]).includes(t));
  return {
    from: str(query.from),
    to: str(query.to),
    types: types.length ? types : undefined,
    productId: num(query.productId),
    userId: num(query.userId),
    sourceType: str(query.sourceType),
    q: str(query.q),
  };
}

export const TX_SELECT = /* sql */ `
  SELECT t.id, t.product_id, t.warehouse_id, t.type, t.quantity_before, t.quantity_change, t.quantity_after,
         t.unit_cost, t.reference, t.notes, t.source_type, t.source_id, t.reversal_of_id, t.user_id, t.created_at,
         p.sku, p.name AS product_name, p.barcode, p.unit,
         u.username, u.full_name AS user_full_name,
         (SELECT r.id FROM inventory_transactions r WHERE r.reversal_of_id = t.id) AS reversed_by_id
  FROM inventory_transactions t
  JOIN products p ON p.id = t.product_id
  LEFT JOIN users u ON u.id = t.user_id
`;

export function buildTxWhere(f: TxFilters) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.from) (where.push('t.created_at >= @from'), (params.from = f.from));
  if (f.to) (where.push('t.created_at < @to'), (params.to = f.to));
  if (f.types) {
    where.push(`t.type IN (${f.types.map((_, i) => `@type${i}`).join(',')})`);
    f.types.forEach((t, i) => (params[`type${i}`] = t));
  }
  if (f.productId) (where.push('t.product_id = @productId'), (params.productId = f.productId));
  if (f.userId) (where.push('t.user_id = @userId'), (params.userId = f.userId));
  if (f.sourceType) (where.push('t.source_type = @sourceType'), (params.sourceType = f.sourceType));
  if (f.q) {
    params.q = f.q;
    params.like = `%${escapeLike(f.q)}%`;
    where.push(
      `(p.sku = @q OR p.barcode = @q OR p.name LIKE @like ESCAPE '\\' OR p.sku LIKE @like ESCAPE '\\' OR t.reference LIKE @like ESCAPE '\\' OR t.notes LIKE @like ESCAPE '\\')`,
    );
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listTransactions(db: DB, f: TxFilters, limit: number, offset: number) {
  const { where, params } = buildTxWhere(f);
  const total = db
    .prepare(`SELECT COUNT(*) FROM inventory_transactions t JOIN products p ON p.id = t.product_id ${where}`)
    .pluck()
    .get(params) as number;
  const rows = db
    .prepare(`${TX_SELECT} ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });
  return { total, rows };
}
