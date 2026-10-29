import { Router } from 'express';
import { z } from 'zod';
import { exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg } from '../../middleware/auth.js';
import { afterProgress, courseView, markLessonDone, standing } from './service.js';

/** The learning side: everything here acts only on the signed-in person's own enrollments (a learner's own profile, or the staff member). */
const router = Router(); // mounted at /api/learn
router.use(requireOrg);

export function mine(req: any) {
  const u = req.user!; const learnerIds = u.roles.includes('learner') ? (u.access.ownLearnerIds as string[]) : [];
  return { userId: u.id as string, learnerIds };
}
export async function myEnrollment(req: any, courseId: string, db?: any) {
  const { userId, learnerIds } = mine(req); const orgId = orgIdOf(req);
  const e = await queryOne(`SELECT e.id, e.org_id, e.course_id, e.learner_id, e.user_id, e.completed_at, e.status, e.due_at FROM lms_enrollments e JOIN lms_courses c ON c.id = e.course_id AND c.deleted_at IS NULL
      WHERE e.course_id = $1 AND e.org_id = $2 AND e.status <> 'removed' AND (e.user_id = $3 ${learnerIds.length ? `OR e.learner_id IN (${learnerIds.map((_, i) => `$${i + 4}`).join(',')})` : ''}) LIMIT 1`, [courseId, orgId, userId, ...learnerIds], db);
  if (!e) throw notFound('Course');
  return e;
}

router.get('/my', wrap(async (req, res) => {
  const { userId, learnerIds } = mine(req); const orgId = orgIdOf(req);
  const rows = await query(`SELECT e.id AS enrollment_id, e.course_id, e.status, e.due_at, e.completed_at, e.learner_id, e.last_activity_at, c.title, c.summary, c.color, c.icon, c.category, c.level, c.certificate_design_id IS NOT NULL AS gives_certificate, c.status AS course_status
      FROM lms_enrollments e JOIN lms_courses c ON c.id = e.course_id AND c.deleted_at IS NULL
      WHERE e.org_id = $1 AND e.status <> 'removed' AND (c.status = 'published' OR e.status = 'completed') AND (e.user_id = $2 ${learnerIds.length ? `OR e.learner_id IN (${learnerIds.map((_, i) => `$${i + 3}`).join(',')})` : ''})
      ORDER BY (e.status = 'completed'), e.due_at IS NULL, e.due_at, c.title`, [orgId, userId, ...learnerIds]);
  const out = [];
  for (const r of rows) { const st = await standing(r.enrollment_id, r.course_id); out.push({ ...r, gives_certificate: !!r.gives_certificate && !!r.learner_id, ...st, overdue: !!r.due_at && r.status !== 'completed' && new Date(r.due_at).getTime() < Date.now() }); }
  ok(res, out);
}));

/** My learning paths: each course in order, finished / current / locked. */
router.get('/paths', wrap(async (req, res) => {
  const { userId, learnerIds } = mine(req); const orgId = orgIdOf(req); const key = learnerIds.length ? learnerIds : [userId];
  const members = await query(`SELECT m.id, m.path_id, m.completed_at, m.person_key, p.title, p.summary FROM lms_path_members m JOIN lms_paths p ON p.id = m.path_id AND p.deleted_at IS NULL AND p.status IN ('published','archived')
      WHERE m.org_id = $1 AND m.removed_at IS NULL AND m.person_key IN (${key.map((_, i) => `$${i + 2}`).join(',')}) ORDER BY m.created_at DESC`, [orgId, ...key]);
  const out = [];
  for (const m of members) {
    const steps = await query(`SELECT c.id, c.title, pc.position, e.status AS enr_status, e.id AS enrollment_id FROM lms_path_courses pc JOIN lms_courses c ON c.id = pc.course_id AND c.deleted_at IS NULL
        LEFT JOIN lms_enrollments e ON e.course_id = c.id AND e.person_key = $2 WHERE pc.path_id = $1 ORDER BY pc.position`, [m.path_id, m.person_key]);
    out.push({ id: m.id, title: m.title, summary: m.summary, finished: !!m.completed_at, done: steps.filter((s) => s.enr_status === 'completed').length, total: steps.length,
      steps: steps.map((s) => ({ course_id: s.id, title: s.title, state: s.enr_status === 'completed' ? 'done' : s.enrollment_id ? 'open' : 'locked' })) });
  }
  ok(res, out);
}));

