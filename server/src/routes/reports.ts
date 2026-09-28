import { Router } from 'express';
import { getDb, getDefaultWarehouseId } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { str, tzModifier, tzOffset } from '../lib/http.js';

export const reportsRouter = Router();

/**
 * Movement report for a period. `from`/`to` are UTC ISO bounds computed by
 * the client from local dates; `tz` groups days in the client's timezone.
 */
reportsRouter.get('/movements', (req, res) => {
  const db = getDb();
  const wh = getDefaultWarehouseId(db);
  const from = str(req.query.from);
  const to = str(req.query.to);
  if (!from || !to) throw badRequest('from and to are required');
  const mod = tzModifier(tzOffset(req.query));
  const range = { from, to, wh };
  const inRange = 't.created_at >= @from AND t.created_at < @to AND t.warehouse_id = @wh';

  const byType = db
    .prepare(
      `SELECT t.type, COUNT(*) AS count, SUM(ABS(t.quantity_change)) AS units,
              SUM(ABS(t.quantity_change) * p.purchase_price) AS value
       FROM inventory_transactions t JOIN products p ON p.id = t.product_id
       WHERE ${inRange} GROUP BY t.type ORDER BY t.type`,
    )
    .all(range);

  const byDay = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', t.created_at, '${mod}') AS day,
              COALESCE(SUM(CASE WHEN t.type = 'STOCK_IN' THEN t.quantity_change END), 0) AS stockIn,
              COALESCE(SUM(CASE WHEN t.type = 'STOCK_OUT' THEN -t.quantity_change END), 0) AS stockOut,
              COALESCE(SUM(CASE WHEN t.type IN ('ADJUSTMENT_PLUS','ADJUSTMENT_MINUS') THEN t.quantity_change END), 0) AS adjustments
       FROM inventory_transactions t WHERE ${inRange} GROUP BY day ORDER BY day`,
    )
    .all(range);

  const topProducts = (type: 'STOCK_IN' | 'STOCK_OUT') =>
    db
      .prepare(
        `SELECT p.id, p.sku, p.name, p.unit, COUNT(*) AS movements, SUM(ABS(t.quantity_change)) AS units,
                SUM(ABS(t.quantity_change) * ${type === 'STOCK_OUT' ? 'p.selling_price' : 'p.purchase_price'}) AS value
         FROM inventory_transactions t JOIN products p ON p.id = t.product_id
         WHERE ${inRange} AND t.type = '${type}'
         GROUP BY p.id ORDER BY units DESC LIMIT 10`,
      )
      .all(range);

  const byUser = db
    .prepare(
      `SELECT COALESCE(u.username, 'system') AS username, u.full_name, COUNT(*) AS movements,
              COALESCE(SUM(CASE WHEN t.quantity_change > 0 THEN t.quantity_change END), 0) AS unitsIn,
              COALESCE(SUM(CASE WHEN t.quantity_change < 0 THEN -t.quantity_change END), 0) AS unitsOut
       FROM inventory_transactions t LEFT JOIN users u ON u.id = t.user_id
       WHERE ${inRange} GROUP BY t.user_id ORDER BY movements DESC`,
    )
    .all(range);

  const adjustments = db
    .prepare(
      `SELECT t.id, t.created_at, t.type, t.quantity_before, t.quantity_change, t.quantity_after, t.notes,
              p.sku, p.name, u.username, t.quantity_change * p.purchase_price AS value
       FROM inventory_transactions t JOIN products p ON p.id = t.product_id LEFT JOIN users u ON u.id = t.user_id
       WHERE ${inRange} AND t.type IN ('ADJUSTMENT_PLUS','ADJUSTMENT_MINUS')
       ORDER BY t.created_at DESC LIMIT 100`,
    )
    .all(range);

  // Products with stock on hand but no outgoing movement in the period.
  const noMovement = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.unit, i.quantity, i.quantity * p.purchase_price AS value,
              (SELECT MAX(created_at) FROM inventory_transactions x WHERE x.product_id = p.id AND x.type = 'STOCK_OUT') AS last_out
       FROM products p JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = @wh
       WHERE p.status = 'ACTIVE' AND i.quantity > 0
         AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.product_id = p.id AND t.type = 'STOCK_OUT' AND ${inRange})
       ORDER BY value DESC LIMIT 15`,
    )
    .all(range);

  res.json({
    data: { byType, byDay, topOut: topProducts('STOCK_OUT'), topIn: topProducts('STOCK_IN'), byUser, adjustments, noMovement },
  });
});

/** Current stock valuation grouped by category, supplier or zone. */
reportsRouter.get('/valuation', (req, res) => {
  const db = getDb();
  const wh = getDefaultWarehouseId(db);
  const group = str(req.query.groupBy) ?? 'category';
  const expr =
    group === 'supplier'
      ? { key: "COALESCE(s.name, '—')", join: 'LEFT JOIN suppliers s ON s.id = p.supplier_id' }
      : group === 'zone'
        ? { key: "COALESCE(l.zone, '—')", join: 'LEFT JOIN warehouse_locations l ON l.id = i.location_id' }
        : { key: "COALESCE(c.name, '—')", join: 'LEFT JOIN categories c ON c.id = p.category_id' };
  const rows = db
    .prepare(
      `SELECT ${expr.key} AS name, COUNT(p.id) AS products,
              COALESCE(SUM(MAX(COALESCE(i.quantity,0),0)), 0) AS units,
              COALESCE(SUM(MAX(COALESCE(i.quantity,0),0) * p.purchase_price), 0) AS costValue,
              COALESCE(SUM(MAX(COALESCE(i.quantity,0),0) * p.selling_price), 0) AS retailValue,
              SUM(COALESCE(i.quantity,0) <= p.min_stock) AS alerts
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
       ${expr.join}
       WHERE p.status = 'ACTIVE'
       GROUP BY name ORDER BY costValue DESC`,
    )
    .all(wh);
  res.json({ data: rows });
});
