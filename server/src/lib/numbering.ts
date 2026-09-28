import type { DB } from '../db/index.js';

/** Next document number, e.g. RCV-2026-00042. Must run inside a transaction. */
export function nextDocumentNumber(db: DB, prefix: 'RCV' | 'DSP', date = new Date()): string {
  const year = date.getFullYear();
  db.prepare(
    `INSERT INTO sequences (name, year, value) VALUES (?, ?, 1)
     ON CONFLICT(name, year) DO UPDATE SET value = value + 1`,
  ).run(prefix, year);
  const value = db.prepare('SELECT value FROM sequences WHERE name = ? AND year = ?').pluck().get(prefix, year) as number;
  return `${prefix}-${year}-${String(value).padStart(5, '0')}`;
}

/** Preview of the next number without consuming it. */
export function peekDocumentNumber(db: DB, prefix: 'RCV' | 'DSP', date = new Date()): string {
  const year = date.getFullYear();
  const value = (db.prepare('SELECT value FROM sequences WHERE name = ? AND year = ?').pluck().get(prefix, year) as
    | number
    | undefined) ?? 0;
  return `${prefix}-${year}-${String(value + 1).padStart(5, '0')}`;
}
