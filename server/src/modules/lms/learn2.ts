import { Router } from 'express';
import { z } from 'zod';
import { exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { notifyUsers } from '../../lib/notify.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { attachFiles, filesFor } from '../files/store.js';
import { afterProgress, courseView, enrollInCourse, markLessonDone, standing } from './service.js';
import { mine, myEnrollment } from './learn.js';

/** The learner's side of the fuller LMS: catalog and self-enrolment, notes, handing in work, reviews, course discussion, announcements and the learning record. */
const router = Router(); // mounted at /api/learn (after learn.ts)
router.use(requireOrg, requirePerm('lms:learn'));
const isLearnerUser = (req: any) => req.user!.roles.includes('learner') && req.user!.access.ownLearnerIds.length > 0;
const audienceOk = (req: any) => (isLearnerUser(req) ? `c.audience IN ('learners','both')` : `c.audience IN ('staff','both')`);
const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;

/** Anyone enrolled in the course, or a course manager, may read and join its discussion. */
async function courseAccess(req: any, courseId: string, db?: any) {
  const orgId = orgIdOf(req); const c = await queryOne(`SELECT id, title, created_by, status FROM lms_courses WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [courseId, orgId], db); if (!c) throw notFound('Course');
  const manager = req.user!.isSuperAdmin || req.user!.permissions.has('lms:manage');
  const { userId, learnerIds } = mine(req);
  const enr = await queryOne(`SELECT id, org_id, course_id, learner_id, user_id, completed_at, status FROM lms_enrollments WHERE course_id = $1 AND status <> 'removed' AND (user_id = $2 ${learnerIds.length ? `OR learner_id IN (${learnerIds.map((_, i) => `$${i + 3}`).join(',')})` : ''}) LIMIT 1`, [courseId, userId, ...learnerIds], db);
  if (!enr && !manager) throw notFound('Course');
  return { course: c, enr, manager };
}

// ------------------------------------------------------------------ catalog
router.get('/catalog', wrap(async (req, res) => {
  const q = parse(z.object({ q: z.string().max(80).optional(), category: z.string().max(60).optional() }), req.query); const { userId, learnerIds } = mine(req); const orgId = orgIdOf(req);
  const w = [`c.org_id = $1`, `c.deleted_at IS NULL`, `c.status = 'published'`, `c.enrollment_mode = 'open'`, audienceOk(req)]; const v: any[] = [orgId, userId];
  if (q.q) { v.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`); w.push(`(c.title LIKE $${v.length} OR c.summary LIKE $${v.length} OR c.category LIKE $${v.length})`); }
  if (q.category) { v.push(q.category); w.push(`c.category = $${v.length}`); }
  const own = learnerIds.map((id) => { v.push(id); return `$${v.length}`; });
  const rows = await query(`SELECT c.id, c.title, c.summary, c.color, c.icon, c.category, c.level, c.instructor_name, c.language, c.certificate_design_id IS NOT NULL AS gives_certificate,
      (SELECT COUNT(*) FROM lms_lessons l WHERE l.course_id = c.id AND l.deleted_at IS NULL) AS lessons, (SELECT COALESCE(SUM(l.minutes), 0) FROM lms_lessons l WHERE l.course_id = c.id AND l.deleted_at IS NULL) AS minutes,
      (SELECT AVG(r.rating) FROM lms_reviews r WHERE r.course_id = c.id AND r.hidden_at IS NULL) AS rating, (SELECT COUNT(*) FROM lms_reviews r WHERE r.course_id = c.id AND r.hidden_at IS NULL) AS reviews,
      (SELECT COUNT(*) FROM lms_enrollments e WHERE e.course_id = c.id AND e.status <> 'removed') AS learners,
      EXISTS (SELECT 1 FROM lms_enrollments e WHERE e.course_id = c.id AND e.status <> 'removed' AND (e.user_id = $2 ${own.length ? `OR e.learner_id IN (${own.join(',')})` : ''})) AS enrolled
    FROM lms_courses c WHERE ${w.join(' AND ')} ORDER BY c.title LIMIT 200`, v);
  const cats = await query(`SELECT DISTINCT c.category FROM lms_courses c WHERE c.org_id = $1 AND c.deleted_at IS NULL AND c.status = 'published' AND c.enrollment_mode = 'open' AND c.category IS NOT NULL AND ${audienceOk(req)} ORDER BY c.category`, [orgId]);
  ok(res, rows.map((r) => ({ ...r, lessons: Number(r.lessons), minutes: Number(r.minutes), rating: r.reviews ? Math.round(Number(r.rating) * 10) / 10 : null, reviews: Number(r.reviews), learners: Number(r.learners), enrolled: !!r.enrolled, gives_certificate: !!r.gives_certificate && isLearnerUser(req) })), { categories: cats.map((c) => c.category) });
}));
/** A course's landing page: what it is, the syllabus (titles only), who teaches it, what people said. */
router.get('/catalog/:courseId', wrap(async (req, res) => {
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.courseId); const manager = req.user!.permissions.has('lms:manage');
  const c = await queryOne(`SELECT c.id, c.title, c.summary, c.description, c.outcomes, c.requirements, c.instructor_name, c.language, c.level, c.category, c.color, c.icon, c.sequential, c.min_grade, c.xp_reward, c.enrollment_mode, c.audience, c.status, c.certificate_design_id IS NOT NULL AS gives_certificate FROM lms_courses c WHERE c.id = $1 AND c.org_id = $2 AND c.deleted_at IS NULL`, [id, orgId]);
  if (!c) throw notFound('Course');
  const { userId, learnerIds } = mine(req);
  const enr = await queryOne(`SELECT id, status, due_at, completed_at FROM lms_enrollments WHERE course_id = $1 AND status <> 'removed' AND (user_id = $2 ${learnerIds.length ? `OR learner_id IN (${learnerIds.map((_, i) => `$${i + 3}`).join(',')})` : ''}) LIMIT 1`, [id, userId, ...learnerIds]);
  const visible = enr || manager || (c.status === 'published' && c.enrollment_mode === 'open' && (isLearnerUser(req) ? c.audience !== 'staff' : c.audience !== 'learners'));
  if (!visible) throw notFound('Course');
  const modules = await query(`SELECT id, position, title, summary FROM lms_modules WHERE course_id = $1 AND deleted_at IS NULL ORDER BY position, id`, [id]);
  const lessons = await query(`SELECT l.id, l.module_id, l.title, l.kind, l.minutes, l.required FROM lms_lessons l LEFT JOIN lms_modules m ON m.id = l.module_id AND m.deleted_at IS NULL WHERE l.course_id = $1 AND l.deleted_at IS NULL ORDER BY COALESCE(m.position, 0), l.position, l.id`, [id]);
  const rating = await queryOne(`SELECT AVG(rating) AS avg, COUNT(*) AS n FROM lms_reviews WHERE course_id = $1 AND hidden_at IS NULL`, [id]);
  const reviews = await query(`SELECT r.rating, r.comment, r.created_at, COALESCE(l.full_name, u.full_name) AS name, (r.learner_id IS NOT NULL) AS is_learner FROM lms_reviews r LEFT JOIN learners l ON l.id = r.learner_id LEFT JOIN users u ON u.id = r.user_id WHERE r.course_id = $1 AND r.hidden_at IS NULL AND r.comment IS NOT NULL ORDER BY r.created_at DESC LIMIT 20`, [id]);
  const learners = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_enrollments WHERE course_id = $1 AND status <> 'removed'`, [id]))!.n);
  ok(res, { course: { ...c, outcomes: (() => { try { const a = typeof c.outcomes === 'string' ? JSON.parse(c.outcomes) : c.outcomes; return Array.isArray(a) ? a : []; } catch { return []; } })(), sequential: !!c.sequential, gives_certificate: !!c.gives_certificate && isLearnerUser(req) },
    modules, lessons: lessons.map((l) => ({ ...l, required: !!l.required })), enrollment: enr ?? null, can_enrol: !enr && c.status === 'published' && c.enrollment_mode === 'open', learners,
    rating: rating?.n ? { avg: Math.round(Number(rating.avg) * 10) / 10, count: Number(rating.n) } : null,
    reviews: reviews.map((r) => ({ rating: r.rating, comment: r.comment, created_at: r.created_at, name: r.is_learner ? firstName(r.name) : r.name })) });
}));
router.post('/catalog/:courseId/enrol', limit('lms enrol', 30), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.courseId); const { userId, learnerIds } = mine(req);
  const out = await tx(async (db) => {
    const c = await queryOne(`SELECT id, title, audience, status, enrollment_mode FROM lms_courses WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId], db); if (!c) throw notFound('Course');
    if (c.status !== 'published' || c.enrollment_mode !== 'open') throw new AppError(409, 'NOT_OPEN', 'This course is not open for joining. Ask your school to give it to you.');
    if (isLearnerUser(req) ? c.audience === 'staff' : c.audience === 'learners') throw notFound('Course');
    const made = await enrollInCourse(db, { orgId, courseId: id, who: isLearnerUser(req) ? { userId: null, learnerId: learnerIds[0]! } : { userId, learnerId: null }, assignedBy: null, dueAt: null });
    if (made) await audit({ orgId, actor: req.user, action: 'lms.self_enrolled', entityType: 'lms_course', entityId: id, req }, db);
    return { enrolled: true, already: !made };
  }); ok(res, out, undefined, out.already ? 200 : 201);
}));

