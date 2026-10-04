import type { Request } from 'express';
import { query, type Db } from '../db/pool.js';
import type { AuthUser } from '../middleware/auth.js';

export interface AuditInput {
  orgId: string | null;
  actor?: Pick<AuthUser, 'id' | 'email'> | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  previous?: unknown;
  next?: unknown;
  req?: Request;
}

/** Pass the transaction client as `db` so the audit row commits atomically with the change. */
export async function audit(a: AuditInput, db?: Db) {
  await query(
    `INSERT INTO audit_logs (org_id, actor_user_id, actor_email, action, entity_type, entity_id, previous_data, new_data, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      a.orgId, a.actor?.id ?? null, a.actor?.email ?? null, a.action, a.entityType, a.entityId ?? null,
      a.previous === undefined ? null : JSON.stringify(a.previous),
      a.next === undefined ? null : JSON.stringify(a.next),
      a.req?.ip ?? null, a.req?.get('user-agent')?.slice(0, 300) ?? null,
    ],
    db,
  );
}
