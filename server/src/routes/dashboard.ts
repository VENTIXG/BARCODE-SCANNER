import { Router } from 'express';
import { getDb, getDefaultWarehouseId } from '../db/index.js';
import { lastDays, lastMonths, localDayStartIso, localMonthStartIso, tzOffset } from '../lib/http.js';
import { TX_SELECT } from '../lib/transactions.js';
import { PRODUCT_SELECT, serializeProduct, type ProductRow } from '../lib/products.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (req, res) => {
  const db = getDb();
  const wh = await getDefaultWarehouseId(db);
  const tz = tzOffset(req.query);
  const today = localDayStartIso(tz);

  const totals = await db.get<Record<string, number>>(
    `SELECT COUNT(*) AS "totalProducts",
            COUNT(*) FILTER (WHERE p.status = 'ACTIVE') AS "activeProducts",
            COALESCE(SUM(GREATEST(COALESCE(i.quantity, 0), 0)), 0) AS "totalUnits",
            COALESCE(SUM(GREATEST(COALESCE(i.quantity, 0), 0) * p.purchase_price), 0) AS "inventoryValue",
            COALESCE(SUM(GREATEST(COALESCE(i.quantity, 0), 0) * p.selling_price), 0) AS "retailValue",
            COUNT(*) FILTER (WHERE p.status = 'ACTIVE' AND COALESCE(i.quantity, 0) > 0 AND COALESCE(i.quantity, 0) <= p.min_stock) AS "lowStock",
            COUNT(*) FILTER (WHERE p.status = 'ACTIVE' AND COALESCE(i.quantity, 0) <= 0) AS "outOfStock"
     FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?`,
    wh,
  );

  const todayMoves = await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'STOCK_IN' THEN quantity_change END), 0) AS "stockInUnits",
       COUNT(CASE WHEN type = 'STOCK_IN' THEN 1 END) AS "stockInCount",
       COALESCE(SUM(CASE WHEN type = 'STOCK_OUT' THEN -quantity_change END), 0) AS "stockOutUnits",
       COUNT(CASE WHEN type = 'STOCK_OUT' THEN 1 END) AS "stockOutCount",
       COUNT(*) AS transactions
     FROM inventory_transactions WHERE created_at >= ? AND warehouse_id = ?`,
    today,
    wh,
  );

  // Stock IN vs OUT per month (last 12 months)
  const monthRows = await db.all<{ month: string; stockIn: number; stockOut: number }>(
    `SELECT ims_local(created_at, @tz, 'YYYY-MM') AS month,
            COALESCE(SUM(CASE WHEN type = 'STOCK_IN' THEN quantity_change END), 0) AS "stockIn",
            COALESCE(SUM(CASE WHEN type = 'STOCK_OUT' THEN -quantity_change END), 0) AS "stockOut"
     FROM inventory_transactions
     WHERE created_at >= @since AND warehouse_id = @wh AND type IN ('STOCK_IN','STOCK_OUT')
     GROUP BY 1`,
    { tz, since: localMonthStartIso(tz, 11), wh },
  );
  const byMonth = new Map(monthRows.map((r) => [r.month, r]));
  const monthly = lastMonths(tz, 12).map((m) => ({ month: m, stockIn: byMonth.get(m)?.stockIn ?? 0, stockOut: byMonth.get(m)?.stockOut ?? 0 }));

  // Movements per day (last 30 days)
  const dayRows = await db.all<{ day: string; movements: number; unitsIn: number; unitsOut: number }>(
    `SELECT ims_local(created_at, @tz, 'YYYY-MM-DD') AS day, COUNT(*) AS movements,
            COALESCE(SUM(CASE WHEN quantity_change > 0 THEN quantity_change END), 0) AS "unitsIn",
            COALESCE(SUM(CASE WHEN quantity_change < 0 THEN -quantity_change END), 0) AS "unitsOut"
     FROM inventory_transactions WHERE created_at >= @since AND warehouse_id = @wh GROUP BY 1`,
    { tz, since: localDayStartIso(tz, 29), wh },
  );
  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const daily = lastDays(tz, 30).map((d) => ({ day: d, movements: byDay.get(d)?.movements ?? 0, unitsIn: byDay.get(d)?.unitsIn ?? 0, unitsOut: byDay.get(d)?.unitsOut ?? 0 }));

  // Inventory value at the end of each of the last 12 months, valued at current
  // purchase prices: value(t) = value(now) - sum(changes after t).
  const monthStarts = lastMonths(tz, 12).map((_, i) => localMonthStartIso(tz, 10 - i)); // start of next month = end of month
  const currentValue =
    (await db.value<number>(
      `SELECT COALESCE(SUM(i.quantity * p.purchase_price), 0) FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.warehouse_id = ?`,
      wh,
    )) ?? 0;
  const valueTrend = [];
  for (const [i, month] of lastMonths(tz, 12).entries()) {
    const after =
      i === 11
        ? 0
        : ((await db.value<number>(
            `SELECT COALESCE(SUM(t.quantity_change * p.purchase_price), 0)
             FROM inventory_transactions t JOIN products p ON p.id = t.product_id
             WHERE t.created_at >= ? AND t.warehouse_id = ?`,
            monthStarts[i],
            wh,
          )) ?? 0);
    valueTrend.push({ month, value: currentValue - after });
  }

  const byCategory = await db.all(
    `SELECT COALESCE(c.name::text, '—') AS category, COUNT(p.id) AS products,
            COALESCE(SUM(GREATEST(COALESCE(i.quantity, 0), 0)), 0) AS units,
            COALESCE(SUM(GREATEST(COALESCE(i.quantity, 0), 0) * p.purchase_price), 0) AS value
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = ?
     WHERE p.status = 'ACTIVE'
     GROUP BY c.id, c.name ORDER BY products DESC, category`,
    wh,
  );

  const recent = await db.all(`${TX_SELECT} WHERE t.warehouse_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT 10`, wh);

  const lowStock = (
    await db.all<ProductRow>(
      `${PRODUCT_SELECT} WHERE p.status = 'ACTIVE' AND COALESCE(i.quantity, 0) <= p.min_stock
       ORDER BY (COALESCE(i.quantity, 0) <= 0) DESC, (COALESCE(i.quantity, 0) - p.min_stock) ASC, p.id LIMIT 8`,
      { warehouseId: wh },
    )
  ).map(serializeProduct);

  res.json({ data: { totals, today: todayMoves, monthly, daily, valueTrend, byCategory, recent, lowStock } });
});
