/**
 * PostgreSQL access, for two engines with one API:
 *  - a PostgreSQL server (node-postgres), when DATABASE_URL is set: Docker servers, hosted databases;
 *  - PGlite (PostgreSQL compiled to WebAssembly, inside this process, files in DATA_DIR/pgdata):
 *    the Windows app, development and tests. No database server to install.
 *
 *   await db.all(sql, ...params)    rows
 *   await db.get(sql, ...params)    first row, or undefined
 *   await db.value(sql, ...params)  first column of the first row, or undefined
 *   await db.column(sql, ...params) first column of every row
 *   await db.run(sql, ...params)    { changes, rows } (rows: what RETURNING gave)
 *   await db.exec(sql)              several statements, no parameters (migrations)
 *   await db.tx(async (t) => ...)   a transaction; nested calls become savepoints
 *
 * Parameters are written as ? (positional) or @name (pass one object), and numbered for
 * PostgreSQL ($1, $2, ...). Results keep the conventions of the earlier SQLite code: bigint and
 * numeric come back as numbers, booleans as 1/0.
 *
 * Write transactions run one at a time, as they did with SQLite (a global advisory lock on a
 * server; PGlite has one connection), so stock movements and document numbers can never
 * interleave. Inside db.tx(), every query made through any handle of the same database joins
 * that transaction (AsyncLocalStorage), so a helper that calls getDb() cannot escape or deadlock it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type Param = string | number | boolean | null | undefined | Date | Uint8Array;
export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Named = Record<string, Param>;

export interface RunResult {
  changes: number;
  rows: Row[];
}

export interface Sql {
  all<T = Row>(text: string, ...params: Param[] | [Named]): Promise<T[]>;
  get<T = Row>(text: string, ...params: Param[] | [Named]): Promise<T | undefined>;
  value<T = any>(text: string, ...params: Param[] | [Named]): Promise<T | undefined>; // eslint-disable-line @typescript-eslint/no-explicit-any
  column<T = any>(text: string, ...params: Param[] | [Named]): Promise<T[]>; // eslint-disable-line @typescript-eslint/no-explicit-any
  run(text: string, ...params: Param[] | [Named]): Promise<RunResult>;
  exec(text: string): Promise<void>;
  tx<T>(fn: (t: Sql) => Promise<T>): Promise<T>;
}

export interface Database extends Sql {
  readonly kind: 'postgres' | 'pglite';
  close(): Promise<void>;
}

// ---- Placeholders ------------------------------------------------------------------------------

interface Prepared {
  text: string;
  /** For @name placeholders: parameter names in $n order. */
  names: string[] | null;
}

const cache = new Map<string, Prepared>();

/** Rewrites ? and @name into $n, leaving strings, quoted names and comments alone. */
export function prepare(text: string, named: boolean): Prepared {
  const key = (named ? 'n:' : 'p:') + text;
  const hit = cache.get(key);
  if (hit) return hit;
  let out = '';
  let n = 0;
  const names: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "'" || c === '"') {
      const end = closing(text, i, c);
      out += text.slice(i, end);
      i = end;
    } else if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop);
      i = stop;
    } else if (c === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      // Dollar-quoted body ($tag$ ... $tag$).
      const tagEnd = text.indexOf('$', i + 1);
      const tag = tagEnd === -1 ? '' : text.slice(i, tagEnd + 1);
      const end = tag && /^\$[A-Za-z_]*\$$/.test(tag) ? text.indexOf(tag, tagEnd + 1) : -1;
      const stop = end === -1 ? i + 1 : end + tag.length;
      out += text.slice(i, stop);
      i = stop;
    } else if (!named && c === '?') {
      out += `$${++n}`;
      i++;
    } else if (named && c === '@' && /[A-Za-z_]/.test(next ?? '')) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const name = text.slice(i + 1, j);
      let idx = names.indexOf(name);
      if (idx === -1) idx = names.push(name) - 1;
      out += `$${idx + 1}`;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  const prepared = { text: out, names: named ? names : null };
  if (cache.size < 5000) cache.set(key, prepared);
  return prepared;
}

function closing(text: string, start: number, quote: string) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) i += 2; // escaped quote
      else return i + 1;
    } else i++;
  }
  return text.length;
}

const isNamed = (params: unknown[]): params is [Named] =>
  params.length === 1 &&
  params[0] !== null &&
  typeof params[0] === 'object' &&
  !(params[0] instanceof Date) &&
  !(params[0] instanceof Uint8Array);

function toValue(v: Param): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** SQL text and values for the driver. */
export function bind(text: string, params: unknown[]): { text: string; values: unknown[] } {
  if (isNamed(params)) {
    const p = prepare(text, true);
    const obj = params[0];
    return {
      text: p.text,
      values: p.names!.map((name) => {
        if (!(name in obj)) throw new Error(`Missing SQL parameter @${name}`);
        return toValue(obj[name]);
      }),
    };
  }
  const p = prepare(text, false);
  return { text: p.text, values: (params as Param[]).map(toValue) };
}

// ---- Shared implementation ---------------------------------------------------------------------

interface QueryResult {
  rows: Row[];
  changes: number;
}

const als = new AsyncLocalStorage<TxHandle>();

abstract class Handle implements Sql {
  /** Runs one statement with numbered parameters (internal). */
  abstract _query(text: string, values: unknown[]): Promise<QueryResult>;
  abstract exec(text: string): Promise<void>;
  abstract tx<T>(fn: (t: Sql) => Promise<T>): Promise<T>;

