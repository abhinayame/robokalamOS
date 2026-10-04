import fs from 'node:fs';
import path from 'node:path';
import { db } from '../config/env.js';
import { backup, prune } from '../lib/dump.js';

/**
 * Consistent logical backup of the whole database.
 *   node dist/scripts/backup.js --out ~/backups --keep 14
 * Set BACKUP_PASSPHRASE to encrypt it (recommended: it contains personal data of children). Never put the passphrase in git.
 */
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
async function main() {
  const dir = path.resolve(arg('out') ?? './backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pass = process.env.BACKUP_PASSPHRASE?.trim() || undefined;
  if (pass && pass.length < 12) throw new Error('BACKUP_PASSPHRASE must be at least 12 characters.');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(dir, `robokalam-${db.database}-${stamp}.sql.gz${pass ? '.enc' : ''}`);
  const r = await backup(file, pass);
  console.log(`Backup written: ${r.file}\n  ${(r.bytes / 1048576).toFixed(2)} MB · ${r.rows.toLocaleString('en-IN')} rows · ${Object.keys(r.tables).length} tables · ${r.seconds}s · ${r.encrypted ? 'encrypted' : 'NOT encrypted (set BACKUP_PASSPHRASE)'}`);
  const keep = Number(arg('keep') ?? 0);
  if (keep > 0) { const gone = prune(dir, keep); if (gone.length) console.log(`  removed ${gone.length} older backup(s), keeping ${keep}`); }
}
main().catch((e) => { console.error(`Backup failed: ${e.message}`); process.exitCode = 1; });
