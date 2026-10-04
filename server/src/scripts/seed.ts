import { env } from '../config/env.js';
import { pool, query, queryOne } from '../db/pool.js';
import { hashPassword, passwordProblem } from '../lib/security.js';

/** Creates the platform super admin (idempotent). Run once after the first migration. */
async function main() {
  const email = env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD first.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(`SUPER_ADMIN_PASSWORD: ${problem}`);
  const existing = await queryOne(`SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [email]);
  if (existing) { console.log('Super admin already exists — nothing to do.'); return; }
  const u = await queryOne(`INSERT INTO users (org_id, email, password_hash, full_name) VALUES (NULL,$1,$2,'Platform Owner') RETURNING id`, [email, await hashPassword(password)]);
  await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'super_admin'`, [u!.id]);
  console.log(`Super admin created: ${email}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
