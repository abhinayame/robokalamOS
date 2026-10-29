import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { notifyAbout, notifyUsers } from '../../lib/notify.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { resolveLearnerIds, selectorSchema } from '../selection/resolver.js';
import { standing } from './service.js';

const router = Router(); // mounted at /api/lms
router.use(requireOrg, requireAnyPerm('lms:read', 'lms:manage'));
const manage = requirePerm('lms:manage');
const httpsUrl = z.string().trim().max(500).url().refine((u) => /^https:\/\//i.test(u), 'Use a link that starts with https://');
const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #12263f.').transform((s) => s.toLowerCase());
const MAX_ASSIGN = 2000;

const courseBody = z.object({
  title: z.string().trim().min(2, 'Name the course.').max(160), summary: z.string().trim().max(500).nullish().transform((v) => v || null),
  audience: z.enum(['learners', 'staff', 'both']).default('learners'), color: color.default('#12263f'), certificate_design_id: uuid.nullish(),
});
const questionSchema = z.object({ q: z.string().trim().min(2).max(300), explanation: z.string().trim().max(500).nullish().transform((v) => v || null), options: z.array(z.string().trim().min(1).max(200)).min(2).max(6), answer: z.number().int().min(0) })
  .refine((x) => x.answer < x.options.length, { message: 'The correct answer must be one of the options.', path: ['answer'] });
const lessonBody = z.object({
  title: z.string().trim().min(2, 'Name the lesson.').max(160), kind: z.enum(['text', 'video', 'link', 'quiz', 'file', 'assignment']), body: z.string().trim().max(20000).nullish().transform((v) => v || null),
  url: httpsUrl.nullish().or(z.literal('').transform(() => null)), minutes: z.number().int().min(1).max(600).nullish(), required: z.boolean().default(true),
  pass_percent: z.number().int().min(1).max(100).default(70), questions: z.array(questionSchema).max(30).nullish(),
  module_id: uuid.nullish(), max_attempts: z.number().int().min(1).max(20).nullish(), shuffle: z.boolean().default(false), show_answers: z.boolean().default(true), auto_accept: z.boolean().default(true),
}).superRefine((b, ctx) => {
  if (b.kind === 'assignment' && !b.body) ctx.addIssue({ code: 'custom', path: ['body'], message: 'Write the instructions for the assignment.' });
  if ((b.kind === 'video' || b.kind === 'link') && !b.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Add the link.' });
  if (b.kind === 'text' && !b.body) ctx.addIssue({ code: 'custom', path: ['body'], message: 'Write the lesson text.' });
  if (b.kind === 'quiz' && !b.questions?.length) ctx.addIssue({ code: 'custom', path: ['questions'], message: 'Add at least one question.' });
});

/** A module must belong to the same course. */
async function checkModule(orgId: string, courseId: string, moduleId?: string | null) {
  if (!moduleId) return;
  if (!(await queryOne(`SELECT 1 FROM lms_modules WHERE id = $1 AND org_id = $2 AND course_id = $3 AND deleted_at IS NULL`, [moduleId, orgId, courseId]))) throw badRequest('That module is not part of this course.', [{ field: 'module_id', message: 'Pick a module of this course.' }]);
}

async function loadCourse(orgId: string, id: string, db?: any) {
  const c = await queryOne(`SELECT * FROM lms_courses WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId], db);
  if (!c) throw notFound('Course');
  return c;
}
async function checkDesign(orgId: string, id: string | null | undefined, db?: any) {
  if (id && !(await queryOne(`SELECT 1 FROM certificate_designs WHERE id = $1 AND org_id = $2 AND status = 'active'`, [id, orgId], db))) throw badRequest('That certificate design does not exist.', [{ field: 'certificate_design_id', message: 'Choose an active design.' }]);
}

router.get('/courses', wrap(async (req, res) => {
  ok(res, await query(`SELECT c.id, c.title, c.summary, c.audience, c.status, c.color, c.certificate_design_id, c.created_at,
      (SELECT COUNT(*) FROM lms_lessons l WHERE l.course_id = c.id AND l.deleted_at IS NULL) AS lessons,
      (SELECT COUNT(*) FROM lms_enrollments e WHERE e.course_id = c.id AND e.status <> 'removed') AS enrolled,
      (SELECT COUNT(*) FROM lms_enrollments e WHERE e.course_id = c.id AND e.status = 'completed') AS completed
    FROM lms_courses c WHERE c.org_id = $1 AND c.deleted_at IS NULL ORDER BY FIELD(c.status,'published','draft','archived'), c.title`, [orgIdOf(req)]));
}));
router.post('/courses', manage, wrap(async (req, res) => {
  const b = parse(courseBody, req.body); const orgId = orgIdOf(req); await checkDesign(orgId, b.certificate_design_id); const id = newId();
  await exec(`INSERT INTO lms_courses (id, org_id, title, summary, audience, color, certificate_design_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, orgId, b.title, b.summary, b.audience, b.color, b.certificate_design_id ?? null, req.user!.id]);
  await audit({ orgId, actor: req.user, action: 'lms.course_created', entityType: 'lms_course', entityId: id, next: { title: b.title }, req });
  ok(res, { id }, undefined, 201);
}));
router.get('/courses/:id', wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id));
  const lessons = await query(`SELECT id, position, title, kind, body, url, minutes, required, pass_percent, questions FROM lms_lessons WHERE course_id = $1 AND deleted_at IS NULL ORDER BY position, id`, [c.id]);
  ok(res, { ...c, lessons });
}));
router.patch('/courses/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.id); const cur = await loadCourse(orgId, id);
  const b = parse(z.object({ title: z.string().trim().min(2).max(160).optional(), summary: z.string().trim().max(500).nullish().transform((v) => (v === undefined ? undefined : v || null)), audience: z.enum(['learners', 'staff', 'both']).optional(), color: color.optional(), certificate_design_id: uuid.nullish(), status: z.enum(['draft', 'published', 'archived']).optional() }), req.body);
  if (b.certificate_design_id !== undefined) await checkDesign(orgId, b.certificate_design_id);
  if (b.status === 'published') {
    const n = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = $1 AND required = TRUE AND deleted_at IS NULL`, [id]))!.n);
    if (!n) throw badRequest('Add at least one required lesson before publishing.', [{ field: 'status', message: 'A published course needs a required lesson.' }]);
  }
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of ['title', 'summary', 'audience', 'color', 'certificate_design_id', 'status'] as const) if ((b as any)[k] !== undefined) { vals.push((b as any)[k] ?? null); sets.push(`${k} = $${vals.length + 2}`); }
  if (sets.length) await exec(`UPDATE lms_courses SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, [id, orgId, ...vals]);
  await audit({ orgId, actor: req.user, action: b.status && b.status !== cur.status ? `lms.course_${b.status}` : 'lms.course_updated', entityType: 'lms_course', entityId: id, next: b, req });
  ok(res, { id });
}));
router.delete('/courses/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.id); await loadCourse(orgId, id);
  await exec(`UPDATE lms_courses SET deleted_at = NOW(3), status = 'archived' WHERE id = $1 AND org_id = $2`, [id, orgId]);
  await audit({ orgId, actor: req.user, action: 'lms.course_deleted', entityType: 'lms_course', entityId: id, req });
  ok(res, { id, deleted: true });
}));

