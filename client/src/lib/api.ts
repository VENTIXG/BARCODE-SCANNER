import { translate } from './i18n';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: any,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(params?: Query): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export interface RequestOptions {
  /** Retry network errors and gateway timeouts with the same body (use with an idempotency key). */
  retries?: number;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(method: string, url: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const isForm = body instanceof FormData;
  const init = (): RequestInit => ({
    method,
    credentials: 'same-origin',
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`/api${url}`, init());
    } catch (err) {
      // Network dropped before a response arrived.
      if (attempt++ < (opts.retries ?? 0)) {
        await sleep(500 * attempt);
        continue;
      }
      throw new ApiError(0, translate('Connection lost. Check the network and try again.'), 'NETWORK');
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt++ < (opts.retries ?? 0)) {
      await sleep(500 * attempt);
      continue;
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !url.startsWith('/auth/login')) onUnauthorized?.();
      throw new ApiError(res.status, translate(data?.error?.message ?? res.statusText), data?.error?.code, data?.error?.details);
    }
    return data as T;
  }
}

/**
 * A key for one user action. Works on plain http too (crypto.randomUUID needs
 * a secure context; getRandomValues does not).
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const api = {
  get: <T>(url: string, params?: Query) => request<T>('GET', url + qs(params)),
  post: <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', url, body ?? {}, opts),
  put: <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', url, body ?? {}, opts),
  del: <T>(url: string) => request<T>('DELETE', url),
};

/** Download a file (e.g. Excel export) from the API and save it. */
export async function download(url: string, params?: Query) {
  const res = await fetch(`/api${url}${qs(params)}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error?.message ?? 'Download failed');
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'export.xlsx';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Client timezone offset in minutes east of UTC, sent to date-grouped endpoints. */
export const tz = () => -new Date().getTimezoneOffset();

export interface Page<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}
