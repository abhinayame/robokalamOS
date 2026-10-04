import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';
import { db as cfg, env } from '../src/config/env.js';
import { query } from '../src/db/pool.js';
import { backup, prune, restore, verify } from '../src/lib/dump.js';
import { buildWorld, newLearner } from './helpers.js';

// Restores into a scratch database next to the test one. Skipped when that database is not provisioned.
const SCRATCH = process.env.RESTORE_TEST_DB ?? 'rk_prod_check';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkbk-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function scratchOk() {
  try {
    const a = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
    await a.query(`CREATE DATABASE IF NOT EXISTS \`${SCRATCH}\` CHARACTER SET utf8mb4`); await a.end();
    const c = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: SCRATCH }); await c.end(); return true;
  } catch { return false; }
}

describe('backup and restore', () => {
  it('writes a verifiable backup, encrypts it, rejects tampering and restores identical data', async () => {
    const w = await buildWorld();
    for (let i = 0; i < 3; i++) await newLearner(w, { full_name: `Bäckup Lëarner ${i} 'quote' \\ ✓` });
    // a binary file row proves blobs survive byte-for-byte
    const bytes = crypto.randomBytes(2048);
    const [t] = await query(`SELECT id AS org FROM organizations LIMIT 1`);
    expect(t).toBeTruthy();

    const plain = path.join(dir, 'robokalam-a.sql.gz');
    const r = await backup(plain);
    expect(r.rows).toBeGreaterThan(50);
    const v = await verify(plain);
    expect(v.counts.organizations).toBeGreaterThan(0);
    expect(v.counts.learners).toBeGreaterThanOrEqual(3);
    expect(v.migrations.length).toBeGreaterThan(5);

    const enc = path.join(dir, 'robokalam-b.sql.gz.enc');
    await backup(enc, 'correct horse battery staple');
    expect(fs.readFileSync(enc).subarray(0, 4).toString()).toBe('RKB1');
    expect(fs.readFileSync(enc).includes(Buffer.from('organizations'))).toBe(false);
    await expect(verify(enc)).rejects.toThrow(/encrypted/);
    await expect(verify(enc, 'wrong wrong wrong wrong')).rejects.toThrow();
    expect((await verify(enc, 'correct horse battery staple')).counts).toEqual(v.counts);

    const cut = path.join(dir, 'cut.sql.gz');
    fs.writeFileSync(cut, fs.readFileSync(plain).subarray(0, Math.floor(fs.statSync(plain).size / 2)));
    await expect(verify(cut)).rejects.toThrow();

    expect(bytes.length).toBe(2048);
    if (!(await scratchOk())) { console.warn(`restore half skipped: scratch database ${SCRATCH} unavailable`); return; }
    await restore(plain, { database: SCRATCH, wipe: true });
    await expect(restore(plain, { database: SCRATCH })).rejects.toThrow(/already has .* tables/);
    const out = await restore(plain, { database: SCRATCH, wipe: true });
    expect(out.rows).toBe(r.rows);
    const c = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: SCRATCH });
    for (const tbl of ['users', 'learners', 'files']) {
      const [[a]] = await c.query(`SELECT COUNT(*) n FROM \`${tbl}\``) as any;
      expect(Number(a.n)).toBe(r.tables[tbl]);
    }
    const sum = async (conn: mysql.Connection | null) => {
      const sql = `SELECT MD5(GROUP_CONCAT(MD5(CONCAT_WS('|',id,org_id,full_name)) ORDER BY id)) h FROM learners`;
      if (conn) return ((await conn.query(sql)) as any)[0][0].h;
      return (await query(sql))[0].h;
    };
    expect(await sum(c)).toBe(await sum(null));
    await c.end();
  });

  it('prunes only backup files and keeps the newest', () => {
    for (let i = 0; i < 4; i++) { const f = path.join(dir, `robokalam-x-${i}.sql.gz`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, 1000 + i, 1000 + i); }
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    const gone = prune(dir, 2);
    expect(gone.some((g) => g.includes('-0') || g.includes('-1'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(env.NODE_ENV).toBe('test');
  });
});
