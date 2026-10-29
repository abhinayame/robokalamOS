import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { notifyAbout, notifyUsers } from '../../lib/notify.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { attachFiles, filesFor } from '../files/store.js';
import { afterProgress, courseView, LESSON_JOIN, LESSON_ORDER, markLessonDone, standing } from './service.js';

/** The course studio: everything an author needs beyond the basics (details, modules, publishing, review of work, discussion moderation, announcements, analytics). */
const router = Router(); // mounted at /api/lms
router.use(requireOrg, requireAnyPerm('lms:read', 'lms:manage'));
const manage = requirePerm('lms:manage');
const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/);

async function loadCourse(orgId: string, id: string, db?: any) {
  const c = await queryOne(`SELECT * FROM lms_courses WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId], db); if (!c) throw notFound('Course'); return c;
}
const asList = (v: unknown): string[] => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

// ------------------------------------------------------------------ publish checklist
/** What stands between this draft and being ready. `blocking` items stop publishing; the rest are advice. */
async function checklist(courseId: string, db?: any) {
  const c = await queryOne(`SELECT title, summary, description, outcomes, certificate_design_id, audience, enrollment_mode FROM lms_courses WHERE id = $1`, [courseId], db);
  const lessons = await query(`SELECT id, kind, required, body, url, questions FROM lms_lessons WHERE course_id = $1 AND deleted_at IS NULL`, [courseId], db);
  const files = await filesFor('lms_lesson', lessons.filter((l) => l.kind === 'file').map((l) => l.id), db);
  const items = [
    { id: 'lessons', ok: lessons.length > 0, blocking: true, label: 'The course has lessons', hint: 'Add at least one lesson.' },
    { id: 'required', ok: lessons.some((l) => l.required), blocking: true, label: 'At least one lesson is required', hint: 'Tick “Required” on a lesson, otherwise nobody can finish the course.' },
    { id: 'quizzes', ok: lessons.filter((l) => l.kind === 'quiz').every((l) => Array.isArray(l.questions) && l.questions.length), blocking: true, label: 'Every quiz has questions', hint: 'Add questions to each quiz.' },
    { id: 'files', ok: lessons.filter((l) => l.kind === 'file').every((l) => (files.get(l.id) ?? []).length), blocking: true, label: 'Every file lesson has a file', hint: 'Upload a file for each file lesson.' },
    { id: 'summary', ok: !!c?.summary, blocking: false, label: 'A short description', hint: 'One or two lines shown on the course card.' },
    { id: 'outcomes', ok: asList(c?.outcomes).length > 0, blocking: false, label: '“What you will learn” is filled in', hint: 'Three or four bullet points help people decide to start.' },
    { id: 'certificate', ok: !!c?.certificate_design_id, blocking: false, label: 'A certificate is chosen', hint: 'Learners who finish get it automatically.' },
  ];
  return { ready: items.filter((i) => i.blocking).every((i) => i.ok), items };
}
router.get('/courses/:id/checklist', wrap(async (req, res) => { const c = await loadCourse(orgIdOf(req), parse(uuid, req.params.id)); ok(res, await checklist(c.id)); }));
router.post('/courses/:id/publish', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const cl = await checklist(c.id);
  if (!cl.ready) throw badRequest(`Not ready to publish: ${cl.items.filter((i) => i.blocking && !i.ok).map((i) => i.label.toLowerCase()).join('; ')}.`, cl.items.filter((i) => i.blocking && !i.ok).map((i) => ({ field: i.id, message: i.hint })));
  await exec(`UPDATE lms_courses SET status = 'published', published_at = COALESCE(published_at, NOW(3)) WHERE id = $1`, [c.id]);
  await audit({ orgId, actor: req.user, action: 'lms.course_published', entityType: 'lms_course', entityId: c.id, req }); ok(res, { status: 'published' });
}));
router.post('/courses/:id/unpublish', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id));
  await exec(`UPDATE lms_courses SET status = 'draft' WHERE id = $1`, [c.id]); await audit({ orgId, actor: req.user, action: 'lms.course_unpublished', entityType: 'lms_course', entityId: c.id, req }); ok(res, { status: 'draft' });
}));

// ------------------------------------------------------------------ details (landing page content and rules)
const detailsBody = z.object({
  category: z.string().trim().max(60).nullish().transform((v) => (v === undefined ? undefined : v || null)), level: z.enum(['beginner', 'intermediate', 'advanced']).nullish(),
  description: z.string().trim().max(8000).nullish().transform((v) => (v === undefined ? undefined : v || null)), outcomes: z.array(z.string().trim().min(2).max(160)).max(10).optional(),
  requirements: z.string().trim().max(500).nullish().transform((v) => (v === undefined ? undefined : v || null)), instructor_name: z.string().trim().max(120).nullish().transform((v) => (v === undefined ? undefined : v || null)),
  language: z.string().trim().min(2).max(30).optional(), icon: z.string().trim().max(8).nullish().transform((v) => (v === undefined ? undefined : v || null)), color: color.optional(),
  enrollment_mode: z.enum(['assigned', 'open']).optional(), sequential: z.boolean().optional(), min_grade: z.number().int().min(1).max(100).nullish(), xp_reward: z.number().int().min(0).max(1000).optional(),
});
router.patch('/courses/:id/details', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const b = parse(detailsBody, req.body);
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) { if (v === undefined) continue; vals.push(k === 'outcomes' ? JSON.stringify(v) : k === 'sequential' ? (v ? 1 : 0) : v); sets.push(`${k} = $${vals.length + 2}`); }
  if (sets.length) await exec(`UPDATE lms_courses SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, [c.id, orgId, ...vals]);
  await audit({ orgId, actor: req.user, action: 'lms.course_details', entityType: 'lms_course', entityId: c.id, next: Object.keys(b), req }); ok(res, { id: c.id });
}));

