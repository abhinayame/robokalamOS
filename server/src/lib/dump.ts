import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable, pipeline as pipe } from 'node:stream';
import mysql from 'mysql2';
import mysqlP from 'mysql2/promise';
import { db as dbConfig, env } from '../config/env.js';

/**
 * Logical backup and restore without mysqldump (which shared hosting often does not provide to the app).
 * Format: one SQL statement per line, gzip-compressed, optionally AES-256-GCM encrypted with BACKUP_PASSPHRASE.
 * A backup is a single consistent snapshot of every table, so rows never disagree with each other.
 */
const MAGIC = Buffer.from('RKB1');
const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double', 'year']);
const BLOBS = new Set(['blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary']);
const q = (id: string) => `\`${id.replace(/`/g, '``')}\``;

const baseOptions = (database: string) => ({ host: dbConfig.host, port: dbConfig.port, user: dbConfig.user, password: dbConfig.password, database, charset: 'UTF8MB4_UNICODE_CI', timezone: 'Z', dateStrings: true, ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined, supportBigNumbers: true, bigNumberStrings: true });

function key(pass: string, salt: Buffer) { return crypto.scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }); }

export interface BackupResult { file: string; bytes: number; tables: Record<string, number>; rows: number; seconds: number; encrypted: boolean; migrations: number }

