import { env } from '../config/env.js';
import { exec, newId, queryOne } from '../db/pool.js';
import { hashPassword, passwordProblem } from './security.js';

/** Creates the platform owner from SUPER_ADMIN_* env if no such user exists yet. Idempotent. */
export async function ensureSuperAdmin(log: (m: string) => void = console.log): Promise<'created' | 'exists' | 'skipped'> {
  const email = env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) return 'skipped';
  if (await queryOne(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [email])) return 'exists';
  const problem = passwordProblem(password);
  if (problem) { log(`SUPER_ADMIN_PASSWORD not used: ${problem}`); return 'skipped'; }
  const id = newId();
  await exec(`INSERT INTO users (id, org_id, email, password_hash, full_name) VALUES ($1,NULL,$2,$3,'Platform Owner')`, [id, email, await hashPassword(password)]);
  await exec(`INSERT INTO user_roles (id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE code = 'super_admin'`, [newId(), id]);
  log(`Super admin created: ${email}`);
  return 'created';
}