// ------------------------------------------------------------------ notes
router.get('/courses/:courseId/notes', wrap(async (req, res) => {
  const e = await myEnrollment(req, parse(uuid, req.params.courseId)); ok(res, await query(`SELECT lesson_id, body, updated_at FROM lms_notes WHERE enrollment_id = $1`, [e.id]));
}));
router.put('/courses/:courseId/lessons/:lessonId/notes', limit('lms notes', 120), wrap(async (req, res) => {
  const b = parse(z.object({ body: z.string().max(5000) }), req.body); const e = await myEnrollment(req, parse(uuid, req.params.courseId)); const lid = parse(uuid, req.params.lessonId);
  if (!(await queryOne(`SELECT 1 FROM lms_lessons WHERE id = $1 AND course_id = $2 AND deleted_at IS NULL`, [lid, e.course_id]))) throw notFound('Lesson');
  if (!b.body.trim()) await exec(`DELETE FROM lms_notes WHERE enrollment_id = $1 AND lesson_id = $2`, [e.id, lid]);
  else await exec(`INSERT INTO lms_notes (enrollment_id, lesson_id, body) VALUES ($1,$2,$3) ON DUPLICATE KEY UPDATE body = VALUES(body)`, [e.id, lid, b.body]);
  ok(res, { saved: true });
}));