router.get('/courses/:courseId', wrap(async (req, res) => {
  const e = await myEnrollment(req, parse(uuid, req.params.courseId));
  const st = await standing(e.id, e.course_id); const v = await courseView(e.course_id, e);
  ok(res, { ...v, enrollment: { id: e.id, status: e.status, due_at: e.due_at, completed_at: e.completed_at }, ...st });
}));

router.post('/courses/:courseId/lessons/:lessonId/complete', limit('lms complete', 120), wrap(async (req, res) => {
  const b = parse(z.object({ answers: z.array(z.number().int().min(0).max(5)).max(30).optional() }), req.body ?? {});
  const out = await tx(async (db) => {
    const e = await myEnrollment(req, parse(uuid, req.params.courseId), db);
    const l = await queryOne(`SELECT id, kind, questions, pass_percent, max_attempts, show_answers FROM lms_lessons WHERE id = $1 AND course_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.lessonId), e.course_id], db);
    if (!l) throw notFound('Lesson');
    if (l.kind === 'assignment') throw badRequest('Hand in your work with the Submit button.');
    // a sequential course unlocks lessons one at a time
    const view = await courseView(e.course_id, e, db); const mineL = view.lessons.find((x) => x.id === l.id);
    if (mineL?.locked) throw new AppError(409, 'LOCKED', 'Finish the earlier lessons first. This one unlocks after them.');
    let passed = true; let score: number | null = null; let review: { correct: number; explanation: string | null; yours: number }[] | null = null; let left: number | null = null;
    if (l.kind === 'quiz') {
      const qs: any[] = Array.isArray(l.questions) ? l.questions : [];
      if (!b.answers || b.answers.length !== qs.length) throw badRequest('Answer every question.', [{ field: 'answers', message: 'Answer every question.' }]);
      const tries = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_attempts WHERE enrollment_id = $1 AND lesson_id = $2`, [e.id, l.id], db))!.n);
      const already = !!mineL?.done;
      if (l.max_attempts && tries >= l.max_attempts && !already) throw new AppError(409, 'NO_ATTEMPTS', 'You have used all your attempts for this quiz. Ask your teacher if you need another go.');
      score = Math.round((qs.filter((q, i) => b.answers![i] === q.answer).length / qs.length) * 100); passed = score >= l.pass_percent;
      await exec(`INSERT INTO lms_attempts (id, enrollment_id, lesson_id, answers, score, passed) VALUES ($1,$2,$3,$4,$5,$6)`, [newId(), e.id, l.id, JSON.stringify(b.answers), score, passed], db);
      left = l.max_attempts ? Math.max(0, l.max_attempts - tries - 1) : null;
      if (l.show_answers && (passed || left === 0)) review = qs.map((q, i) => ({ correct: q.answer, explanation: q.explanation ?? null, yours: b.answers![i]! }));
    }
    await markLessonDone(db, e.id, l.id, score, passed);
    const r = await afterProgress(db, e);
    return { passed, score, pass_percent: l.pass_percent, attempts_left: left, review, percent: r.percent, done: r.done, total: r.total, grade: r.grade, needs_grade: r.needsGrade, min_grade: r.minGrade, course_completed: r.completed, just_completed: r.justCompleted, certificate_code: r.certificateCode, path_unlocked: r.path.unlocked, path_finished: r.path.finished };
  });
  ok(res, out);
}));
export default router;
