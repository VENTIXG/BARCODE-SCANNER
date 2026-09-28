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
export function findOrCreateLocation(db: DB, warehouseId: number, rawCode: string): number | null {
  const code = normalizeLocationCode(rawCode);
  if (!code) return null;
  const existing = db
    .prepare('SELECT id FROM warehouse_locations WHERE warehouse_id = ? AND code = ?')
    .pluck()
    .get(warehouseId, code) as number | undefined;
  if (existing) return existing;
  const { zone, rack, shelf } = parseLocationCode(code);
  return Number(
    db
      .prepare('INSERT INTO warehouse_locations (warehouse_id, code, zone, rack, shelf) VALUES (?, ?, ?, ?, ?)')
      .run(warehouseId, code, zone, rack, shelf).lastInsertRowid,
  );
}