// ---- lessons
router.post('/courses/:id/lessons', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const b = parse(lessonBody, req.body); const id = newId();
  const pos = Number((await queryOne(`SELECT COALESCE(MAX(position), 0) AS p FROM lms_lessons WHERE course_id = $1`, [c.id]))!.p) + 1;
  await checkModule(orgId, c.id, b.module_id);
  await exec(`INSERT INTO lms_lessons (id, org_id, course_id, position, title, kind, body, url, minutes, questions, pass_percent, required, module_id, max_attempts, shuffle, show_answers, auto_accept) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, orgId, c.id, pos, b.title, b.kind, b.body, b.url ?? null, b.minutes ?? null, b.kind === 'quiz' ? JSON.stringify(b.questions) : null, b.pass_percent, b.required, b.module_id ?? null, b.max_attempts ?? null, b.shuffle, b.show_answers, b.auto_accept]);
  await audit({ orgId, actor: req.user, action: 'lms.lesson_added', entityType: 'lms_course', entityId: c.id, next: { title: b.title, kind: b.kind }, req });
  ok(res, { id, position: pos }, undefined, 201);
}));
router.put('/lessons/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.id); const b = parse(lessonBody, req.body);
  const cur = await queryOne(`SELECT course_id FROM lms_lessons WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId]); if (!cur) throw notFound('Lesson');
  await checkModule(orgId, cur.course_id, b.module_id);
  const r = await exec(`UPDATE lms_lessons SET title=$3, kind=$4, body=$5, url=$6, minutes=$7, questions=$8, pass_percent=$9, required=$10, module_id=$11, max_attempts=$12, shuffle=$13, show_answers=$14, auto_accept=$15 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [id, orgId, b.title, b.kind, b.body, b.url ?? null, b.minutes ?? null, b.kind === 'quiz' ? JSON.stringify(b.questions) : null, b.pass_percent, b.required, b.module_id ?? null, b.max_attempts ?? null, b.shuffle, b.show_answers, b.auto_accept]);
  if (!r.affectedRows) throw notFound('Lesson');
  await audit({ orgId, actor: req.user, action: 'lms.lesson_updated', entityType: 'lms_lesson', entityId: id, req });
  ok(res, { id });
}));
router.delete('/lessons/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.id);
  const r = await exec(`UPDATE lms_lessons SET deleted_at = NOW(3) WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId]);
  if (!r.affectedRows) throw notFound('Lesson');
  await audit({ orgId, actor: req.user, action: 'lms.lesson_removed', entityType: 'lms_lesson', entityId: id, req });
  ok(res, { id, deleted: true });
}));
router.post('/courses/:id/lessons/reorder', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const b = parse(z.object({ ids: z.array(uuid).min(1).max(500) }), req.body);
  await tx(async (db) => {
    const cur = (await query(`SELECT id FROM lms_lessons WHERE course_id = $1 AND deleted_at IS NULL FOR UPDATE`, [c.id], db)).map((r) => r.id as string);
    if (cur.length !== b.ids.length || new Set(b.ids).size !== b.ids.length || !b.ids.every((i) => cur.includes(i))) throw conflict('The list changed. Reload and try again.', 'STALE_ORDER');
    for (const [i, lid] of b.ids.entries()) await exec(`UPDATE lms_lessons SET position = $2 WHERE id = $1`, [lid, i + 1], db);
  });
  ok(res, { reordered: b.ids.length });
}));

