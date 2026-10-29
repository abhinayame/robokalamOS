import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { notifyAbout, notifyUsers } from '../../lib/notify.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { resolveLearnerIds, selectorSchema } from '../selection/resolver.js';
import { enrollInCourse, resolveStaff } from './service.js';

/** Learning paths: courses in a set order. Assigning a path enrols the person in the first course; each later course unlocks when the one before it is finished. */
const router = Router(); // mounted at /api/lms/paths
router.use(requireOrg, requireAnyPerm('lms:read', 'lms:manage'));
const manage = requirePerm('lms:manage');
const pathBody = z.object({ title: z.string().trim().min(2, 'Name the path.').max(160), summary: z.string().trim().max(500).nullish().transform((v) => v || null), course_ids: z.array(uuid).min(1, 'Add at least one course.').max(20) });

async function loadPath(orgId: string, id: string, db?: any) {
  const p = await queryOne(`SELECT * FROM lms_paths WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId], db); if (!p) throw notFound('Path'); return p;
}
async function checkCourses(orgId: string, ids: string[], db?: any) {
  if (new Set(ids).size !== ids.length) throw badRequest('A course can only appear once on a path.');
  const rows = await query(`SELECT id FROM lms_courses WHERE org_id = $1 AND deleted_at IS NULL AND id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})`, [orgId, ...ids], db);
  if (rows.length !== ids.length) throw notFound('Course');
}
const stepsOf = (id: string, db?: any) => query(`SELECT c.id, c.title, c.status, c.audience, pc.position FROM lms_path_courses pc JOIN lms_courses c ON c.id = pc.course_id AND c.deleted_at IS NULL WHERE pc.path_id = $1 ORDER BY pc.position`, [id], db);

router.get('/', wrap(async (req, res) => {
  ok(res, await query(`SELECT p.id, p.title, p.summary, p.status, (SELECT COUNT(*) FROM lms_path_courses c WHERE c.path_id = p.id) AS courses,
      (SELECT COUNT(*) FROM lms_path_members m WHERE m.path_id = p.id AND m.removed_at IS NULL) AS members, (SELECT COUNT(*) FROM lms_path_members m WHERE m.path_id = p.id AND m.removed_at IS NULL AND m.completed_at IS NOT NULL) AS finished
    FROM lms_paths p WHERE p.org_id = $1 AND p.deleted_at IS NULL ORDER BY FIELD(p.status,'published','draft','archived'), p.title`, [orgIdOf(req)]));
}));
router.get('/:id', wrap(async (req, res) => { const p = await loadPath(orgIdOf(req), parse(uuid, req.params.id)); ok(res, { ...p, steps: await stepsOf(p.id) }); }));
router.post('/', manage, wrap(async (req, res) => {
  const b = parse(pathBody, req.body); const orgId = orgIdOf(req); await checkCourses(orgId, b.course_ids); const id = newId();
  await tx(async (db) => { await exec(`INSERT INTO lms_paths (id, org_id, title, summary, created_by) VALUES ($1,$2,$3,$4,$5)`, [id, orgId, b.title, b.summary, req.user!.id], db);
    for (const [i, c] of b.course_ids.entries()) await exec(`INSERT INTO lms_path_courses (path_id, course_id, org_id, position) VALUES ($1,$2,$3,$4)`, [id, c, orgId, i + 1], db); });
  await audit({ orgId, actor: req.user, action: 'lms.path_created', entityType: 'lms_path', entityId: id, next: { title: b.title }, req });
  ok(res, { id }, undefined, 201);
}));
router.patch('/:id', manage, wrap(async (req, res) => {
  const b = parse(z.object({ title: z.string().trim().min(2).max(160).optional(), summary: z.string().trim().max(500).nullish().transform((v) => (v === undefined ? undefined : v || null)), status: z.enum(['draft', 'published', 'archived']).optional(), course_ids: z.array(uuid).min(1).max(20).optional() }), req.body);
  const orgId = orgIdOf(req); const p = await loadPath(orgId, parse(uuid, req.params.id)); if (b.course_ids) await checkCourses(orgId, b.course_ids);
  await tx(async (db) => {
    const sets: string[] = []; const v: any[] = [p.id, orgId];
    for (const k of ['title', 'summary', 'status'] as const) if (b[k] !== undefined) { v.push(b[k]); sets.push(`${k} = $${v.length}`); }
    if (sets.length) await exec(`UPDATE lms_paths SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, v, db);
    if (b.course_ids) { await exec(`DELETE FROM lms_path_courses WHERE path_id = $1`, [p.id], db); for (const [i, c] of b.course_ids.entries()) await exec(`INSERT INTO lms_path_courses (path_id, course_id, org_id, position) VALUES ($1,$2,$3,$4)`, [p.id, c, orgId, i + 1], db); }
  });
  ok(res, { updated: true });
}));
router.delete('/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const p = await loadPath(orgId, parse(uuid, req.params.id));
  await exec(`UPDATE lms_paths SET deleted_at = NOW(3) WHERE id = $1`, [p.id]); await exec(`UPDATE lms_path_members SET removed_at = NOW(3) WHERE path_id = $1 AND removed_at IS NULL`, [p.id]);
  await audit({ orgId, actor: req.user, action: 'lms.path_deleted', entityType: 'lms_path', entityId: p.id, req }); ok(res, { deleted: true });
}));

