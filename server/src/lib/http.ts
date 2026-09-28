import { z } from 'zod';
import { normalizeText } from '../db/index.js';
import { badRequest } from './errors.js';

/** Parse a numeric route param (e.g. /products/:id). */
export function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id');
  return n;
}

/** Common pagination query parameters. */
export function pagination(query: Record<string, unknown>, defaultSize = 25) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

export const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Client timezone offset in minutes east of UTC (e.g. Athens summer = 180). */
export function tzOffset(query: Record<string, unknown>): number {
  const n = Number(query.tz);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? Math.round(n) : 0;
}

/** SQLite modifier to shift a UTC timestamp into the client's local time. */
export const tzModifier = (tz: number) => `${tz >= 0 ? '+' : ''}${tz} minutes`;

/** Optional nullable trimmed string for zod bodies. */
export const optText = (max = 1000) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Build an FTS5 prefix query from free text: "abc de" -> "abc"* "de"* */
export function ftsQuery(text: string): string | null {
  const tokens = normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

/** UTC ISO timestamp of local midnight `daysAgo` days back, for a client tz offset. */
export function localDayStartIso(tz: number, daysAgo = 0): string {
  const local = new Date(Date.now() + tz * 60_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo);
  return new Date(midnight - tz * 60_000).toISOString();
}

/** UTC ISO timestamp of the first day of the local month `monthsAgo` months back. */
export function localMonthStartIso(tz: number, monthsAgo = 0): string {
  const local = new Date(Date.now() + tz * 60_000);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - monthsAgo, 1);
  return new Date(start - tz * 60_000).toISOString();
}

/** Local calendar keys (YYYY-MM-DD or YYYY-MM) for the last n days/months, oldest first. */
export function lastDays(tz: number, n: number): string[] {
  const local = new Date(Date.now() + tz * 60_000);
  return Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (n - 1 - i))).toISOString().slice(0, 10),
  );
}
export function lastMonths(tz: number, n: number): string[] {
  const local = new Date(Date.now() + tz * 60_000);
  return Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - (n - 1 - i), 1)).toISOString().slice(0, 7),
  );
}
