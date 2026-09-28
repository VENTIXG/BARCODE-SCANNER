import { Router } from 'express';
import { getDb } from '../db/index.js';
import { escapeLike, num, pagination, str } from '../lib/http.js';

export const auditRouter = Router();

auditRouter.get('/', (req, res) => {
  const db = getDb();
  const { page, pageSize, offset } = pagination(req.query, 50);
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  const q = str(req.query.q);
  if (q) (where.push(`(a.description LIKE @like ESCAPE '\\' OR a.username LIKE @like ESCAPE '\\')`), (params.like = `%${escapeLike(q)}%`));
  const userId = num(req.query.userId);
  if (userId) (where.push('a.user_id = @userId'), (params.userId = userId));
  const productId = num(req.query.productId);
  if (productId) (where.push('a.product_id = @productId'), (params.productId = productId));
  const action = str(req.query.action);
  if (action) (where.push(`a.action LIKE @action ESCAPE '\\'`), (params.action = `${escapeLike(action)}%`));
  const from = str(req.query.from);
  if (from) (where.push('a.created_at >= @from'), (params.from = from));
  const to = str(req.query.to);
  if (to) (where.push('a.created_at < @to'), (params.to = to));
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) FROM audit_logs a ${w}`).pluck().get(params);
  const rows = db
    .prepare(
      `SELECT a.*, p.sku AS product_sku, p.name AS product_name
       FROM audit_logs a LEFT JOIN products p ON p.id = a.product_id
       ${w} ORDER BY a.created_at DESC, a.id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: pageSize, offset });
  res.json({ data: rows, total, page, pageSize });
});

auditRouter.get('/actions', (_req, res) => {
  res.json({ data: getDb().prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').pluck().all() });
});
