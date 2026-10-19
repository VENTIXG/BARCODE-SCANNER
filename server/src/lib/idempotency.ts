/**
 * Idempotent writes.
 *
 * A client that retries a request (network drop, proxy timeout, double click)
 * sends the same `idempotencyKey`. The first call's result is stored in the
 * same transaction as the write; later calls with that key get the stored
 * result back and nothing is posted twice. A failed call stores nothing, so
 * it can be retried safely.
 */
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { nowIso } from '../db/index.js';
import type { Actor } from './audit.js';
import { conflict } from './errors.js';

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, 'Invalid idempotency key')
  .optional();

export interface Outcome {
  status: number;
  body: unknown;
}

export async function runIdempotent(
  db: DB,
  actor: Actor,
  key: string | undefined,
  scope: string,
  work: () => Promise<Outcome>,
): Promise<Outcome & { replayed: boolean }> {
  // Always one transaction: a stock count or a document is posted completely or not at all.
  if (!key) return { ...(await db.tx(() => work())), replayed: false };
  return db.tx(async (t) => {
    const prev = await t.get<{ user_id: number | null; scope: string; status: number; response: string }>(
      'SELECT user_id, scope, status, response FROM idempotency_keys WHERE key = ?',
      key,
    );
    if (prev) {
      if (prev.user_id !== actor.id || prev.scope !== scope) {
        throw conflict('This request key was already used for another action', 'IDEMPOTENCY_CONFLICT');
      }
      return { status: prev.status, body: JSON.parse(prev.response), replayed: true };
    }
    const out = await work();
    await t.run(
      'INSERT INTO idempotency_keys (key, user_id, scope, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      key,
      actor.id,
      scope,
      out.status,
      JSON.stringify(out.body),
      nowIso(),
    );
    return { ...out, replayed: false };
  });
}