/** The whole course for the studio: details, modules, lessons (with answers and files), checklist and numbers. */
router.get('/courses/:id/studio', wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id));
  const modules = await query(`SELECT id, position, title, summary FROM lms_modules WHERE course_id = $1 AND deleted_at IS NULL ORDER BY position, id`, [c.id]);
  const lessons = await query(`SELECT l.id, l.position, l.module_id, l.title, l.kind, l.body, l.url, l.minutes, l.required, l.pass_percent, l.questions, l.max_attempts, l.shuffle, l.show_answers, l.auto_accept FROM lms_lessons l ${LESSON_JOIN} WHERE l.course_id = $1 AND l.deleted_at IS NULL ORDER BY ${LESSON_ORDER}`, [c.id]);
  const files = await filesFor('lms_lesson', lessons.map((l) => l.id));
  const stats = await queryOne(`SELECT COUNT(*) AS enrolled, COALESCE(SUM(status = 'completed'), 0) AS completed FROM lms_enrollments WHERE course_id = $1 AND status <> 'removed'`, [c.id]);
  const rating = await queryOne(`SELECT AVG(rating) AS avg, COUNT(*) AS n FROM lms_reviews WHERE course_id = $1 AND hidden_at IS NULL`, [c.id]);
  const { deleted_at, ...course } = c as any; void deleted_at;
  ok(res, { course: { ...course, outcomes: asList(c.outcomes), sequential: !!c.sequential }, modules, lessons: lessons.map((l) => ({ ...l, required: !!l.required, shuffle: !!l.shuffle, show_answers: !!l.show_answers, auto_accept: !!l.auto_accept, files: files.get(l.id) ?? [] })),
    checklist: await checklist(c.id), stats: { enrolled: Number(stats!.enrolled), completed: Number(stats!.completed), rating_avg: rating?.n ? Math.round(Number(rating.avg) * 10) / 10 : null, rating_count: Number(rating!.n) } });
}));
/** Preview the course exactly as a learner sees it (nothing is recorded). */
router.get('/courses/:id/preview', wrap(async (req, res) => {
  const c = await loadCourse(orgIdOf(req), parse(uuid, req.params.id)); const v = await courseView(c.id, null);
  ok(res, { ...v, preview: true, enrollment: { id: null, status: 'preview', due_at: null, completed_at: null }, total: v.lessons.filter((l) => l.required).length, done: 0, percent: 0, grade: null,
    lessons: v.lessons.map((l: any) => ({ ...l, locked: false })) }); // an author may look at every lesson, in order
}));

