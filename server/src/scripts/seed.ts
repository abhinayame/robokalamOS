import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { ensureSuperAdmin } from '../lib/bootstrap.js';

/** Creates the platform super admin (idempotent). Also runs automatically on server start. */
async function main() {
  if (!env.SUPER_ADMIN_EMAIL || !env.SUPER_ADMIN_PASSWORD) throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD first.');
  const r = await ensureSuperAdmin();
  if (r === 'exists') console.log('Super admin already exists — nothing to do.');
  if (r === 'skipped') throw new Error('Super admin was not created (see the message above).');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
