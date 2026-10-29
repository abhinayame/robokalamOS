import { pool, query, queryOne, type Db } from '../../db/pool.js';
import { notifyAbout, notifyUsers } from '../../lib/notify.js';
import { enrollInCourse, resolveStaff } from './service.js';

/**
 * Auto-assign rules: "everyone who becomes a teacher takes Welcome to the team", "everyone in this batch takes Robotics basics".
 * A rule enrols a person once; it never re-enrols someone who was taken off the course on purpose (the removed row keeps them out only while they
 * are removed, so a rule re-run on an existing person is a no-op and a new joiner is picked up).
 */
interface Rule { id: string; org_id: string; course_id: string; kind: 'role' | 'batch'; ref: string; due_days: number | null }
const dueFrom = (days: number | null) => (days ? new Date(Date.now() + days * 86400_000) : null);

async function enrolPeople(db: Db, rule: Rule, c: { title: string; audience: string }, who: { userIds?: string[]; learnerIds?: string[] }) {
  let users = 0, learners = 0; const due = dueFrom(rule.due_days);
  for (const uid of who.userIds ?? []) if (await enrollInCourse(db, { orgId: rule.org_id, courseId: rule.course_id, who: { userId: uid, learnerId: null }, assignedBy: null, dueAt: due, source: 'auto' })) { users++; await notifyUsers(db, { orgId: rule.org_id, userIds: [uid], kind: 'lms.assigned', title: `New course: ${c.title}`, body: due ? `Please finish by ${due.toISOString().slice(0, 10)}.` : 'Start whenever you are ready.', link: '/learn' }); }
  const fresh: string[] = [];
  for (const lid of who.learnerIds ?? []) if (await enrollInCourse(db, { orgId: rule.org_id, courseId: rule.course_id, who: { userId: null, learnerId: lid }, assignedBy: null, dueAt: due, source: 'auto' })) { learners++; fresh.push(lid); }
  if (fresh.length) await notifyAbout(db, { orgId: rule.org_id, learnerIds: fresh, kind: 'lms.assigned', title: `New course: ${c.title}`, body: due ? `Please finish by ${due.toISOString().slice(0, 10)}.` : 'Start whenever you are ready.', link: '/learn' });
  return { users, learners };
}
const liveCourse = (db: Db, id: string) => queryOne(`SELECT id, title, audience FROM lms_courses WHERE id = $1 AND status = 'published' AND deleted_at IS NULL`, [id], db);

/** Run one rule over everyone it covers right now (used by "Apply now"). */
export async function applyRule(db: Db, rule: Rule) {
  const c = await liveCourse(db, rule.course_id); if (!c) return { users: 0, learners: 0, skipped: 'not_published' as const };
  if (rule.kind === 'role') { if (c.audience === 'learners') return { users: 0, learners: 0 }; return enrolPeople(db, rule, c, { userIds: await resolveStaff(db, rule.org_id, { roles: [rule.ref] }) }); }
  if (c.audience === 'staff') return { users: 0, learners: 0 };
  const ids = (await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active' AND org_id = $2`, [rule.ref, rule.org_id], db)).map((r) => r.learner_id as string);
  return enrolPeople(db, rule, c, { learnerIds: ids });
}
/** A staff member just got these roles: take every matching rule. Call inside the same transaction. */
export async function autoEnrolStaff(db: Db, orgId: string, userId: string, roles: string[]) {
  if (!roles.length) return 0; let n = 0;
  const rules = await query(`SELECT * FROM lms_auto_rules WHERE org_id = $1 AND kind = 'role' AND ref IN (${roles.map((_, i) => `$${i + 2}`).join(',')})`, [orgId, ...roles], db) as Rule[];
  for (const r of rules) { const c = await liveCourse(db, r.course_id); if (!c || c.audience === 'learners') continue; n += (await enrolPeople(db, r, c, { userIds: [userId] })).users; }
  return n;
}
/** Learners just joined a batch: take every matching rule. Call inside the same transaction. */
export async function autoEnrolLearners(db: Db, orgId: string, batchId: string, learnerIds: string[]) {
  if (!learnerIds.length) return 0; let n = 0;
  const rules = await query(`SELECT * FROM lms_auto_rules WHERE org_id = $1 AND kind = 'batch' AND ref = $2`, [orgId, batchId], db) as Rule[];
  for (const r of rules) { const c = await liveCourse(db, r.course_id); if (!c || c.audience === 'staff') continue; n += (await enrolPeople(db, r, c, { learnerIds })).learners; }
  return n;
}

// ------------------------------------------------------------------ due-soon and overdue reminders
/** Every pass is safe to repeat: a person hears about a course at most once every 3 days (due soon) or 7 days (overdue). */
export async function runLmsReminders() {
  const out = { due_soon: 0, overdue: 0 };
  for (const [kind, cond, gap, title, body] of [
    ['lms.due_soon', `e.due_at > NOW(3) AND e.due_at <= DATE_ADD(NOW(3), INTERVAL 2 DAY)`, 3, 'is due soon', 'Finish it before the due date. You can pick up where you left off.'],
    ['lms.overdue', `e.due_at <= DATE_SUB(NOW(3), INTERVAL 1 DAY)`, 7, 'is overdue', 'This course is past its due date. Please finish it when you can.'],
  ] as const) {
    const rows = await query(`SELECT e.id, e.org_id, e.course_id, e.user_id, e.learner_id, c.title FROM lms_enrollments e JOIN lms_courses c ON c.id = e.course_id AND c.deleted_at IS NULL AND c.status = 'published'
        WHERE e.status = 'active' AND e.due_at IS NOT NULL AND ${cond} AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.kind = '${kind}' AND n.link = CONCAT('/learn/', e.course_id) AND (n.learner_id <=> e.learner_id) AND (e.learner_id IS NOT NULL OR n.user_id = e.user_id) AND n.created_at > DATE_SUB(NOW(3), INTERVAL ${gap} DAY)) LIMIT 500`);
    for (const r of rows) {
      const note = { kind, title: `“${r.title}” ${title}`, body, link: `/learn/${r.course_id}` };
      if (r.learner_id) await notifyAbout(pool, { orgId: r.org_id, learnerIds: [r.learner_id], ...note });
      else await notifyUsers(pool, { orgId: r.org_id, userIds: [r.user_id], ...note });
      out[kind === 'lms.due_soon' ? 'due_soon' : 'overdue']++;
    }
  }
  return out;
}
let timer: NodeJS.Timeout | null = null; let busy = false;
export function startLmsReminders() {
  if (timer || process.env.LMS_REMINDERS === 'false') return;
  timer = setInterval(async () => { if (busy) return; busy = true; try { await runLmsReminders(); } catch { /* next pass retries */ } finally { busy = false; } }, 3600_000); timer.unref();
}
export function stopLmsReminders() { if (timer) clearInterval(timer); timer = null; }