router.post('/:id/assign', manage, limit('lms assign', 20), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const b = parse(z.object({ selector: selectorSchema.optional(), user_ids: z.array(uuid).max(500).default([]), roles: z.array(z.string().max(30)).max(5).default([]), all_staff: z.boolean().default(false), due_days: z.number().int().min(1).max(365).nullish(), dry_run: z.boolean().default(false), confirm: z.boolean().optional() }), req.body);
  if (!b.dry_run && b.confirm !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Review who will get this path and confirm.');
  if (!b.selector && !b.user_ids.length && !b.all_staff && !b.roles.length) throw badRequest('Choose who should take this path.');
  const out = await tx(async (db) => {
    const p = await loadPath(orgId, parse(uuid, req.params.id), db); if (p.status !== 'published') throw conflict('Publish the path before assigning it.', 'NOT_PUBLISHED');
    const steps = await stepsOf(p.id, db); if (steps.some((s) => s.status !== 'published')) throw conflict('Every course on the path must be published first.', 'COURSE_NOT_PUBLISHED');
    let learnerIds: string[] = []; let staffIds: string[] = [];
    if (b.selector) {
      if (steps.some((s) => s.audience === 'staff')) throw badRequest('A course on this path is for staff only, so it cannot be given to learners.');
      learnerIds = await resolveLearnerIds(req.user!, orgId, b.selector, db, 2001); if (learnerIds.length > 2000) throw badRequest('That selects more than 2000 learners. Narrow it down.');
    }
    if (b.user_ids.length || b.all_staff || b.roles.length) {
      if (steps.some((s) => s.audience === 'learners')) throw badRequest('A course on this path is for learners only, so it cannot be given to staff.');
      staffIds = await resolveStaff(db, orgId, { all: b.all_staff, roles: b.roles, userIds: b.user_ids });
    }
    const haveL = new Set((await query(`SELECT learner_id FROM lms_path_members WHERE path_id = $1 AND removed_at IS NULL AND learner_id IS NOT NULL`, [p.id], db)).map((r) => r.learner_id));
    const haveS = new Set((await query(`SELECT user_id FROM lms_path_members WHERE path_id = $1 AND removed_at IS NULL AND user_id IS NOT NULL`, [p.id], db)).map((r) => r.user_id));
    const newL = learnerIds.filter((i) => !haveL.has(i)); const newS = staffIds.filter((i) => !haveS.has(i));
    const sum = { learners: { selected: learnerIds.length, to_assign: newL.length, already: learnerIds.length - newL.length }, staff: { selected: staffIds.length, to_assign: newS.length, already: staffIds.length - newS.length } };
    if (b.dry_run) return { dry_run: true, ...sum };
    const due = b.due_days ? new Date(Date.now() + b.due_days * 86400_000) : null; const first = steps[0]!;
    for (const lid of newL) { await exec(`INSERT INTO lms_path_members (id, org_id, path_id, learner_id, assigned_by, due_days) VALUES ($1,$2,$3,$4,$5,$6)`, [newId(), orgId, p.id, lid, req.user!.id, b.due_days ?? null], db); await enrollInCourse(db, { orgId, courseId: first.id, who: { userId: null, learnerId: lid }, assignedBy: req.user!.id, dueAt: due }); }
    for (const uid of newS) { await exec(`INSERT INTO lms_path_members (id, org_id, path_id, user_id, assigned_by, due_days) VALUES ($1,$2,$3,$4,$5,$6)`, [newId(), orgId, p.id, uid, req.user!.id, b.due_days ?? null], db); await enrollInCourse(db, { orgId, courseId: first.id, who: { userId: uid, learnerId: null }, assignedBy: req.user!.id, dueAt: due }); }
    const note = { title: `New learning path: ${p.title}`, body: `${steps.length} course${steps.length === 1 ? '' : 's'}, one after another. Start with ${first.title}.`, link: '/learn' };
    if (newL.length) await notifyAbout(db, { orgId, learnerIds: newL, kind: 'lms.assigned', ...note, excludeUserId: req.user!.id });
    if (newS.length) await notifyUsers(db, { orgId, userIds: newS.filter((u) => u !== req.user!.id), kind: 'lms.assigned', ...note });
    await audit({ orgId, actor: req.user, action: 'lms.path_assigned', entityType: 'lms_path', entityId: p.id, next: { learners: newL.length, staff: newS.length }, req }, db);
    return { dry_run: false, ...sum };
  });
  ok(res, out, undefined, out.dry_run ? 200 : 201);
}));

/** Where everyone on a path stands: how many courses finished and which one they are on. */
router.get('/:id/progress', wrap(async (req, res) => {
  const orgId = orgIdOf(req); const p = await loadPath(orgId, parse(uuid, req.params.id)); const steps = await stepsOf(p.id);
  const rows = await query(`SELECT m.id, m.completed_at, COALESCE(l.full_name, u.full_name) AS name, m.user_id, m.learner_id,
      (SELECT COUNT(*) FROM lms_path_courses pc JOIN lms_enrollments e ON e.course_id = pc.course_id AND e.person_key = m.person_key AND e.status = 'completed' WHERE pc.path_id = m.path_id) AS done
    FROM lms_path_members m LEFT JOIN learners l ON l.id = m.learner_id LEFT JOIN users u ON u.id = m.user_id WHERE m.path_id = $1 AND m.org_id = $2 AND m.removed_at IS NULL ORDER BY name LIMIT 2000`, [p.id, orgId]);
  ok(res, { path: { id: p.id, title: p.title }, total: steps.length, rows: rows.map((r) => ({ id: r.id, name: r.name, kind: r.learner_id ? 'learner' : 'staff', done: Number(r.done), total: steps.length, finished: !!r.completed_at })) });
}));
export default router;