// ------------------------------------------------------------------ handing in work
router.post('/courses/:courseId/lessons/:lessonId/submit', limit('lms submit', 30), wrap(async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().max(10000).nullish().transform((v) => v || null), file_ids: z.array(uuid).max(5).default([]) }), req.body); const orgId = orgIdOf(req);
  if (!b.body && !b.file_ids.length) throw badRequest('Write your answer or attach a file.');
  const out = await tx(async (db) => {
    const e = await myEnrollment(req, parse(uuid, req.params.courseId), db);
    const l = await queryOne(`SELECT id, title, kind, auto_accept FROM lms_lessons WHERE id = $1 AND course_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.lessonId), e.course_id], db); if (!l) throw notFound('Lesson');
    if (l.kind !== 'assignment') throw badRequest('This lesson does not take a submission.');
    const view = await courseView(e.course_id, e, db); if (view.lessons.find((x) => x.id === l.id)?.locked) throw new AppError(409, 'LOCKED', 'Finish the earlier lessons first.');
    const prev = await queryOne(`SELECT id, status FROM lms_submissions WHERE enrollment_id = $1 AND lesson_id = $2 FOR UPDATE`, [e.id, l.id], db);
    if (prev?.status === 'accepted') throw conflict('Your work was already accepted.', 'ACCEPTED');
    const id = prev?.id ?? newId(); const status = l.auto_accept ? 'accepted' : 'submitted';
    if (prev) await exec(`UPDATE lms_submissions SET body = $2, status = $3, feedback = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`, [id, b.body, status], db);
    else await exec(`INSERT INTO lms_submissions (id, org_id, enrollment_id, lesson_id, body, status) VALUES ($1,$2,$3,$4,$5,$6)`, [id, orgId, e.id, l.id, b.body, status], db);
    await attachFiles(db, { orgId, userId: req.user!.id, ownerType: 'lms_submission', ownerId: id, fileIds: b.file_ids, replace: true, max: 5 });
    let r: any = null;
    if (l.auto_accept) { await markLessonDone(db, e.id, l.id, null, true); r = await afterProgress(db, e); }
    else { const c = await queryOne(`SELECT created_by, title FROM lms_courses WHERE id = $1`, [e.course_id], db); if (c?.created_by) await notifyUsers(db, { orgId, userIds: [c.created_by], kind: 'lms.submission', title: `Work to review: ${l.title}`, body: c.title, link: '/courses' }); }
    return { status, course_completed: !!r?.completed, just_completed: !!r?.justCompleted, certificate_code: r?.certificateCode ?? null, path_unlocked: r?.path.unlocked ?? [] };
  }); ok(res, out, undefined, 201);
}));

// ------------------------------------------------------------------ reviews
router.get('/courses/:courseId/review', wrap(async (req, res) => {
  const { enr } = await courseAccess(req, parse(uuid, req.params.courseId)); if (!enr) return ok(res, { eligible: false, mine: null });
  const st = await standing(enr.id, enr.course_id); const { userId, learnerIds } = mine(req);
  const my = await queryOne(`SELECT rating, comment FROM lms_reviews WHERE course_id = $1 AND person_key = $2`, [enr.course_id, learnerIds[0] ?? userId]);
  ok(res, { eligible: !!enr.completed_at || st.percent >= 50, mine: my ?? null });
}));
router.put('/courses/:courseId/review', limit('lms review', 20), wrap(async (req, res) => {
  const b = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).nullish().transform((v) => v || null) }), req.body); const orgId = orgIdOf(req);
  const { enr } = await courseAccess(req, parse(uuid, req.params.courseId)); if (!enr) throw notFound('Course');
  const st = await standing(enr.id, enr.course_id); if (!enr.completed_at && st.percent < 50) throw new AppError(409, 'TOO_EARLY', 'Finish at least half of the course before you review it.');
  await exec(`INSERT INTO lms_reviews (id, org_id, course_id, user_id, learner_id, rating, comment) VALUES ($1,$2,$3,$4,$5,$6,$7) ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`, [newId(), orgId, enr.course_id, enr.learner_id ? null : enr.user_id, enr.learner_id, b.rating, b.comment]);
  ok(res, { saved: true });
}));

// ------------------------------------------------------------------ discussion
const shapeAuthor = (r: any) => ({ name: r.learner_author ? firstName(r.author) : r.author, staff: !r.learner_author });
router.get('/courses/:courseId/discussions', wrap(async (req, res) => {
  const { course } = await courseAccess(req, parse(uuid, req.params.courseId)); const manager = req.user!.permissions.has('lms:manage');
  const rows = await query(`SELECT d.id, d.lesson_id, d.title, d.body, d.resolved, d.pinned, d.hidden_at, d.created_at, d.last_activity_at, u.full_name AS author, EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = 'learner') AS learner_author,
      (SELECT COUNT(*) FROM lms_replies x WHERE x.discussion_id = d.id AND x.hidden_at IS NULL) AS replies FROM lms_discussions d JOIN users u ON u.id = d.author_id WHERE d.course_id = $1 ${manager ? '' : 'AND d.hidden_at IS NULL'} ORDER BY d.pinned DESC, d.last_activity_at DESC LIMIT 100`, [course.id]);
  ok(res, rows.map((r) => ({ id: r.id, lesson_id: r.lesson_id, title: r.title, body: r.body, resolved: !!r.resolved, pinned: !!r.pinned, hidden: !!r.hidden_at, created_at: r.created_at, last_activity_at: r.last_activity_at, replies: Number(r.replies), ...shapeAuthor(r) })));
}));
router.post('/courses/:courseId/discussions', limit('lms discuss', 20), wrap(async (req, res) => {
  const b = parse(z.object({ title: z.string().trim().min(3, 'Give your question a title.').max(200), body: z.string().trim().min(3).max(4000), lesson_id: uuid.nullish() }), req.body); const orgId = orgIdOf(req);
  const { course } = await courseAccess(req, parse(uuid, req.params.courseId)); const id = newId();
  if (b.lesson_id && !(await queryOne(`SELECT 1 FROM lms_lessons WHERE id = $1 AND course_id = $2 AND deleted_at IS NULL`, [b.lesson_id, course.id]))) throw notFound('Lesson');
  await tx(async (db) => { await exec(`INSERT INTO lms_discussions (id, org_id, course_id, lesson_id, author_id, title, body) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, orgId, course.id, b.lesson_id ?? null, req.user!.id, b.title, b.body], db);
    if (course.created_by && course.created_by !== req.user!.id) await notifyUsers(db, { orgId, userIds: [course.created_by], kind: 'lms.question', title: `New question in ${course.title}`, body: b.title, link: `/learn/${course.id}` }); });
  ok(res, { id }, undefined, 201);
}));
router.get('/discussions/:id', wrap(async (req, res) => {
  const orgId = orgIdOf(req); const d = await queryOne(`SELECT d.id, d.course_id, d.lesson_id, d.title, d.body, d.resolved, d.pinned, d.hidden_at, d.created_at, u.full_name AS author, EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = 'learner') AS learner_author FROM lms_discussions d JOIN users u ON u.id = d.author_id WHERE d.id = $1 AND d.org_id = $2`, [parse(uuid, req.params.id), orgId]);
  if (!d) throw notFound('Discussion'); await courseAccess(req, d.course_id); const manager = req.user!.permissions.has('lms:manage'); if (d.hidden_at && !manager) throw notFound('Discussion');
  const replies = await query(`SELECT r.id, r.body, r.is_staff, r.hidden_at, r.created_at, u.full_name AS author, EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id WHERE ur.user_id = u.id AND ro.code = 'learner') AS learner_author FROM lms_replies r JOIN users u ON u.id = r.author_id WHERE r.discussion_id = $1 ${manager ? '' : 'AND r.hidden_at IS NULL'} ORDER BY r.created_at LIMIT 300`, [d.id]);
  ok(res, { id: d.id, title: d.title, body: d.body, resolved: !!d.resolved, pinned: !!d.pinned, hidden: !!d.hidden_at, created_at: d.created_at, ...shapeAuthor(d), replies: replies.map((r) => ({ id: r.id, body: r.body, staff: !!r.is_staff, hidden: !!r.hidden_at, created_at: r.created_at, name: r.learner_author ? firstName(r.author) : r.author })) });
}));
router.post('/discussions/:id/replies', limit('lms discuss', 40), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const b = parse(z.object({ body: z.string().trim().min(1, 'Write a reply.').max(4000) }), req.body);
  const d = await queryOne(`SELECT id, course_id, author_id, title, hidden_at FROM lms_discussions WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgId]); if (!d || d.hidden_at) throw notFound('Discussion');
  const { course } = await courseAccess(req, d.course_id); const staff = req.user!.permissions.has('lms:manage'); const id = newId();
  await tx(async (db) => { await exec(`INSERT INTO lms_replies (id, discussion_id, author_id, body, is_staff) VALUES ($1,$2,$3,$4,$5)`, [id, d.id, req.user!.id, b.body, staff], db); await exec(`UPDATE lms_discussions SET last_activity_at = NOW(3) WHERE id = $1`, [d.id], db);
    if (d.author_id !== req.user!.id) await notifyUsers(db, { orgId, userIds: [d.author_id], kind: 'lms.reply', title: `New reply: ${d.title}`, body: b.body.slice(0, 140), link: `/learn/${course.id}` }); });
  ok(res, { id }, undefined, 201);
}));

// ------------------------------------------------------------------ announcements and the learning record
router.get('/courses/:courseId/announcements', wrap(async (req, res) => {
  const { course } = await courseAccess(req, parse(uuid, req.params.courseId));
  ok(res, await query(`SELECT a.id, a.title, a.body, a.created_at, u.full_name AS author FROM lms_announcements a JOIN users u ON u.id = a.created_by WHERE a.course_id = $1 ORDER BY a.created_at DESC LIMIT 20`, [course.id]));
}));
/** My learning record: every finished course with its date, grade and certificate. */
router.get('/record', wrap(async (req, res) => {
  const { userId, learnerIds } = mine(req); const orgId = orgIdOf(req);
  const rows = await query(`SELECT e.id AS enrollment_id, e.course_id, e.completed_at, e.learner_id, c.title, c.category, c.level FROM lms_enrollments e JOIN lms_courses c ON c.id = e.course_id WHERE e.org_id = $1 AND e.status = 'completed' AND (e.user_id = $2 ${learnerIds.length ? `OR e.learner_id IN (${learnerIds.map((_, i) => `$${i + 3}`).join(',')})` : ''}) ORDER BY e.completed_at DESC`, [orgId, userId, ...learnerIds]);
  const out = [];
  for (const r of rows) {
    const st = await standing(r.enrollment_id, r.course_id);
    const cert = r.learner_id ? await queryOne(`SELECT code FROM certificates WHERE learner_id = $1 AND course_name = $2 AND revoked_at IS NULL ORDER BY issued_on DESC LIMIT 1`, [r.learner_id, r.title]) : null;
    out.push({ course_id: r.course_id, title: r.title, category: r.category, level: r.level, completed_at: r.completed_at, grade: st.grade, certificate_code: cert?.code ?? null });
  }
  const mins = Number((await queryOne(`SELECT COALESCE(SUM(l.minutes), 0) AS n FROM lms_progress p JOIN lms_enrollments e ON e.id = p.enrollment_id JOIN lms_lessons l ON l.id = p.lesson_id WHERE p.completed_at IS NOT NULL AND e.org_id = $1 AND (e.user_id = $2 ${learnerIds.length ? `OR e.learner_id IN (${learnerIds.map((_, i) => `$${i + 3}`).join(',')})` : ''})`, [orgId, userId, ...learnerIds]))!.n);
  ok(res, { courses: out, minutes_learned: mins });
}));
export default router;
