import { translate } from './i18n';

let currency = 'EUR';
export const setCurrency = (c: string) => (currency = c || 'EUR');

const numberLocale = () => (document.documentElement.lang === 'en' ? 'en-GB' : 'el-GR');

export function fmtQty(n: number | null | undefined, unit?: string): string {
  if (n == null || Number.isNaN(n)) return '—';
  const s = new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: 3 }).format(n);
  return unit ? `${s} ${unit}` : s;
}

export function fmtNumber(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
}

export function fmtMoney(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(numberLocale(), {
    style: 'currency',
    currency,
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : 2,
  }).format(n);
}

export function fmtSigned(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtQty(Math.abs(n))}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 28/09/2026 18:35 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Accepts ISO timestamps or YYYY-MM-DD. */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${d}/${m}/${y}`;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtRelative(iso: string): string {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return translate('just now');
  if (diff < 3600) return translate('{n} min ago', { n: Math.floor(diff / 60) });
  if (diff < 86400) return translate('{n} h ago', { n: Math.floor(diff / 3600) });
  return fmtDateTime(iso);
}

/** Local YYYY-MM-DD for <input type="date"> */
export function todayLocal(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local date (YYYY-MM-DD) -> UTC ISO of local midnight; `endExclusive` gives the next midnight. */
export function localDateToIso(date: string, endExclusive = false): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d + (endExclusive ? 1 : 0)).toISOString();
}

export const MONTHS_EL = ['Ιαν', 'Φεβ', 'Μαρ', 'Απρ', 'Μαΐ', 'Ιουν', 'Ιουλ', 'Αυγ', 'Σεπ', 'Οκτ', 'Νοε', 'Δεκ'];
export const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09" -> "Σεπ 26" */
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const names = document.documentElement.lang === 'en' ? MONTHS_EN : MONTHS_EL;
  return `${names[m - 1]} ${String(y).slice(2)}`;
}

/** "2026-09-28" -> "28/09" */
export function fmtDayShort(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${d}/${m}`;
}
