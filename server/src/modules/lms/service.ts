import { exec, newId, query, queryOne, type Db } from '../../db/pool.js';
import { notifyAbout, notifyUsers } from '../../lib/notify.js';
import { issueCertificate } from '../certificates/service.js';

/** Where an enrollment stands: required lessons done over required lessons, as whole percent. */
export async function standing(enrollmentId: string, courseId: string, db?: Db) {
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = $1 AND required = TRUE AND deleted_at IS NULL`, [courseId], db))!.n);
  const done = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_progress p JOIN lms_lessons l ON l.id = p.lesson_id AND l.deleted_at IS NULL AND l.required = TRUE WHERE p.enrollment_id = $1 AND p.completed_at IS NOT NULL`, [enrollmentId], db))!.n);
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * Called after every finished lesson. When every required lesson is done the enrollment is completed once (and stays completed even
 * if lessons are added later), and a learner whose course names a certificate design receives it automatically.
 */
export async function afterProgress(db: Db, enr: { id: string; org_id: string; course_id: string; learner_id: string | null; user_id?: string | null; completed_at: any }) {
  const st = await standing(enr.id, enr.course_id, db);
  await exec(`UPDATE lms_enrollments SET last_activity_at = NOW(3), started_at = COALESCE(started_at, NOW(3)) WHERE id = $1`, [enr.id], db);
  let justCompleted = false; let certificateCode: string | null = null;
  if (!enr.completed_at && st.total > 0 && st.done >= st.total) {
    const r = await exec(`UPDATE lms_enrollments SET status = 'completed', completed_at = NOW(3) WHERE id = $1 AND completed_at IS NULL`, [enr.id], db);
    justCompleted = r.affectedRows > 0;
    if (justCompleted && enr.learner_id) {
      const course = await queryOne(`SELECT id, title, certificate_design_id FROM lms_courses WHERE id = $1`, [enr.course_id], db);
      const design = course?.certificate_design_id ? await queryOne(`SELECT * FROM certificate_designs WHERE id = $1 AND org_id = $2 AND status = 'active'`, [course.certificate_design_id, enr.org_id], db) : null;
      if (design) {
        const learner = await queryOne(`SELECT id, full_name FROM learners WHERE id = $1`, [enr.learner_id], db);
        const org = await queryOne(`SELECT name FROM organizations WHERE id = $1`, [enr.org_id], db);
        const id = await issueCertificate(db, { orgId: enr.org_id, orgName: org?.name ?? '', design, learner: learner!, date: new Date().toISOString().slice(0, 10), issuedBy: null, courseName: course!.title });
        if (id) certificateCode = (await queryOne(`SELECT code FROM certificates WHERE id = $1`, [id], db))?.code ?? null;
      }
    }
  }
  let path: { unlocked: string[]; finished: string[] } = { unlocked: [], finished: [] };
  if (justCompleted) {
    path = await advancePaths(db, { org_id: enr.org_id, course_id: enr.course_id, user_id: enr.user_id ?? null, learner_id: enr.learner_id });
    const msg = path.unlocked.length ? { title: `Next step unlocked: ${path.unlocked[0]}`, body: 'You finished a course, so the next one on your path is ready.', link: '/learn' }
      : path.finished.length ? { title: `You finished the path: ${path.finished[0]}`, body: 'Well done, every course on the path is complete.', link: '/learn' } : null;
    if (msg && enr.learner_id) await notifyAbout(db, { orgId: enr.org_id, learnerIds: [enr.learner_id], kind: 'lms.path', ...msg });
    else if (msg && enr.user_id) await notifyUsers(db, { orgId: enr.org_id, userIds: [enr.user_id], kind: 'lms.path', ...msg });
  }
  return { ...st, justCompleted, certificateCode, completed: !!enr.completed_at || justCompleted, path };
}

// ------------------------------------------------------------------ learning paths
type Who = { userId: string | null; learnerId: string | null };
const whoKey = (w: Who) => (w.userId ?? w.learnerId)!;

/** Enrol one person in a course (a no-op when they already are). Returns true when a new enrollment was made. */
export async function enrollInCourse(db: Db, o: { orgId: string; courseId: string; who: Who; assignedBy: string | null; dueAt: Date | null }) {
  const have = await queryOne(`SELECT 1 FROM lms_enrollments WHERE course_id = $1 AND person_key = $2`, [o.courseId, whoKey(o.who)], db);
  if (have) return false;
  await exec(`INSERT INTO lms_enrollments (id, org_id, course_id, user_id, learner_id, assigned_by, due_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [newId(), o.orgId, o.courseId, o.who.userId, o.who.learnerId, o.assignedBy, o.dueAt], db);
  return true;
}

/**
 * Move a person along every path they are walking that contains the course they just finished: unlock the first later course they have not
 * finished (published ones only), or mark the path done when nothing is left. Returns what changed so the caller can say so.
 */
export async function advancePaths(db: Db, enr: { org_id: string; course_id: string; user_id: string | null; learner_id: string | null }) {
  const who: Who = { userId: enr.user_id, learnerId: enr.learner_id }; const out: { unlocked: string[]; finished: string[] } = { unlocked: [], finished: [] };
  const members = await query(`SELECT m.id, m.path_id, m.due_days, p.title AS path_title, pc.position FROM lms_path_members m JOIN lms_paths p ON p.id = m.path_id AND p.deleted_at IS NULL AND p.status = 'published'
      JOIN lms_path_courses pc ON pc.path_id = m.path_id AND pc.course_id = $1 WHERE m.org_id = $2 AND m.person_key = $3 AND m.completed_at IS NULL`, [enr.course_id, enr.org_id, whoKey(who)], db);
  for (const m of members) {
    const rest = await query(`SELECT c.id, c.title, c.status, c.audience, (SELECT 1 FROM lms_enrollments e WHERE e.course_id = c.id AND e.person_key = $2 AND e.status = 'completed') AS done
        FROM lms_path_courses pc JOIN lms_courses c ON c.id = pc.course_id AND c.deleted_at IS NULL WHERE pc.path_id = $1 AND pc.position > $3 ORDER BY pc.position`, [m.path_id, whoKey(who), m.position], db);
    const next = rest.find((c) => !c.done && c.status === 'published' && (who.learnerId ? c.audience !== 'staff' : c.audience !== 'learners'));
    if (!next) { await exec(`UPDATE lms_path_members SET completed_at = NOW(3) WHERE id = $1`, [m.id], db); out.finished.push(m.path_title); continue; }
    const due = m.due_days ? new Date(Date.now() + m.due_days * 86400_000) : null;
    if (await enrollInCourse(db, { orgId: enr.org_id, courseId: next.id, who, assignedBy: null, dueAt: due })) out.unlocked.push(next.title);
  }
  return out;
}
