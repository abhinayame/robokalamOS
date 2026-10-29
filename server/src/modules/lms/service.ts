import { Params, exec, newId, query, queryOne, type Db } from '../../db/pool.js';
import { addXp } from '../gamification/xp.js';
import { filesFor } from '../files/store.js';
import { notifyAbout, notifyUsers } from '../../lib/notify.js';
import { issueCertificate } from '../certificates/service.js';

/** Where an enrollment stands: required lessons done over required lessons, as whole percent. */
export async function standing(enrollmentId: string, courseId: string, db?: Db) {
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = $1 AND required = TRUE AND deleted_at IS NULL`, [courseId], db))!.n);
  const done = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_progress p JOIN lms_lessons l ON l.id = p.lesson_id AND l.deleted_at IS NULL AND l.required = TRUE WHERE p.enrollment_id = $1 AND p.completed_at IS NOT NULL`, [enrollmentId], db))!.n);
  const g = await queryOne(`SELECT AVG(p.best_score) AS g, COUNT(*) AS n FROM lms_progress p JOIN lms_lessons l ON l.id = p.lesson_id AND l.deleted_at IS NULL AND l.required = TRUE AND l.kind = 'quiz' WHERE p.enrollment_id = $1 AND p.best_score IS NOT NULL`, [enrollmentId], db);
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0, grade: Number(g?.n) ? Math.round(Number(g!.g)) : null as number | null };
}

/** Lessons of a course in the order a learner meets them: by module, then position. Lessons outside any module come first. */
export const LESSON_ORDER = `COALESCE(pm.position, m.position, 0), IF(pm.id IS NULL, 0, m.position), l.position, l.id`;
export const LESSON_JOIN = `LEFT JOIN lms_modules m ON m.id = l.module_id AND m.deleted_at IS NULL LEFT JOIN lms_modules pm ON pm.id = m.parent_id AND pm.deleted_at IS NULL`;

/** Record a finished lesson (idempotent; keeps the best quiz score). */
export async function markLessonDone(db: Db, enrollmentId: string, lessonId: string, score: number | null, passed = true) {
  await exec(`INSERT INTO lms_progress (id, enrollment_id, lesson_id, completed_at, best_score, attempts) VALUES ($1,$2,$3,$4,$5,1)
    ON DUPLICATE KEY UPDATE attempts = attempts + 1, best_score = GREATEST(COALESCE(best_score, 0), COALESCE(VALUES(best_score), 0)), completed_at = COALESCE(completed_at, VALUES(completed_at))`, [newId(), enrollmentId, lessonId, passed ? new Date() : null, score], db);
}

/**
 * Called after every finished lesson. When every required lesson is done the enrollment is completed once (and stays completed even
 * if lessons are added later), and a learner whose course names a certificate design receives it automatically.
 */
