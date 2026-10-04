import pg from 'pg';
import { env } from '../config/env.js';

// Return bigint counts as numbers and date columns as plain YYYY-MM-DD strings.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 30_000,
  statement_timeout: 30_000,
  options: '-c jit=off',   // JIT compilation only adds latency to short OLTP queries
});

export type Db = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T[]> {
  const res = await db.query<T>(text, params as any[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

/** Run `fn` inside one transaction; rolls back on any thrown error. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Collects positional parameters while building dynamic (but always parameterised) SQL. */
export class Params {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}
