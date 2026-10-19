import { Router } from 'express';
import { getDb } from '../db/index.js';
import { escapeLike, str } from '../lib/http.js';
import { listProducts, serializeProduct } from '../lib/products.js';

export const searchRouter = Router();

/** Global search box: products by barcode / SKU / name / supplier / category. */
searchRouter.get('/', async (req, res) => {
  const q = str(req.query.q);
  if (!q) return res.json({ data: { products: [], totalProducts: 0, categories: [], suppliers: [] } });
  const db = getDb();
  const { total, rows } = await listProducts(db, { q }, { limit: 8, offset: 0 });
  const like = `%${escapeLike(q)}%`;
  const categories = await db.all(
    `SELECT id, name FROM categories WHERE ims_norm(name::text) LIKE ims_norm(?) ESCAPE '\\' ORDER BY name LIMIT 3`,
    like,
  );
  const suppliers = await db.all(
    `SELECT id, name FROM suppliers WHERE ims_norm(name::text) LIKE ims_norm(?) ESCAPE '\\' ORDER BY name LIMIT 3`,
    like,
  );
  res.json({ data: { products: rows.map(serializeProduct), totalProducts: total, categories, suppliers } });
});
