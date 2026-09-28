import { Router } from 'express';
import { getDb, getDefaultWarehouseId } from '../db/index.js';
import { lastDays, lastMonths, localDayStartIso, localMonthStartIso, tzModifier, tzOffset } from '../lib/http.js';
import { TX_SELECT } from '../lib/transactions.js';
import { PRODUCT_SELECT, serializeProduct, type ProductRow } from '../lib/products.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', (req, res) => {
  const db = getDb();
  const wh = getDefaultWarehouseId(db);
  const tz = tzOffset(req.query);
  const mod = tzModifier(tz);
  const today = localDayStartIso(tz);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS totalProducts,
              SUM(p.status = 'ACTIVE') AS activeProducts,
              COALESCE(SUM(MAX(COALESCE(i.quantity, 0), 0)), 0) AS totalUnits,
              COALESCE(SUM(MAX(COALESCE(i.quantity, 0), 0) * p.purchase_price), 0) AS inventoryValue,
              COALESCE(SUM(MAX(COALESCE(i.quantity, 0), 0) * p.selling_price), 0) AS retailValue,
              SUM(p.status = 'ACTIVE' AND COALESCE(i.quantity, 0) > 0 AND COALESCE(i.quantity, 0) <= p.min_stock) AS lowStock,
              SUM(p.status = 'ACTIVE' AND COALESCE(i.quantity, 0) <= 0) AS outOfStock
       FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?`,
    )
    .get(wh) as Record<string, number>;

  const todayMoves = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'STOCK_IN' THEN quantity_change END), 0) AS stockInUnits,
         COUNT(CASE WHEN type = 'STOCK_IN' THEN 1 END) AS stockInCount,
         COALESCE(SUM(CASE WHEN type = 'STOCK_OUT' THEN -quantity_change END), 0) AS stockOutUnits,
         COUNT(CASE WHEN type = 'STOCK_OUT' THEN 1 END) AS stockOutCount,
         COUNT(*) AS transactions
       FROM inventory_transactions WHERE created_at >= ? AND warehouse_id = ?`,
    )
    .get(today, wh);

  // Stock IN vs OUT per month (last 12 months)
  const monthRows = db
    .prepare(
      `SELECT strftime('%Y-%m', created_at, '${mod}') AS month,
              COALESCE(SUM(CASE WHEN type = 'STOCK_IN' THEN quantity_change END), 0) AS stockIn,
              COALESCE(SUM(CASE WHEN type = 'STOCK_OUT' THEN -quantity_change END), 0) AS stockOut
       FROM inventory_transactions
       WHERE created_at >= ? AND warehouse_id = ? AND type IN ('STOCK_IN','STOCK_OUT')
       GROUP BY month`,
    )
    .all(localMonthStartIso(tz, 11), wh) as { month: string; stockIn: number; stockOut: number }[];
  const byMonth = new Map(monthRows.map((r) => [r.month, r]));
  const monthly = lastMonths(tz, 12).map((m) => ({ month: m, stockIn: byMonth.get(m)?.stockIn ?? 0, stockOut: byMonth.get(m)?.stockOut ?? 0 }));

  // Movements per day (last 30 days)
  const dayRows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at, '${mod}') AS day, COUNT(*) AS movements,
              COALESCE(SUM(CASE WHEN quantity_change > 0 THEN quantity_change END), 0) AS unitsIn,
              COALESCE(SUM(CASE WHEN quantity_change < 0 THEN -quantity_change END), 0) AS unitsOut
       FROM inventory_transactions WHERE created_at >= ? AND warehouse_id = ? GROUP BY day`,
    )
    .all(localDayStartIso(tz, 29), wh) as { day: string; movements: number; unitsIn: number; unitsOut: number }[];
  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const daily = lastDays(tz, 30).map((d) => ({ day: d, movements: byDay.get(d)?.movements ?? 0, unitsIn: byDay.get(d)?.unitsIn ?? 0, unitsOut: byDay.get(d)?.unitsOut ?? 0 }));

  // Inventory value at the end of each of the last 12 months, valued at current
  // purchase prices: value(t) = value(now) - sum(changes after t).
  const monthStarts = lastMonths(tz, 12).map((_, i) => localMonthStartIso(tz, 10 - i)); // start of next month = end of month
  const changeAfter = db.prepare(
    `SELECT COALESCE(SUM(t.quantity_change * p.purchase_price), 0)
     FROM inventory_transactions t JOIN products p ON p.id = t.product_id
     WHERE t.created_at >= ? AND t.warehouse_id = ?`,
  );
  const currentValue = db
    .prepare(
      `SELECT COALESCE(SUM(i.quantity * p.purchase_price), 0) FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.warehouse_id = ?`,
    )
    .pluck()
    .get(wh) as number;
  const valueTrend = lastMonths(tz, 12).map((month, i) => ({
    month,
    value: i === 11 ? currentValue : currentValue - (changeAfter.pluck().get(monthStarts[i], wh) as number),
  }));

  const byCategory = db
    .prepare(
      `SELECT COALESCE(c.name, '—') AS category, COUNT(p.id) AS products,
              COALESCE(SUM(MAX(COALESCE(i.quantity, 0), 0)), 0) AS units,
              COALESCE(SUM(MAX(COALESCE(i.quantity, 0), 0) * p.purchase_price), 0) AS value
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
       WHERE p.status = 'ACTIVE'
       GROUP BY c.id ORDER BY products DESC`,
    )
    .all(wh);

  const recent = db.prepare(`${TX_SELECT} WHERE t.warehouse_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT 10`).all(wh);

  const lowStock = (
    db
      .prepare(
        `${PRODUCT_SELECT} WHERE p.status = 'ACTIVE' AND COALESCE(i.quantity, 0) <= p.min_stock
         ORDER BY (COALESCE(i.quantity, 0) <= 0) DESC, (COALESCE(i.quantity, 0) - p.min_stock) ASC LIMIT 8`,
      )
      .all({ warehouseId: wh }) as ProductRow[]
  ).map(serializeProduct);

  res.json({ data: { totals, today: todayMoves, monthly, daily, valueTrend, byCategory, recent, lowStock } });
});
