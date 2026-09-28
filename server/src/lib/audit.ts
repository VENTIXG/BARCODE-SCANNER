import type { DB } from '../db/index.js';
import type { Role } from './permissions.js';

/** The user performing an action, plus request metadata for the audit trail. */
export interface Actor {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  action: string;
  description: string;
  entityType?: string;
  entityId?: number | null;
  productId?: number | null;
  oldValue?: unknown;
  newValue?: unknown;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export function audit(db: DB, actor: Actor | null, e: AuditEntry) {
  db.prepare(
    `INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, product_id,
       description, old_value, new_value, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    actor?.id ?? null,
    actor?.username ?? 'system',
    e.action,
    e.entityType ?? null,
    e.entityId ?? null,
    e.productId ?? null,
    e.description,
    json(e.oldValue),
    json(e.newValue),
    actor?.ip ?? null,
    actor?.userAgent?.slice(0, 250) ?? null,
  );
}

/**
 * Compare two records field by field and return the changed fields,
 * plus human-readable phrases such as "minimum stock from 10 to 20".
 */
export function diff<T extends object>(
  before: T,
  after: Partial<T>,
  labels: Partial<Record<keyof T, string>>,
) {
  const oldValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const phrases: string[] = [];
  for (const key of Object.keys(labels) as (keyof T)[]) {
    if (!(key in after)) continue;
    const a = (before[key] as unknown) ?? null;
    const b = (after[key] as unknown) ?? null;
    if (a === b || (a !== null && b !== null && String(a) === String(b))) continue;
    oldValue[key as string] = a;
    newValue[key as string] = b;
    phrases.push(`${labels[key]} from ${fmt(a)} to ${fmt(b)}`);
  }
  return { changed: phrases.length > 0, oldValue, newValue, phrases };
}

const fmt = (v: unknown) => (v === null || v === '' ? '(empty)' : `"${String(v)}"`);