// ---- assigning: learners through the usual selector, staff by person or all at once
router.post('/courses/:id/assign', manage, limit('lms assign', 20), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const b = parse(z.object({ selector: selectorSchema.optional(), user_ids: z.array(uuid).max(500).default([]), all_staff: z.boolean().default(false), due_at: z.string().datetime({ offset: true }).nullish(), dry_run: z.boolean().default(false), confirm: z.boolean().optional() }), req.body);
  if (!b.dry_run && b.confirm !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Review who will get this course and confirm.');
  if (!b.selector && !b.user_ids.length && !b.all_staff) throw badRequest('Choose who should take this course.');
  const out = await tx(async (db) => {
    const c = await loadCourse(orgId, parse(uuid, req.params.id), db);
    if (c.status !== 'published') throw conflict('Publish the course before assigning it.', 'NOT_PUBLISHED');
    const due = b.due_at ? new Date(b.due_at) : null; if (due && due.getTime() < Date.now() - 60_000) throw badRequest('The due date is in the past.', [{ field: 'due_at', message: 'Pick a future date.' }]);
    let learnerIds: string[] = [];
    if (b.selector) {
      if (c.audience === 'staff') throw badRequest('This course is for staff only.');
      learnerIds = await resolveLearnerIds(req.user!, orgId, b.selector, db, MAX_ASSIGN + 1); if (learnerIds.length > MAX_ASSIGN) throw badRequest(`That selects more than ${MAX_ASSIGN} learners. Narrow it down.`);
    }
    let staffIds: string[] = [];
    if (b.user_ids.length || b.all_staff) {
      if (c.audience === 'learners') throw badRequest('This course is for learners only.');
      const p = new Params();
      staffIds = (await query(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.org_id = ${p.add(orgId)} AND u.status = 'active' AND u.deleted_at IS NULL AND r.code IN ('teacher','counsellor','accountant','branch_admin','org_admin') ${b.all_staff ? '' : `AND u.id IN ${p.in(b.user_ids)}`}`, p.values, db)).map((r) => r.id as string);
    }
    const lp = new Params(); const haveL = new Set(learnerIds.length ? (await query(`SELECT learner_id FROM lms_enrollments WHERE course_id = ${lp.add(c.id)} AND status <> 'removed' AND learner_id IN ${lp.in(learnerIds)}`, lp.values, db)).map((r) => r.learner_id) : []);
    const sp = new Params(); const haveS = new Set(staffIds.length ? (await query(`SELECT user_id FROM lms_enrollments WHERE course_id = ${sp.add(c.id)} AND status <> 'removed' AND user_id IN ${sp.in(staffIds)}`, sp.values, db)).map((r) => r.user_id) : []);
    const newL = learnerIds.filter((i) => !haveL.has(i)); const newS = staffIds.filter((i) => !haveS.has(i));
    const sum = { learners: { selected: learnerIds.length, to_assign: newL.length, already: haveL.size }, staff: { selected: staffIds.length, to_assign: newS.length, already: haveS.size } };
    if (b.dry_run) return { dry_run: true, ...sum };
    for (const lid of newL) await exec(`INSERT INTO lms_enrollments (id, org_id, course_id, learner_id, assigned_by, due_at) VALUES ($1,$2,$3,$4,$5,$6)`, [newId(), orgId, c.id, lid, req.user!.id, due], db);
    for (const uid of newS) await exec(`INSERT INTO lms_enrollments (id, org_id, course_id, user_id, assigned_by, due_at) VALUES ($1,$2,$3,$4,$5,$6)`, [newId(), orgId, c.id, uid, req.user!.id, due], db);
    if (newL.length) await notifyAbout(db, { orgId, learnerIds: newL, kind: 'lms.assigned', title: `New course: ${c.title}`, body: due ? `Please finish by ${due.toISOString().slice(0, 10)}.` : 'Start whenever you are ready.', link: '/learn', excludeUserId: req.user!.id });
    if (newS.length) await notifyUsers(db, { orgId, userIds: newS.filter((u) => u !== req.user!.id), kind: 'lms.assigned', title: `New course: ${c.title}`, body: due ? `Please finish by ${due.toISOString().slice(0, 10)}.` : 'Start whenever you are ready.', link: '/learn' });
    await audit({ orgId, actor: req.user, action: 'lms.assigned', entityType: 'lms_course', entityId: c.id, next: { learners: newL.length, staff: newS.length }, req }, db);
    return { dry_run: false, ...sum };
  });
  ok(res, out, undefined, out.dry_run ? 200 : 201);
}));

// ---- progress of everyone on a course
async function progressRows(req: any, courseId: string) {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, courseId);
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l'); const orgWide = req.user!.isSuperAdmin || req.user!.access.orgWide;
  const rows = await query(`SELECT e.id, e.status, e.due_at, e.started_at, e.completed_at, e.last_activity_at, e.user_id, e.learner_id, COALESCE(l.full_name, u.full_name) AS name, COALESCE(l.learner_code, u.email) AS ref,
      (SELECT COUNT(*) FROM lms_progress g JOIN lms_lessons x ON x.id = g.lesson_id AND x.deleted_at IS NULL AND x.required = TRUE WHERE g.enrollment_id = e.id AND g.completed_at IS NOT NULL) AS done
    FROM lms_enrollments e LEFT JOIN learners l ON l.id = e.learner_id LEFT JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ${p.add(c.id)} AND e.org_id = ${p.add(orgId)} AND e.status <> 'removed' AND (e.user_id IS NOT NULL ${orgWide ? '' : 'AND FALSE'} OR e.learner_id IS NOT NULL ${sc ? `AND ${sc}` : ''})
    ORDER BY name LIMIT 2000`, p.values);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_lessons WHERE course_id = $1 AND required = TRUE AND deleted_at IS NULL`, [c.id]))!.n);
  const now = Date.now();
  return { course: { id: c.id, title: c.title }, total_lessons: total, rows: rows.map((r) => ({ id: r.id, name: r.name, ref: r.ref, kind: r.learner_id ? 'learner' : 'staff', status: r.status, done: Number(r.done), total, percent: total ? Math.round((Number(r.done) / total) * 100) : 0, due_at: r.due_at, overdue: !!r.due_at && r.status !== 'completed' && new Date(r.due_at).getTime() < now, last_activity_at: r.last_activity_at, completed_at: r.completed_at })) };
}
router.get('/courses/:id/progress', wrap(async (req, res) => {
  const d = await progressRows(req, parse(uuid, req.params.id)); const n = d.rows.length;
  ok(res, { ...d, summary: { enrolled: n, completed: d.rows.filter((r) => r.status === 'completed').length, not_started: d.rows.filter((r) => r.done === 0).length, overdue: d.rows.filter((r) => r.overdue).length, average_percent: n ? Math.round(d.rows.reduce((s, r) => s + r.percent, 0) / n) : 0 } });
}));
router.get('/courses/:id/progress.csv', wrap(async (req, res) => {
  const d = await progressRows(req, parse(uuid, req.params.id));
  const cell = (v: unknown) => { const t = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`; };
  const csv = [['Name', 'Reference', 'Type', 'Status', 'Lessons done', 'Lessons required', 'Percent', 'Due', 'Last activity', 'Completed'].join(','), ...d.rows.map((r) => [r.name, r.ref, r.kind, r.status, r.done, r.total, r.percent, r.due_at ? new Date(r.due_at).toISOString().slice(0, 10) : '', r.last_activity_at ? new Date(r.last_activity_at).toISOString().slice(0, 10) : '', r.completed_at ? new Date(r.completed_at).toISOString().slice(0, 10) : ''].map(cell).join(','))].join('\r\n');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'lms.progress_exported', entityType: 'lms_course', entityId: d.course.id, req });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="course-progress.csv"`, 'Cache-Control': 'no-store' }).send('﻿' + csv + '\r\n');
}));
router.delete('/enrollments/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const r = await exec(`UPDATE lms_enrollments SET status = 'removed' WHERE id = $1 AND org_id = $2 AND status <> 'removed'`, [parse(uuid, req.params.id), orgId]);
  if (!r.affectedRows) throw notFound('Enrollment');
  await audit({ orgId, actor: req.user, action: 'lms.enrollment_removed', entityType: 'lms_enrollment', entityId: String(req.params.id), req });
  ok(res, { removed: true });
}));
export default router;
