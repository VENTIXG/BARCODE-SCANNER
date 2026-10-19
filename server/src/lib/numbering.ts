import type { DB } from '../db/index.js';

/** Next document number, e.g. RCV-2026-00042. Run it inside the document's transaction. */
export async function nextDocumentNumber(db: DB, prefix: 'RCV' | 'DSP', date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const value = await db.value<number>(
    `INSERT INTO sequences (name, year, value) VALUES (?, ?, 1)
     ON CONFLICT (name, year) DO UPDATE SET value = sequences.value + 1
     RETURNING value`,
    prefix,
    year,
  );
  return `${prefix}-${year}-${String(value).padStart(5, '0')}`;
}

/** Preview of the next number without consuming it. */
export async function peekDocumentNumber(db: DB, prefix: 'RCV' | 'DSP', date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const value = (await db.value<number>('SELECT value FROM sequences WHERE name = ? AND year = ?', prefix, year)) ?? 0;
  return `${prefix}-${year}-${String(value + 1).padStart(5, '0')}`;
}