// ------------------------------------------------------------------ modules
const moduleBody = z.object({ title: z.string().trim().min(2, 'Name the module.').max(160), summary: z.string().trim().max(500).nullish().transform((v) => v || null) });
router.post('/courses/:id/modules', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const b = parse(moduleBody, req.body); const id = newId();
  const pos = Number((await queryOne(`SELECT COALESCE(MAX(position), 0) AS p FROM lms_modules WHERE course_id = $1`, [c.id]))!.p) + 1;
  await exec(`INSERT INTO lms_modules (id, org_id, course_id, position, title, summary) VALUES ($1,$2,$3,$4,$5,$6)`, [id, orgId, c.id, pos, b.title, b.summary]); ok(res, { id, position: pos }, undefined, 201);
}));
router.patch('/modules/:id', manage, wrap(async (req, res) => {
  const b = parse(moduleBody, req.body); const r = await exec(`UPDATE lms_modules SET title = $3, summary = $4 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.id), orgIdOf(req), b.title, b.summary]);
  if (!r.affectedRows) throw notFound('Module'); ok(res, { updated: true });
}));
/** Removing a module keeps its lessons: they simply become ungrouped. */
router.delete('/modules/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.id);
  await tx(async (db) => { const r = await exec(`UPDATE lms_modules SET deleted_at = NOW(3) WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId], db); if (!r.affectedRows) throw notFound('Module'); await exec(`UPDATE lms_lessons SET module_id = NULL WHERE module_id = $1`, [id], db); });
  ok(res, { deleted: true });
}));
router.post('/courses/:id/modules/reorder', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const b = parse(z.object({ ids: z.array(uuid).min(1).max(100) }), req.body);
  await tx(async (db) => {
    const cur = (await query(`SELECT id FROM lms_modules WHERE course_id = $1 AND deleted_at IS NULL FOR UPDATE`, [c.id], db)).map((r) => r.id as string);
    if (cur.length !== b.ids.length || !b.ids.every((i) => cur.includes(i)) || new Set(b.ids).size !== b.ids.length) throw conflict('The list changed. Reload and try again.', 'STALE_ORDER');
    for (const [i, id] of b.ids.entries()) await exec(`UPDATE lms_modules SET position = $2 WHERE id = $1`, [id, i + 1], db);
  }); ok(res, { reordered: b.ids.length });
}));
/** Put a lesson in a module (or take it out), at the end of that module. */
router.put('/lessons/:id/module', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const b = parse(z.object({ module_id: uuid.nullable() }), req.body); const l = await queryOne(`SELECT id, course_id FROM lms_lessons WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.id), orgId]); if (!l) throw notFound('Lesson');
  if (b.module_id && !(await queryOne(`SELECT 1 FROM lms_modules WHERE id = $1 AND course_id = $2 AND deleted_at IS NULL`, [b.module_id, l.course_id]))) throw badRequest('That module is not part of this course.');
  const pos = Number((await queryOne(`SELECT COALESCE(MAX(position), 0) AS p FROM lms_lessons WHERE course_id = $1`, [l.course_id]))!.p) + 1;
  await exec(`UPDATE lms_lessons SET module_id = $2, position = $3 WHERE id = $1`, [l.id, b.module_id, pos]); ok(res, { moved: true });
}));
/** Attach (or replace) the downloadable files of a "file" lesson. Upload them first with POST /api/files. */
router.put('/lessons/:id/files', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const b = parse(z.object({ file_ids: z.array(uuid).max(10) }), req.body); const l = await queryOne(`SELECT id FROM lms_lessons WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.id), orgId]); if (!l) throw notFound('Lesson');
  await tx(async (db) => attachFiles(db, { orgId, userId: req.user!.id, ownerType: 'lms_lesson', ownerId: l.id, fileIds: b.file_ids, replace: true })); ok(res, { files: b.file_ids.length });
}));

