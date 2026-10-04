import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { poolOptions } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db → ../../migrations   and   dist/db → ../../migrations
const dir = path.resolve(here, '../../migrations');

/**
 * Applies pending migrations in order. MySQL cannot roll back DDL, so a migration is
 * recorded only after it fully succeeds; keep each file small and re-runnable if it fails midway.
 */
export async function migrate(log: (m: string) => void = console.log): Promise<string[]> {
  const conn = await mysql.createConnection({ ...poolOptions(), multipleStatements: true } as any);
  const applied: string[] = [];
  try {
    const [[lock]]: any = await conn.query("SELECT GET_LOCK('robokalam_migrate', 60) AS got");
    if (lock.got !== 1) throw new Error('Could not obtain the migration lock (another migration is running).');
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const [rows]: any = await conn.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r: any) => r.name));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      log(`applying ${f}`);
      await conn.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
      applied.push(f);
    }
  } finally {
    try { await conn.query("SELECT RELEASE_LOCK('robokalam_migrate')"); } catch { /* ignore */ }
    await conn.end();
  }
  return applied;
}