export async function backup(outFile: string, passphrase?: string): Promise<BackupResult> {
  const t0 = Date.now();
  const conn = mysql.createConnection(baseOptions(dbConfig.database));
  const p = conn.promise();
  await p.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await p.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  const [tabs] = await p.query(`SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`) as [any[], unknown];
  const [cols] = await p.query(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d, EXTRA AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`) as [any[], unknown];

  const lines = new PassThrough();
  const salt = passphrase ? crypto.randomBytes(16) : null; const iv = passphrase ? crypto.randomBytes(12) : null;
  const cipher = passphrase ? crypto.createCipheriv('aes-256-gcm', key(passphrase, salt!), iv!) : null;
  const out = fs.createWriteStream(outFile, { mode: 0o600 });
  if (passphrase) out.write(Buffer.concat([MAGIC, salt!, iv!]));
  const done = pipeline(lines, createGzip({ level: 6 }), ...(cipher ? [cipher] : []), out);
  const push = async (s: string) => { if (!lines.write(s + '\n')) await once(lines, 'drain'); };

  const [mig] = await p.query('SELECT name FROM schema_migrations ORDER BY name') as [any[], unknown];
  await push('-- robokalam-backup v1');
  await push(`-- created ${new Date().toISOString()} · database ${dbConfig.database}`);
  await push(`-- migrations ${mig.map((m: any) => m.name).join(',')}`);
  await push('SET NAMES utf8mb4;'); await push("SET time_zone = '+00:00';"); await push('SET FOREIGN_KEY_CHECKS = 0;'); await push("SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';");
  const counts: Record<string, number> = {}; let rows = 0;

  for (const { t } of tabs) {
    const tc = (cols as any[]).filter((c) => c.t === t);
    const keep = tc.filter((c) => !/GENERATED/i.test(c.x ?? ''));                        // stored/virtual generated columns are recomputed on restore
    const [[create]] = await p.query(`SHOW CREATE TABLE ${q(t)}`) as [any[], unknown];
    await push(`DROP TABLE IF EXISTS ${q(t)};`);
    await push(String(create['Create Table']).replace(/\s*\n\s*/g, ' ') + ';');
    const colList = keep.map((c) => q(c.c)).join(',');
    const lit = (v: any, type: string): string => {
      if (v === null || v === undefined) return 'NULL';
      if (Buffer.isBuffer(v)) return v.length ? `X'${v.toString('hex')}'` : "''";
      const s = String(v);
      if (NUMERIC.has(type) && /^-?\d+(\.\d+)?$/.test(s)) return s;
      return mysql.escape(s);
    };
    const stream = conn.query({ sql: `SELECT ${colList} FROM ${q(t)}`, rowsAsArray: true, typeCast: (field: any, next: () => unknown) => (BLOBS.has(String(field.type).toLowerCase()) || field.type === 'BLOB' ? field.buffer() : field.type === 'JSON' ? field.string() : next()) } as any).stream({ highWaterMark: 200 });
    let batch: string[] = []; let size = 0; let n = 0;
    const flush = async () => { if (batch.length) { await push(`INSERT INTO ${q(t)} (${colList}) VALUES ${batch.join(',')};`); batch = []; size = 0; } };
    for await (const row of stream as AsyncIterable<any[]>) {
      const v = '(' + row.map((x, i) => lit(x, keep[i].d)).join(',') + ')';
      batch.push(v); size += v.length; n++;
      if (batch.length >= 400 || size > 900_000) await flush();
    }
    await flush();
    counts[t] = n; rows += n;
  }
  await push('SET FOREIGN_KEY_CHECKS = 1;');
  await push(`-- @counts ${JSON.stringify(counts)}`);
  await push('-- @end');
  lines.end();
  await done;
  if (cipher) fs.appendFileSync(outFile, cipher.getAuthTag());
  await p.query('ROLLBACK'); conn.end();
  return { file: outFile, bytes: fs.statSync(outFile).size, tables: counts, rows, seconds: Math.round((Date.now() - t0) / 100) / 10, encrypted: !!passphrase, migrations: mig.length };
}

/** Plain gzip stream of the backup's lines, decrypting first when needed. Encrypted backups are authenticated at the very end. */
function open(file: string, passphrase?: string): { stream: Readable; finished: () => Promise<void> } {
  const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0);
  const size = fs.fstatSync(fd).size;
  if (head.equals(MAGIC)) {
    if (!passphrase) { fs.closeSync(fd); throw new Error('This backup is encrypted. Set BACKUP_PASSPHRASE to the passphrase it was made with.'); }
    const hdr = Buffer.alloc(32); fs.readSync(fd, hdr, 0, 32, 0);
    const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
    const d = crypto.createDecipheriv('aes-256-gcm', key(passphrase, hdr.subarray(4, 20)), hdr.subarray(20, 32)); d.setAuthTag(tag);
    const s = pipe(fs.createReadStream(file, { start: 32, end: size - 17 }), d, createGunzip(), () => undefined) as unknown as Readable;
    return { stream: s, finished: async () => undefined };
  }
  fs.closeSync(fd);
  return { stream: pipe(fs.createReadStream(file), createGunzip(), () => undefined) as unknown as Readable, finished: async () => undefined };
}

async function* statements(stream: Readable) {
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) yield line; }
  }
  if (buf) yield buf;
}

/** Reads the whole backup without changing anything: proves the file is complete and untampered before a restore starts. */
export async function verify(file: string, passphrase?: string) {
  let counts: Record<string, number> | null = null; let ended = false; let lines = 0; let created = ''; let migrations = '';
  for await (const line of statements(open(file, passphrase).stream)) {
    lines++;
    if (line.startsWith('-- created')) created = line.slice(11);
    else if (line.startsWith('-- migrations')) migrations = line.slice(14);
    else if (line.startsWith('-- @counts ')) counts = JSON.parse(line.slice(11));
    else if (line === '-- @end') ended = true;
  }
  if (!ended || !counts) throw new Error('The backup is incomplete (missing end marker). It was probably cut short; do not restore from it.');
  return { counts, lines, created, migrations: migrations ? migrations.split(',') : [] };
}

export async function restore(file: string, opts: { database: string; passphrase?: string; wipe?: boolean }) {
  const info = await verify(file, opts.passphrase);                       // pass 1: nothing is touched until the file checks out
  const admin = await mysqlP.createConnection({ ...baseOptions(opts.database), multipleStatements: false });
  try {
    const [existing] = await admin.query(`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`) as [any[], unknown];
    if (existing[0].n > 0 && !opts.wipe) throw new Error(`Database "${opts.database}" already has ${existing[0].n} tables. Restore into an empty database, or pass --wipe together with --confirm-database ${opts.database} to replace its contents.`);
    let applied = 0;
    for await (const line of statements(open(file, opts.passphrase).stream)) {      // pass 2: apply
      if (line.startsWith('--')) continue;
      await admin.query(line); applied++;
    }
    const mismatches: string[] = [];
    for (const [t, n] of Object.entries(info.counts)) {
      const [r] = await admin.query(`SELECT COUNT(*) AS n FROM ${q(t)}`) as [any[], unknown];
      if (Number(r[0].n) !== n) mismatches.push(`${t}: expected ${n}, found ${r[0].n}`);
    }
    if (mismatches.length) throw new Error(`Restore finished but row counts differ:\n  ${mismatches.join('\n  ')}`);
    return { statements: applied, tables: Object.keys(info.counts).length, rows: Object.values(info.counts).reduce((a, b) => a + b, 0), created: info.created };
  } finally { await admin.end(); }
}

export function prune(dir: string, keep: number) {
  const files = fs.readdirSync(dir).filter((f) => /^robokalam-.*\.sql\.gz(\.enc)?$/.test(f)).map((f) => ({ f, t: fs.statSync(`${dir}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t);
  const old = files.slice(keep); old.forEach((o) => fs.unlinkSync(`${dir}/${o.f}`)); return old.map((o) => o.f);
}