// ------------------------------------------------------------------ copy a course
router.post('/courses/:id/duplicate', manage, limit('lms copy', 10), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const src = await loadCourse(orgId, parse(uuid, req.params.id)); const nid = newId();
  await tx(async (db) => {
    await exec(`INSERT INTO lms_courses (id, org_id, title, summary, audience, status, color, certificate_design_id, created_by, category, level, description, outcomes, requirements, instructor_name, language, icon, enrollment_mode, sequential, min_grade, xp_reward)
      SELECT $2, org_id, LEFT(CONCAT('Copy of ', title), 160), summary, audience, 'draft', color, certificate_design_id, $3, category, level, description, outcomes, requirements, instructor_name, language, icon, enrollment_mode, sequential, min_grade, xp_reward FROM lms_courses WHERE id = $1`, [src.id, nid, req.user!.id], db);
    const map = new Map<string, string>();
    for (const m of await query(`SELECT id, position, title, summary FROM lms_modules WHERE course_id = $1 AND deleted_at IS NULL ORDER BY position`, [src.id], db)) { const id = newId(); map.set(m.id, id); await exec(`INSERT INTO lms_modules (id, org_id, course_id, position, title, summary) VALUES ($1,$2,$3,$4,$5,$6)`, [id, orgId, nid, m.position, m.title, m.summary], db); }
    for (const l of await query(`SELECT * FROM lms_lessons WHERE course_id = $1 AND deleted_at IS NULL ORDER BY position`, [src.id], db)) {
      const id = newId();
      await exec(`INSERT INTO lms_lessons (id, org_id, course_id, position, title, kind, body, url, minutes, questions, pass_percent, required, module_id, max_attempts, shuffle, show_answers, auto_accept) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, orgId, nid, l.position, l.title, l.kind, l.body, l.url, l.minutes, l.questions == null ? null : (typeof l.questions === 'string' ? l.questions : JSON.stringify(l.questions)), l.pass_percent, l.required, l.module_id ? map.get(l.module_id) ?? null : null, l.max_attempts, l.shuffle, l.show_answers, l.auto_accept], db);
      await exec(`INSERT INTO files (id, org_id, uploader_user_id, original_name, mime_type, size_bytes, sha256, data, owner_type, owner_id) SELECT UUID(), org_id, $3, original_name, mime_type, size_bytes, sha256, data, 'lms_lesson', $2 FROM files WHERE owner_type = 'lms_lesson' AND owner_id = $1 AND deleted_at IS NULL`, [l.id, id, req.user!.id], db);
    }
    await audit({ orgId, actor: req.user, action: 'lms.course_duplicated', entityType: 'lms_course', entityId: nid, next: { from: src.id }, req }, db);
  });
  ok(res, { id: nid }, undefined, 201);
}));

// ------------------------------------------------------------------ announcements
router.get('/courses/:id/announcements', wrap(async (req, res) => {
  const c = await loadCourse(orgIdOf(req), parse(uuid, req.params.id));
  ok(res, await query(`SELECT a.id, a.title, a.body, a.created_at, u.full_name AS author FROM lms_announcements a JOIN users u ON u.id = a.created_by WHERE a.course_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [c.id]));
}));
router.post('/courses/:id/announcements', manage, limit('lms announce', 20), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const b = parse(z.object({ title: z.string().trim().min(2).max(160), body: z.string().trim().min(2).max(4000) }), req.body); const id = newId(); let sent = 0;
  await tx(async (db) => {
    await exec(`INSERT INTO lms_announcements (id, org_id, course_id, title, body, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, orgId, c.id, b.title, b.body, req.user!.id], db);
    const en = await query(`SELECT user_id, learner_id FROM lms_enrollments WHERE course_id = $1 AND status <> 'removed'`, [c.id], db);
    const note = { kind: 'lms.announcement', title: `${c.title}: ${b.title}`, body: b.body.slice(0, 200), link: `/learn/${c.id}` };
    const L = en.map((e) => e.learner_id).filter(Boolean) as string[]; const U = en.map((e) => e.user_id).filter(Boolean) as string[];
    if (L.length) sent += await notifyAbout(db, { orgId, learnerIds: L, ...note, excludeUserId: req.user!.id });
    if (U.length) { await notifyUsers(db, { orgId, userIds: U.filter((u) => u !== req.user!.id), ...note }); sent += U.length; }
    await audit({ orgId, actor: req.user, action: 'lms.announcement', entityType: 'lms_course', entityId: c.id, req }, db);
  }); ok(res, { id, notified: sent }, undefined, 201);
}));

// ------------------------------------------------------------------ gentle reminders
router.post('/courses/:id/nudge', manage, limit('lms nudge', 10), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const b = parse(z.object({ who: z.enum(['overdue', 'not_started', 'inactive']) }), req.body);
  const cond = b.who === 'overdue' ? `e.due_at IS NOT NULL AND e.due_at < NOW(3)` : b.who === 'not_started' ? `e.started_at IS NULL` : `e.started_at IS NOT NULL AND COALESCE(e.last_activity_at, e.started_at) < DATE_SUB(NOW(3), INTERVAL 7 DAY)`;
  let sent = 0;
  await tx(async (db) => {
    const en = await query(`SELECT e.id, e.user_id, e.learner_id FROM lms_enrollments e WHERE e.course_id = $1 AND e.org_id = $2 AND e.status = 'active' AND ${cond} LIMIT 2000`, [c.id, orgId], db);
    const link = `/learn/${c.id}`; const note = { kind: 'lms.nudge', title: `A nudge: ${c.title}`, body: b.who === 'overdue' ? 'This course is past its due date. Pick up where you left off.' : b.who === 'not_started' ? 'You have not started yet. It only takes a few minutes to begin.' : 'It has been a while. Pick up where you left off.', link };
    const recent = new Set((await query(`SELECT user_id FROM notifications WHERE org_id = $1 AND kind = 'lms.nudge' AND link = $2 AND created_at > DATE_SUB(NOW(3), INTERVAL 24 HOUR)`, [orgId, link], db)).map((r) => r.user_id as string));
    const L = en.map((e) => e.learner_id).filter(Boolean) as string[]; const U = en.map((e) => e.user_id).filter((u) => u && !recent.has(u)) as string[];
    if (L.length) { const before = Number((await queryOne(`SELECT COUNT(*) AS n FROM notifications WHERE org_id = $1 AND kind = 'lms.nudge' AND link = $2`, [orgId, link], db))!.n); await notifyAbout(db, { orgId, learnerIds: L, ...note }); sent += Number((await queryOne(`SELECT COUNT(*) AS n FROM notifications WHERE org_id = $1 AND kind = 'lms.nudge' AND link = $2`, [orgId, link], db))!.n) - before; }
    if (U.length) { await notifyUsers(db, { orgId, userIds: U, ...note }); sent += U.length; }
    await audit({ orgId, actor: req.user, action: 'lms.nudge', entityType: 'lms_course', entityId: c.id, next: { who: b.who, sent }, req }, db);
  }); ok(res, { notified: sent });
}));

// ------------------------------------------------------------------ work handed in
router.get('/submissions', wrap(async (req, res) => {
  const q = parse(z.object({ status: z.enum(['submitted', 'accepted', 'returned']).default('submitted'), course_id: uuid.optional() }), req.query); const orgId = orgIdOf(req); const p = new Params();
  const rows = await query(`SELECT s.id, s.status, s.body, s.feedback, s.updated_at, l.title AS lesson, c.id AS course_id, c.title AS course, COALESCE(le.full_name, u.full_name) AS name, e.learner_id
      FROM lms_submissions s JOIN lms_lessons l ON l.id = s.lesson_id JOIN lms_courses c ON c.id = l.course_id JOIN lms_enrollments e ON e.id = s.enrollment_id LEFT JOIN learners le ON le.id = e.learner_id LEFT JOIN users u ON u.id = e.user_id
     WHERE s.org_id = ${p.add(orgId)} AND s.status = ${p.add(q.status)} ${q.course_id ? `AND c.id = ${p.add(q.course_id)}` : ''} ORDER BY s.updated_at LIMIT 200`, p.values);
  const files = await filesFor('lms_submission', rows.map((r) => r.id)); ok(res, rows.map((r) => ({ ...r, files: files.get(r.id) ?? [] })));
}));
router.post('/submissions/:id/review', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const b = parse(z.object({ decision: z.enum(['accept', 'return']), feedback: z.string().trim().max(2000).nullish().transform((v) => v || null) }), req.body);
  if (b.decision === 'return' && !b.feedback) throw badRequest('Tell them what to improve.', [{ field: 'feedback', message: 'Add a short note.' }]);
  const out = await tx(async (db) => {
    const s = await queryOne(`SELECT s.id, s.enrollment_id, s.lesson_id, s.status, l.title FROM lms_submissions s JOIN lms_lessons l ON l.id = s.lesson_id WHERE s.id = $1 AND s.org_id = $2 FOR UPDATE`, [parse(uuid, req.params.id), orgId], db); if (!s) throw notFound('Submission');
    await exec(`UPDATE lms_submissions SET status = $2, feedback = $3, reviewed_by = $4, reviewed_at = NOW(3) WHERE id = $1`, [s.id, b.decision === 'accept' ? 'accepted' : 'returned', b.feedback, req.user!.id], db);
    const e = await queryOne(`SELECT id, org_id, course_id, learner_id, user_id, completed_at FROM lms_enrollments WHERE id = $1`, [s.enrollment_id], db);
    let result: any = null;
    if (b.decision === 'accept') { await markLessonDone(db, e!.id, s.lesson_id, null, true); result = await afterProgress(db, e!); }
    const note = { kind: 'lms.review', title: b.decision === 'accept' ? `Your work was accepted: ${s.title}` : `Please revise: ${s.title}`, body: b.feedback ?? 'Well done.', link: `/learn/${e!.course_id}` };
    if (e!.learner_id) await notifyAbout(db, { orgId, learnerIds: [e!.learner_id], ...note }); else if (e!.user_id) await notifyUsers(db, { orgId, userIds: [e!.user_id], ...note });
    await audit({ orgId, actor: req.user, action: `lms.work_${b.decision === 'accept' ? 'accepted' : 'returned'}`, entityType: 'lms_submission', entityId: s.id, req }, db);
    return { decision: b.decision, course_completed: !!result?.justCompleted };
  }); ok(res, out);
}));

// ------------------------------------------------------------------ discussion moderation, reviews
for (const a of ['pin', 'unpin', 'resolve', 'reopen', 'hide', 'unhide']) router.post(`/discussions/:id/${a}`, manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const set = { pin: 'pinned = TRUE', unpin: 'pinned = FALSE', resolve: 'resolved = TRUE', reopen: 'resolved = FALSE', hide: 'hidden_at = NOW(3)', unhide: 'hidden_at = NULL' }[a]!;
  const r = await exec(`UPDATE lms_discussions SET ${set} WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgId]); if (!r.affectedRows) throw notFound('Discussion');
  if (a === 'hide') await audit({ orgId, actor: req.user, action: 'lms.discussion_hidden', entityType: 'lms_discussion', entityId: String(req.params.id), req }); ok(res, { done: a });
}));
for (const a of ['hide', 'unhide']) router.post(`/replies/:id/${a}`, manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const r = await exec(`UPDATE lms_replies r JOIN lms_discussions d ON d.id = r.discussion_id SET r.hidden_at = ${a === 'hide' ? 'NOW(3)' : 'NULL'} WHERE r.id = $1 AND d.org_id = $2`, [parse(uuid, req.params.id), orgId]);
  if (!r.affectedRows) throw notFound('Reply'); await audit({ orgId, actor: req.user, action: `lms.reply_${a}`, entityType: 'lms_reply', entityId: String(req.params.id), req }); ok(res, { done: true });
}));
router.get('/courses/:id/reviews', wrap(async (req, res) => {
  const c = await loadCourse(orgIdOf(req), parse(uuid, req.params.id));
  ok(res, await query(`SELECT r.id, r.rating, r.comment, r.hidden_at, r.created_at, COALESCE(l.full_name, u.full_name) AS name FROM lms_reviews r LEFT JOIN learners l ON l.id = r.learner_id LEFT JOIN users u ON u.id = r.user_id WHERE r.course_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [c.id]));
}));
for (const a of ['hide', 'unhide']) router.post(`/reviews/:id/${a}`, manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const r = await exec(`UPDATE lms_reviews SET hidden_at = ${a === 'hide' ? 'NOW(3)' : 'NULL'} WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgId]);
  if (!r.affectedRows) throw notFound('Review'); await audit({ orgId, actor: req.user, action: `lms.review_${a}`, entityType: 'lms_review', entityId: String(req.params.id), req }); ok(res, { done: true });
}));

