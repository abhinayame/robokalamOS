import { db } from '../config/env.js';
import { restore, verify } from '../lib/dump.js';

/**
 * Restore a backup made by backup.js.
 *   node dist/scripts/restore.js FILE --verify-only                 check the file only
 *   DB_NAME=restore_test node dist/scripts/restore.js FILE          into an EMPTY database (the safe drill)
 *   node dist/scripts/restore.js FILE --wipe --confirm-database NAME   replace the contents of NAME (typed confirmation)
 */
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) throw new Error('Usage: restore.js FILE [--verify-only] [--wipe --confirm-database NAME]');
  const pass = process.env.BACKUP_PASSPHRASE?.trim() || undefined;
  if (process.argv.includes('--verify-only')) {
    const v = await verify(file, pass);
    console.log(`Backup is complete and readable: made ${v.created}, ${Object.keys(v.counts).length} tables, ${Object.values(v.counts).reduce((a, b) => a + b, 0).toLocaleString('en-IN')} rows, ${v.migrations.length} migrations.`);
    return;
  }
  const wipe = process.argv.includes('--wipe');
  if (wipe && arg('confirm-database') !== db.database) throw new Error(`--wipe replaces everything in "${db.database}". Re-run with --confirm-database ${db.database} to confirm.`);
  const r = await restore(file, { database: db.database, passphrase: pass, wipe });
  console.log(`Restored into "${db.database}": ${r.tables} tables, ${r.rows.toLocaleString('en-IN')} rows (backup made ${r.created}). Row counts match the backup.`);
}
main().catch((e) => { console.error(`Restore failed: ${e.message}`); process.exitCode = 1; });
