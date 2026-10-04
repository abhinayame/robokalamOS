import { randomUUID } from 'node:crypto';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise';
import { db as dbConfig, env } from '../config/env.js';

/** Columns that hold JSON. MariaDB stores JSON as text, so we parse by name as well as by type. */
const JSON_COLUMNS = new Set(['settings', 'schedule', 'meta', 'previous_data', 'new_data', 'teachers', 'roles', 'children', 'payload', 'selector', 'options', 'answer_key', 'answers']);

export const newId = () => randomUUID();

// One SET statement (multi-statement is off). sql_mode matches a default MySQL 8 server,
// so behaviour is identical on MariaDB and MySQL.
const SESSION_INIT = "SET time_zone = '+00:00', SESSION group_concat_max_len = 1048576, "
  + "SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY'";

export const poolOptions = (): mysql.PoolOptions => ({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  connectionLimit: env.DATABASE_POOL_MAX,
  charset: 'UTF8MB4_UNICODE_CI',
  timezone: 'Z',
  dateStrings: true,
  decimalNumbers: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  idleTimeout: 60_000,
  enableKeepAlive: true,
  typeCast(field, next) {
    switch (field.type) {
      case 'TINY':
        if (field.length === 1) { const v = field.string(); return v === null ? null : v === '1'; }
        break;
      case 'DATETIME':
      case 'TIMESTAMP': {
        const v = field.string();
        return v ? `${v.replace(' ', 'T')}Z` : null;   // stored as UTC → ISO-8601
      }
      case 'JSON': {
        const v = field.string();
        return v === null ? null : safeJson(v);
      }
      default:
        if (JSON_COLUMNS.has(field.name) && ['BLOB', 'VAR_STRING', 'STRING', 'LONG_BLOB', 'MEDIUM_BLOB', 'TINY_BLOB'].includes(field.type)) {
          const v = field.string();
          return v === null ? null : safeJson(v);
        }
    }
    return next();
  },
});

function safeJson(s: string) { try { return JSON.parse(s); } catch { return s; } }

export const pool: Pool = mysql.createPool(poolOptions());
// mysql2's pool exposes the underlying callback pool for lifecycle events.
(pool as any).pool.on('connection', (conn: any) => { conn.query(SESSION_INIT); });

export type Db = Pick<Pool, 'query'> | PoolConnection;

/** `$1, $2 …` placeholders (kept for readability) → positional `?` in textual order. */
function translate(sql: string, params: unknown[]): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const out = sql.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    values.push(v === undefined ? null : v);
    return '?';
  });
  return { sql: out, values };
}

/** SELECT → rows. (A write sent through here still runs; it just returns []. Use `exec` to get counts.) */
export async function query<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const { sql: s, values } = translate(sql, params);
  const [res] = await db.query(s, values);
  return Array.isArray(res) ? (res as T[]) : [];
}

export async function queryOne<T = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  return (await query<T>(sql, params, db))[0] ?? null;
}

/** INSERT / UPDATE / DELETE → { affectedRows }. */
export async function exec(sql: string, params: unknown[] = [], db: Db = pool): Promise<ResultSetHeader> {
  const { sql: s, values } = translate(sql, params);
  const [res] = await db.query(s, values);
  return res as ResultSetHeader;
}

const RETRYABLE = new Set([1213, 1205]);   // deadlock, lock wait timeout

/**
 * Run `fn` in one transaction (READ COMMITTED, so locking reads and counts always see
 * committed data). Rolls back on error; retries the whole unit on deadlock.
 */
export async function tx<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (e: any) {
      try { await conn.rollback(); } catch { /* connection already broken */ }
      if (RETRYABLE.has(e?.errno) && attempt < 4) { await new Promise((r) => setTimeout(r, 20 * attempt)); continue; }
      throw e;
    } finally {
      conn.release();
    }
  }
}

/** Collects positional parameters while building dynamic (but always parameterised) SQL. */
export class Params {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
  /** `col IN ${p.in(ids)}` — an empty list matches nothing. */
  in(list: readonly unknown[]): string {
    return list.length ? `(${list.map((v) => this.add(v)).join(',')})` : '(NULL)';
  }
}

/** `(?, ?, …)` helper for fixed lists outside a Params builder. */
export const inList = (n: number) => (n ? `(${Array(n).fill('?').join(',')})` : '(NULL)');