// ------------------------------------------------------------------ analytics
/** Where people drop off and which questions trip them up. */
router.get('/courses/:id/analytics', wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id));
  const enr = await queryOne(`SELECT COUNT(*) AS n, COALESCE(SUM(started_at IS NOT NULL), 0) AS started, COALESCE(SUM(status = 'completed'), 0) AS completed, COALESCE(SUM(status <> 'completed' AND due_at IS NOT NULL AND due_at < NOW(3)), 0) AS overdue FROM lms_enrollments WHERE course_id = $1 AND status <> 'removed'`, [c.id]);
  const total = Number(enr!.n);
  const lessons = await query(`SELECT l.id, l.title, l.kind, l.questions, l.required, (SELECT COUNT(*) FROM lms_progress p JOIN lms_enrollments e ON e.id = p.enrollment_id AND e.status <> 'removed' WHERE p.lesson_id = l.id AND p.completed_at IS NOT NULL) AS done,
      (SELECT AVG(p.best_score) FROM lms_progress p JOIN lms_enrollments e ON e.id = p.enrollment_id AND e.status <> 'removed' WHERE p.lesson_id = l.id AND p.best_score IS NOT NULL) AS avg_score,
      (SELECT COUNT(*) FROM lms_attempts a JOIN lms_enrollments e ON e.id = a.enrollment_id AND e.status <> 'removed' WHERE a.lesson_id = l.id) AS tries
    FROM lms_lessons l ${LESSON_JOIN} WHERE l.course_id = $1 AND l.deleted_at IS NULL ORDER BY ${LESSON_ORDER}`, [c.id]);
  const out = [];
  for (const l of lessons) {
    let questions: { q: string; percent_correct: number; answered: number }[] | undefined;
    if (l.kind === 'quiz' && Array.isArray(l.questions)) {
      const attempts = await query(`SELECT a.answers FROM lms_attempts a JOIN lms_enrollments e ON e.id = a.enrollment_id AND e.status <> 'removed' WHERE a.lesson_id = $1 ORDER BY a.created_at DESC LIMIT 2000`, [l.id]);
      questions = l.questions.map((q: any, i: number) => { const ans = attempts.map((a) => (typeof a.answers === 'string' ? JSON.parse(a.answers) : a.answers)[i]).filter((x: unknown) => typeof x === 'number'); return { q: q.q, answered: ans.length, percent_correct: ans.length ? Math.round((ans.filter((x: number) => x === q.answer).length / ans.length) * 100) : 0 }; });
    }
    out.push({ id: l.id, title: l.title, kind: l.kind, required: !!l.required, completed: Number(l.done), percent: total ? Math.round((Number(l.done) / total) * 100) : 0, avg_score: l.avg_score == null ? null : Math.round(Number(l.avg_score)), tries: Number(l.tries), ...(questions ? { questions } : {}) });
  }
  const rating = await queryOne(`SELECT AVG(rating) AS avg, COUNT(*) AS n FROM lms_reviews WHERE course_id = $1 AND hidden_at IS NULL`, [c.id]);
  const dist = await query(`SELECT rating, COUNT(*) AS n FROM lms_reviews WHERE course_id = $1 AND hidden_at IS NULL GROUP BY rating`, [c.id]);
  ok(res, { enrolled: total, started: Number(enr!.started), completed: Number(enr!.completed), overdue: Number(enr!.overdue), completion_percent: total ? Math.round((Number(enr!.completed) / total) * 100) : 0,
    rating: rating?.n ? { avg: Math.round(Number(rating.avg) * 10) / 10, count: Number(rating.n), distribution: [1, 2, 3, 4, 5].map((r) => Number(dist.find((d) => d.rating === r)?.n ?? 0)) } : null, lessons: out });
}));
export default router;
void AppError; void standing;