export async function afterProgress(db: Db, enr: { id: string; org_id: string; course_id: string; learner_id: string | null; user_id?: string | null; completed_at: any }) {
  const st = await standing(enr.id, enr.course_id, db);
  await exec(`UPDATE lms_enrollments SET last_activity_at = NOW(3), started_at = COALESCE(started_at, NOW(3)) WHERE id = $1`, [enr.id], db);
  let justCompleted = false; let certificateCode: string | null = null;
  const meta = await queryOne(`SELECT min_grade, xp_reward, title FROM lms_courses WHERE id = $1`, [enr.course_id], db);
  const gradeOk = !meta?.min_grade || st.grade === null || st.grade >= Number(meta.min_grade);
  if (!enr.completed_at && st.total > 0 && st.done >= st.total && gradeOk) {
    const r = await exec(`UPDATE lms_enrollments SET status = 'completed', completed_at = NOW(3) WHERE id = $1 AND completed_at IS NULL`, [enr.id], db);
    justCompleted = r.affectedRows > 0;
    if (justCompleted && enr.learner_id && Number(meta?.xp_reward) > 0) await addXp(db, { orgId: enr.org_id, learnerId: enr.learner_id, points: Number(meta!.xp_reward), reason: `Finished the course “${meta!.title}”`, sourceType: 'lms', sourceId: enr.course_id, dedupeKey: `lms:${enr.id}` });
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
  return { ...st, justCompleted, certificateCode, completed: !!enr.completed_at || justCompleted, path, needsGrade: !!meta?.min_grade && st.total > 0 && st.done >= st.total && !gradeOk, minGrade: meta?.min_grade ? Number(meta.min_grade) : null };
}

// ------------------------------------------------------------------ learning paths
type Who = { userId: string | null; learnerId: string | null };
const whoKey = (w: Who) => (w.userId ?? w.learnerId)!;

/** Enrol one person in a course (a no-op when they already are). Returns true when a new enrollment was made. */
export async function enrollInCourse(db: Db, o: { orgId: string; courseId: string; who: Who; assignedBy: string | null; dueAt: Date | null; source?: 'assigned' | 'self' | 'auto' }) {
  const have = await queryOne(`SELECT 1 FROM lms_enrollments WHERE course_id = $1 AND person_key = $2`, [o.courseId, whoKey(o.who)], db);
  if (have) return false;
  await exec(`INSERT INTO lms_enrollments (id, org_id, course_id, user_id, learner_id, assigned_by, due_at, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [newId(), o.orgId, o.courseId, o.who.userId, o.who.learnerId, o.assignedBy, o.dueAt, o.source ?? (o.assignedBy ? 'assigned' : 'self')], db);
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
    if (await enrollInCourse(db, { orgId: enr.org_id, courseId: next.id, who, assignedBy: null, dueAt: due, source: 'auto' })) out.unlocked.push(next.title);
  }
  return out;
}

// ------------------------------------------------------------------ the learner's view of a course (also used for the author's preview)
export interface EnrLike { id: string; learner_id: string | null; user_id: string | null; status: string; due_at: any; completed_at: any }
const lines = (v: unknown): string[] => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

/**
 * Everything the player needs: course details, modules, lessons in order with their state, and which are still locked. Quiz answers never leave
 * the server; a locked lesson shows only its title and type (so a sequential course cannot be skipped by reading ahead).
 */
export async function courseView(courseId: string, enr: EnrLike | null, db?: Db) {
  const c = await queryOne(`SELECT id, title, summary, color, icon, category, level, description, outcomes, requirements, instructor_name, language, sequential, min_grade, xp_reward, enrollment_mode, status,
      certificate_design_id IS NOT NULL AS gives_certificate FROM lms_courses WHERE id = $1`, [courseId], db);
  const modules = await query(`SELECT id, position, parent_id, title, summary FROM lms_modules WHERE course_id = $1 AND deleted_at IS NULL ORDER BY position, id`, [courseId], db);
  const rows = await query(`SELECT l.id, l.position, l.module_id, l.title, l.kind, l.body, l.url, l.minutes, l.required, l.pass_percent, l.questions, l.max_attempts, l.shuffle, l.show_answers, l.auto_accept,
      p.completed_at, p.best_score, s.status AS sub_status, s.feedback AS sub_feedback, s.body AS sub_body, s.id AS sub_id,
      (SELECT COUNT(*) FROM lms_attempts a WHERE a.enrollment_id = $2 AND a.lesson_id = l.id) AS tries
    FROM lms_lessons l ${LESSON_JOIN} LEFT JOIN lms_progress p ON p.lesson_id = l.id AND p.enrollment_id = $2 LEFT JOIN lms_submissions s ON s.lesson_id = l.id AND s.enrollment_id = $2
    WHERE l.course_id = $1 AND l.deleted_at IS NULL ORDER BY ${LESSON_ORDER}`, [courseId, enr?.id ?? ''], db);
  const files = await filesFor('lms_lesson', rows.map((r) => r.id), db);
  const subFiles = await filesFor('lms_submission', rows.map((r) => r.sub_id).filter(Boolean), db);
  let blocked = false; let n = 0;
  const lessons = rows.map((l) => {
    n++; const done = !!l.completed_at; const locked = !!c!.sequential && blocked && !done;
    if (l.required && !done) blocked = true;
    const tries = Number(l.tries); const left = l.max_attempts ? Math.max(0, l.max_attempts - tries) : null;
    const base = { id: l.id, position: n, module_id: l.module_id, title: l.title, kind: l.kind, minutes: l.minutes, required: !!l.required, done, locked, best_score: l.best_score, attempts: tries };
    if (locked) return base;
    return { ...base, body: l.body, url: l.url, pass_percent: l.pass_percent, max_attempts: l.max_attempts, attempts_left: left, shuffle: !!l.shuffle, show_answers: !!l.show_answers, auto_accept: !!l.auto_accept,
      files: files.get(l.id) ?? [], submission: l.sub_id ? { status: l.sub_status, feedback: l.sub_feedback, body: l.sub_body, files: subFiles.get(l.sub_id) ?? [] } : null,
      questions: Array.isArray(l.questions) ? l.questions.map((q: any) => ({ q: q.q, options: q.options })) : null };
  });
  return { course: { ...c!, outcomes: lines(c!.outcomes), sequential: !!c!.sequential, gives_certificate: !!c!.gives_certificate && !!enr?.learner_id }, modules, lessons };
}

// ------------------------------------------------------------------ choosing staff
export const STAFF_ROLES = ['org_admin', 'branch_admin', 'teacher', 'counsellor', 'accountant'] as const;
/** Active staff of an organization, by role and/or by name: everyone, a role, or hand-picked people (all unioned). */
export async function resolveStaff(db: Db, orgId: string, o: { all?: boolean; roles?: string[]; userIds?: string[] }): Promise<string[]> {
  const roles = (o.roles ?? []).filter((r) => (STAFF_ROLES as readonly string[]).includes(r)); const ids = o.userIds ?? [];
  if (!o.all && !roles.length && !ids.length) return [];
  const p = new Params(); const conds: string[] = [];
  if (o.all) conds.push(`r.code IN ${p.in([...STAFF_ROLES])}`);
  else { if (roles.length) conds.push(`r.code IN ${p.in(roles)}`); if (ids.length) conds.push(`u.id IN ${p.in(ids)}`); }
  const rows = await query(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.org_id = ${p.add(orgId)} AND u.status = 'active' AND u.deleted_at IS NULL AND r.code IN ${p.in([...STAFF_ROLES])} AND (${conds.join(' OR ')})`, p.values, db);
  return rows.map((r) => r.id as string);
}
