import type { DB } from '../db/index.js';

/** Normalise a location code: trims, upper-cases and collapses separators ("a 1 3" -> "A-1-3"). */
export function normalizeLocationCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[\s_/.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Split "A-01-03" into zone / rack / shelf. */
export function parseLocationCode(code: string) {
  const [zone = null, rack = null, ...rest] = normalizeLocationCode(code).split('-');
  return { zone, rack, shelf: rest.length ? rest.join('-') : null };
}

/** Find a location by code in a warehouse, creating it if it does not exist. */
export async function findOrCreateLocation(db: DB, warehouseId: number, rawCode: string): Promise<number | null> {
  const code = normalizeLocationCode(rawCode);
  if (!code) return null;
  const existing = await db.value<number>('SELECT id FROM warehouse_locations WHERE warehouse_id = ? AND code = ?', warehouseId, code);
  if (existing) return existing;
  const { zone, rack, shelf } = parseLocationCode(code);
  return (await db.value<number>(
    'INSERT INTO warehouse_locations (warehouse_id, code, zone, rack, shelf) VALUES (?, ?, ?, ?, ?) RETURNING id',
    warehouseId,
    code,
    zone,
    rack,
    shelf,
  )) as number;
}