  async all<T = Row>(text: string, ...params: Param[] | [Named]): Promise<T[]> {
    const b = bind(text, params);
    return (await this._query(b.text, b.values)).rows as T[];
  }

  async get<T = Row>(text: string, ...params: Param[] | [Named]): Promise<T | undefined> {
    const rows = await this.all<T>(text, ...params);
    return rows[0];
  }

  async value<T = any>(text: string, ...params: Param[] | [Named]): Promise<T | undefined> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const row = await this.get<Row>(text, ...params);
    return row ? (Object.values(row)[0] as T) : undefined;
  }

  async column<T = any>(text: string, ...params: Param[] | [Named]): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const rows = await this.all<Row>(text, ...params);
    return rows.map((r) => Object.values(r)[0] as T);
  }

  async run(text: string, ...params: Param[] | [Named]): Promise<RunResult> {
    const b = bind(text, params);
    return this._query(b.text, b.values);
  }
}

/** A transaction in progress (one connection). */
abstract class TxHandle extends Handle {
  closed = false;
  private depth = 0;
  constructor(readonly root: Handle) {
    super();
  }

  async tx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
    const name = `ims_sp_${++this.depth}`;
    await this.exec(`SAVEPOINT ${name}`);
    try {
      const out = await fn(this);
      await this.exec(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      await this.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }
}

/** The open transaction of this database in the current async context, if any. */
function current(root: Handle): TxHandle | undefined {
  const t = als.getStore();
  return t && !t.closed && t.root === root ? t : undefined;
}

// ---- PostgreSQL server (node-postgres) --------------------------------------------------------

/** Any constant: identifies the "one writer at a time" lock of this application. */
const WRITE_LOCK = 734_105_552;

type PgPool = import('pg').Pool;
type PgClient = import('pg').PoolClient;

class PgTx extends TxHandle {
  constructor(
    root: Handle,
    private readonly client: PgClient,
  ) {
    super(root);
  }
  async _query(text: string, values: unknown[]) {
    const r = await this.client.query({ text, values });
    return { rows: r.rows, changes: r.rowCount ?? 0 };
  }
  async exec(text: string) {
    await this.client.query(text);
  }
}

class PgDatabase extends Handle implements Database {
  readonly kind = 'postgres' as const;
  constructor(private readonly pool: PgPool) {
    super();
  }

  async _query(text: string, values: unknown[]) {
    const t = current(this);
    if (t) return t._query(text, values);
    const r = await this.pool.query({ text, values });
    return { rows: r.rows, changes: r.rowCount ?? 0 };
  }

  async exec(text: string) {
    const t = current(this);
    if (t) return t.exec(text);
    await this.pool.query(text);
  }

  async tx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
    const open = current(this);
    if (open) return open.tx(fn);
    const client = await this.pool.connect();
    const t = new PgTx(this, client);
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
      const out = await als.run(t, () => fn(t));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      t.closed = true;
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export async function openPostgres(url: string): Promise<Database> {
  const pg = (await import('pg')).default;
  const parsers: Record<number, (v: string) => unknown> = {
    20: Number, // bigint (count, sum of integers)
    1700: Number, // numeric
    16: (v) => (v === 't' ? 1 : 0), // boolean -> 1/0
  };
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_SIZE) || 10,
    types: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getTypeParser: ((oid: number, format?: any) => parsers[oid] ?? pg.types.getTypeParser(oid, format)) as any,
    },
  });
  pool.on('error', (e) => console.error('[db] idle connection error:', e.message));
  const db = new PgDatabase(pool);
  await db.value('SELECT 1');
  return db;
}

// ---- PGlite (PostgreSQL inside this process) ---------------------------------------------------

type PGliteT = import('@electric-sql/pglite').PGlite;
type PGliteTx = import('@electric-sql/pglite').Transaction;

class PgliteTx extends TxHandle {
  constructor(
    root: Handle,
    private readonly t: PGliteTx,
  ) {
    super(root);
  }
  async _query(text: string, values: unknown[]) {
    const r = await this.t.query<Row>(text, values);
    return { rows: r.rows, changes: r.affectedRows ?? 0 };
  }
  async exec(text: string) {
    await this.t.exec(text);
  }
}

class PgliteDatabase extends Handle implements Database {
  readonly kind = 'pglite' as const;
  constructor(private readonly pg: PGliteT) {
    super();
  }

  async _query(text: string, values: unknown[]) {
    const t = current(this);
    if (t) return t._query(text, values);
    const r = await this.pg.query<Row>(text, values);
    return { rows: r.rows, changes: r.affectedRows ?? 0 };
  }

  async exec(text: string) {
    const t = current(this);
    if (t) return t.exec(text);
    await this.pg.exec(text);
  }

  async tx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
    const open = current(this);
    if (open) return open.tx(fn);
    return this.pg.transaction(async (ptx) => {
      const t = new PgliteTx(this, ptx);
      try {
        return await als.run(t, () => fn(t));
      } finally {
        t.closed = true;
      }
    });
  }

  async close() {
    await this.pg.close();
  }
}

/** dataDir: folder for the database files; omitted = in memory (tests). */
export async function openPglite(dataDir?: string): Promise<Database> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const pg = await PGlite.create(dataDir ?? 'memory://', {
    extensions: { citext },
    parsers: {
      [types.INT8]: (v: string) => Number(v),
      [types.NUMERIC]: (v: string) => Number(v),
      [types.BOOL]: (v: string) => (v === 't' ? 1 : 0),
    },
  });
  return new PgliteDatabase(pg);
}
