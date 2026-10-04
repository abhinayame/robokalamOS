import { exec, type Db } from '../db/pool.js';

export interface ActivityInput {
  orgId: string;
  learnerId: string;
  batchId?: string | null;
  type: string;
  title: string;
  description?: string | null;
  meta?: Record<string, unknown>;
  actorUserId?: string | null;
}

export async function recordActivity(db: Db, a: ActivityInput) {
  await exec(
    `INSERT INTO learner_activity (org_id, learner_id, batch_id, type, title, description, meta, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.orgId, a.learnerId, a.batchId ?? null, a.type, a.title, a.description ?? null, JSON.stringify(a.meta ?? {}), a.actorUserId ?? null],
    db,
  );
}
