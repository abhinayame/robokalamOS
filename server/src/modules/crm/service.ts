import { exec, newId, query, queryOne, type Db } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { notifyUsers } from '../../lib/notify.js';

export const ACTIVITY_TYPES = [
  'called_parent', 'called_learner', 'whatsapp_sent', 'email_sent', 'demo_scheduled', 'demo_attended', 'follow_up', 'fee_discussion',
  'admission_confirmed', 'batch_assigned', 'counsellor_assigned', 'status_changed', 'note', 'other',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Lead statuses that end the pipeline: open follow-ups are cancelled when a lead lands here. */
export const CLOSED_STATUSES = ['converted', 'not_interested', 'lost'];

export async function logCrmActivity(db: Db, a: { orgId: string; learnerId: string; type: string; description?: string | null; staffId?: string | null; nextFollowUpAt?: Date | null }) {
  const id = newId();
  await exec(`INSERT INTO crm_activities (id, org_id, learner_id, type, description, staff_user_id, next_follow_up_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, a.orgId, a.learnerId, a.type, a.description ?? null, a.staffId ?? null, a.nextFollowUpAt ?? null], db);
  return id;
}

/** The lead's "next follow-up" is always the earliest OPEN follow-up (or empty). */
export async function syncNextFollowUp(db: Db, learnerId: string) {
  await exec(`UPDATE crm_leads SET next_follow_up_at = (SELECT MIN(due_at) FROM follow_ups WHERE learner_id = $1 AND status = 'open') WHERE learner_id = $1`, [learnerId], db);
}

export async function assertAssignable(db: Db, orgId: string, userId: string) {
  const u = await queryOne(
    `SELECT u.id FROM users u WHERE u.id = $1 AND u.org_id = $2 AND u.status = 'active' AND u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code IN ('counsellor','org_admin','branch_admin'))`, [userId, orgId], db);
  if (!u) throw badRequest('That person cannot be assigned CRM work. Choose a counsellor or admin.', [{ field: 'assigned_to', message: 'Choose a counsellor or admin.' }]);
}

export async function createFollowUp(db: Db, a: { orgId: string; learnerId: string; learnerName?: string; assignedTo: string; dueAt: Date; note?: string | null; actorId: string; quiet?: boolean }) {
  if (!a.quiet) await assertAssignable(db, a.orgId, a.assignedTo);   // quiet = a bulk caller already checked once and sends one summary
  const id = newId();
  await exec(`INSERT INTO follow_ups (id, org_id, learner_id, assigned_to, due_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, a.orgId, a.learnerId, a.assignedTo, a.dueAt, a.note ?? null, a.actorId], db);
  await syncNextFollowUp(db, a.learnerId);
  if (!a.quiet && a.assignedTo !== a.actorId) await notifyUsers(db, { orgId: a.orgId, userIds: [a.assignedTo], kind: 'followup.assigned', title: `Follow-up assigned${a.learnerName ? `: ${a.learnerName}` : ''}`, body: `${a.note ? `${a.note} · ` : ''}due ${a.dueAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, link: `/learners/${a.learnerId}`, learnerId: null });
  return id;
}

/** Create the lead row if the learner has none (idempotent; a lead IS the learner profile). Returns true if created. */
export async function ensureLead(db: Db, a: { orgId: string; learnerId: string; actorId?: string | null; fields?: Record<string, unknown> }) {
  const f = a.fields ?? {};
  try {
    await exec(`INSERT INTO crm_leads (id, org_id, learner_id, lead_source, lead_status, temperature, counsellor_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), a.orgId, a.learnerId, f.lead_source ?? null, f.lead_status ?? 'new', f.temperature ?? null, f.counsellor_user_id ?? null, a.actorId ?? null], db);
    return true;
  } catch (e: any) { if (e?.errno === 1062) return false; throw e; }
}

export const tagsOf = async (learnerId: string, db?: Db) =>
  query(`SELECT t.id, t.name, t.color FROM learner_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.learner_id = $1 ORDER BY t.name`, [learnerId], db);
