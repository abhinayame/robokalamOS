import { Params, exec, newId, query, type Db } from '../db/pool.js';

export interface NotifyInput { orgId: string; learnerIds: string[]; kind: string; title: string; body?: string | null; link?: string | null; excludeUserId?: string | null }

/**
 * In-app notification to everyone who follows these learners: the learner's own login and every linked
 * parent login. One row per recipient per learner (a parent of two children sees which child it is about).
 * Call inside the same transaction as the change that caused it.
 */
export async function notifyAbout(db: Db, n: NotifyInput) {
  const ids = [...new Set(n.learnerIds)];
  if (!ids.length) return 0;
  let sent = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const p = new Params();
    const rows = await query(
      `SELECT l.id AS learner_id, l.user_id AS user_id FROM learners l WHERE l.id IN ${p.in(ids.slice(i, i + 500))} AND l.user_id IS NOT NULL
       UNION
       SELECT lp.learner_id, pa.user_id FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL AND pa.user_id IS NOT NULL
        WHERE lp.learner_id IN ${p.in(ids.slice(i, i + 500))}`, p.values, db);
    for (const r of rows) {
      if (r.user_id === n.excludeUserId) continue;
      await exec(`INSERT INTO notifications (id, org_id, user_id, learner_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId(), n.orgId, r.user_id, r.learner_id, n.kind, n.title.slice(0, 255), n.body?.slice(0, 1000) ?? null, n.link ?? null], db);
      sent++;
    }
  }
  return sent;
}

/** In-app notification straight to staff users (e.g. a follow-up assigned to a counsellor). */
export async function notifyUsers(db: Db, n: { orgId: string; userIds: string[]; kind: string; title: string; body?: string | null; link?: string | null; learnerId?: string | null }) {
  for (const uid of [...new Set(n.userIds)]) {
    await exec(`INSERT INTO notifications (id, org_id, user_id, learner_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), n.orgId, uid, n.learnerId ?? null, n.kind, n.title.slice(0, 255), n.body?.slice(0, 1000) ?? null, n.link ?? null], db);
  }
}
