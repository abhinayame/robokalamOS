import { env } from '../config/env.js';
import { exec, newId, pool, queryOne } from '../db/pool.js';
import { hashPassword, passwordProblem } from '../lib/security.js';

/** Creates the platform super admin (idempotent). Run once after the first migration. */
async function main() {
  const email = env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD first.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(`SUPER_ADMIN_PASSWORD: ${problem}`);
  const existing = await queryOne(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
  if (existing) { console.log('Super admin already exists — nothing to do.'); return; }
  const id = newId();
  await exec(`INSERT INTO users (id, org_id, email, password_hash, full_name) VALUES ($1,NULL,$2,$3,'Platform Owner')`, [id, email, await hashPassword(password)]);
  await exec(`INSERT INTO user_roles (id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE code = 'super_admin'`, [newId(), id]);
  console.log(`Super admin created: ${email}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
