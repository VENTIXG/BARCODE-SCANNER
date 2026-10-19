import { Router } from 'express';
import { getDb, getDefaultWarehouseId } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { str, tzOffset } from '../lib/http.js';

export const reportsRouter = Router();

/**
 * Movement report for a period. `from`/`to` are UTC ISO bounds computed by
 * the client from local dates; `tz` groups days in the client's timezone.
 */
reportsRouter.get('/movements', async (req, res) => {
  const db = getDb();
  const wh = await getDefaultWarehouseId(db);
  const from = str(req.query.from);
  const to = str(req.query.to);
  if (!from || !to) throw badRequest('from and to are required');
  const range = { from, to, wh };
  const inRange = 't.created_at >= @from AND t.created_at < @to AND t.warehouse_id = @wh';

  const byType = await db.all(
    `SELECT t.type, COUNT(*) AS count, SUM(ABS(t.quantity_change)) AS units,
            SUM(ABS(t.quantity_change) * p.purchase_price) AS value
     FROM inventory_transactions t JOIN products p ON p.id = t.product_id
     WHERE ${inRange} GROUP BY t.type ORDER BY t.type`,
    range,
  );

  const byDay = await db.all(
    `SELECT ims_local(t.created_at, @tz, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(CASE WHEN t.type = 'STOCK_IN' THEN t.quantity_change END), 0) AS "stockIn",
            COALESCE(SUM(CASE WHEN t.type = 'STOCK_OUT' THEN -t.quantity_change END), 0) AS "stockOut",
            COALESCE(SUM(CASE WHEN t.type IN ('ADJUSTMENT_PLUS','ADJUSTMENT_MINUS') THEN t.quantity_change END), 0) AS adjustments
     FROM inventory_transactions t WHERE ${inRange} GROUP BY 1 ORDER BY 1`,
    { ...range, tz: tzOffset(req.query) },
  );

  const topProducts = (type: 'STOCK_IN' | 'STOCK_OUT') =>
    db.all(
      `SELECT p.id, p.sku, p.name, p.unit, COUNT(*) AS movements, SUM(ABS(t.quantity_change)) AS units,
              SUM(ABS(t.quantity_change) * ${type === 'STOCK_OUT' ? 'p.selling_price' : 'p.purchase_price'}) AS value
       FROM inventory_transactions t JOIN products p ON p.id = t.product_id
       WHERE ${inRange} AND t.type = '${type}'
       GROUP BY p.id ORDER BY units DESC, p.id LIMIT 10`,
      range,
    );

  const byUser = await db.all(
    `SELECT COALESCE(u.username::text, 'system') AS username, u.full_name, COUNT(*) AS movements,
            COALESCE(SUM(CASE WHEN t.quantity_change > 0 THEN t.quantity_change END), 0) AS "unitsIn",
            COALESCE(SUM(CASE WHEN t.quantity_change < 0 THEN -t.quantity_change END), 0) AS "unitsOut"
     FROM inventory_transactions t LEFT JOIN users u ON u.id = t.user_id
     WHERE ${inRange} GROUP BY t.user_id, u.username, u.full_name ORDER BY movements DESC, 1`,
    range,
  );

  const adjustments = await db.all(
    `SELECT t.id, t.created_at, t.type, t.quantity_before, t.quantity_change, t.quantity_after, t.notes,
            p.sku, p.name, u.username, t.quantity_change * p.purchase_price AS value
     FROM inventory_transactions t JOIN products p ON p.id = t.product_id LEFT JOIN users u ON u.id = t.user_id
     WHERE ${inRange} AND t.type IN ('ADJUSTMENT_PLUS','ADJUSTMENT_MINUS')
     ORDER BY t.created_at DESC, t.id DESC LIMIT 100`,
    range,
  );

  // Products with stock on hand but no outgoing movement in the period.
  const noMovement = await db.all(
    `SELECT p.id, p.sku, p.name, p.unit, i.quantity, i.quantity * p.purchase_price AS value,
            (SELECT MAX(created_at) FROM inventory_transactions x WHERE x.product_id = p.id AND x.type = 'STOCK_OUT') AS last_out
     FROM products p JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = @wh
     WHERE p.status = 'ACTIVE' AND i.quantity > 0
       AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.product_id = p.id AND t.type = 'STOCK_OUT' AND ${inRange})
     ORDER BY 6 DESC, p.id LIMIT 15`,
    range,
  );

  res.json({
    data: {
      byType,
      byDay,
      topOut: await topProducts('STOCK_OUT'),
      topIn: await topProducts('STOCK_IN'),
      byUser,
      adjustments,
      noMovement,
    },
  });
});

/** Current stock valuation grouped by category, supplier or zone. */
reportsRouter.get('/valuation', async (req, res) => {
  const db = getDb();
  const wh = await getDefaultWarehouseId(db);
  const group = str(req.query.groupBy) ?? 'category';
  const expr =
    group === 'supplier'
      ? { key: "COALESCE(s.name::text, '—')", join: 'LEFT JOIN suppliers s ON s.id = p.supplier_id' }
      : group === 'zone'
        ? { key: "COALESCE(l.zone, '—')", join: 'LEFT JOIN warehouse_locations l ON l.id = i.location_id' }
        : { key: "COALESCE(c.name::text, '—')", join: 'LEFT JOIN categories c ON c.id = p.category_id' };
  const rows = await db.all<{ group_name: string } & Record<string, unknown>>(
    `SELECT ${expr.key} AS group_name, COUNT(p.id) AS products,
            COALESCE(SUM(GREATEST(COALESCE(i.quantity,0),0)), 0) AS units,
            COALESCE(SUM(GREATEST(COALESCE(i.quantity,0),0) * p.purchase_price), 0) AS "costValue",
            COALESCE(SUM(GREATEST(COALESCE(i.quantity,0),0) * p.selling_price), 0) AS "retailValue",
            COUNT(*) FILTER (WHERE COALESCE(i.quantity,0) <= p.min_stock) AS alerts
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
     ${expr.join}
     WHERE p.status = 'ACTIVE'
     GROUP BY 1 ORDER BY 4 DESC, 1`,
    wh,
  );
  res.json({ data: rows.map(({ group_name, ...r }) => ({ name: group_name, ...r })) });
});
