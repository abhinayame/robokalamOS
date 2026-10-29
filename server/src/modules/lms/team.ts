import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { applyRule } from './auto.js';
import { enrollInCourse, resolveStaff, STAFF_ROLES } from './service.js';

/** Running training for a team: pick staff, take a course yourself, automatic assignment rules, and the team training matrix. */
const router = Router(); // mounted at /api/lms
router.use(requireOrg, requireAnyPerm('lms:read', 'lms:manage'));
const manage = requirePerm('lms:manage');

async function loadCourse(orgId: string, id: string) { const c = await queryOne(`SELECT * FROM lms_courses WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId]); if (!c) throw notFound('Course'); return c; }

/** Staff to choose from when assigning: name, e-mail and roles. */
router.get('/people', manage, wrap(async (req, res) => {
  const q = parse(z.object({ q: z.string().max(80).optional(), role: z.enum(STAFF_ROLES).optional() }), req.query); const p = new Params();
  const rows = await query(`SELECT u.id, u.full_name, u.email, GROUP_CONCAT(DISTINCT r.code ORDER BY r.code) AS roles FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id AND r.code IN ${p.in([...STAFF_ROLES])}
      WHERE u.org_id = ${p.add(orgIdOf(req))} AND u.status = 'active' AND u.deleted_at IS NULL ${q.q ? `AND (u.full_name LIKE ${p.add(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`)} OR u.email LIKE ${p.add(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`)})` : ''} ${q.role ? `AND EXISTS (SELECT 1 FROM user_roles u2 JOIN roles r2 ON r2.id = u2.role_id WHERE u2.user_id = u.id AND r2.code = ${p.add(q.role)})` : ''}
      GROUP BY u.id, u.full_name, u.email ORDER BY u.full_name LIMIT 100`, p.values);
  const counts = await query(`SELECT r.code, COUNT(DISTINCT u.id) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.org_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL GROUP BY r.code`, [orgIdOf(req)]);
  ok(res, rows.map((r) => ({ id: r.id, full_name: r.full_name, email: r.email, roles: String(r.roles).split(',') })), { role_counts: Object.fromEntries(counts.filter((c) => (STAFF_ROLES as readonly string[]).includes(c.code)).map((c) => [c.code, Number(c.n)])) });
}));

/** Take a published course yourself (an owner looking after the team can sit the same training). */
router.post('/courses/:id/enrol-me', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id));
  if (c.status !== 'published') throw new AppError(409, 'NOT_PUBLISHED', 'Publish the course first.');
  if (c.audience === 'learners') throw badRequest('This course is for learners only.');
  const made = await tx(async (db) => enrollInCourse(db, { orgId, courseId: c.id, who: { userId: req.user!.id, learnerId: null }, assignedBy: null, dueAt: null, source: 'self' }));
  if (made) await audit({ orgId, actor: req.user, action: 'lms.self_enrolled', entityType: 'lms_course', entityId: c.id, req });
  ok(res, { enrolled: true, already: !made }, undefined, made ? 201 : 200);
}));

// ------------------------------------------------------------------ auto-assign rules
router.get('/courses/:id/auto-rules', wrap(async (req, res) => {
  const c = await loadCourse(orgIdOf(req), parse(uuid, req.params.id));
  const rows = await query(`SELECT a.id, a.kind, a.ref, a.due_days, a.created_at, b.name AS batch_name FROM lms_auto_rules a LEFT JOIN batches b ON a.kind = 'batch' AND b.id = a.ref WHERE a.course_id = $1 ORDER BY a.kind, a.created_at`, [c.id]);
  ok(res, rows);
}));
router.post('/courses/:id/auto-rules', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); const b = parse(z.object({ kind: z.enum(['role', 'batch']), ref: z.string().min(2).max(36), due_days: z.number().int().min(1).max(365).nullish() }), req.body);
  if (b.kind === 'role') { if (!(STAFF_ROLES as readonly string[]).includes(b.ref)) throw badRequest('Pick a staff role.', [{ field: 'ref', message: 'Unknown role.' }]); if (c.audience === 'learners') throw badRequest('This course is for learners, so it cannot be given to staff.'); }
  else { if (c.audience === 'staff') throw badRequest('This course is for staff, so it cannot be given to a batch.'); if (!(await queryOne(`SELECT 1 FROM batches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [b.ref, orgId]))) throw notFound('Batch'); }
  const id = newId();
  try { await exec(`INSERT INTO lms_auto_rules (id, org_id, course_id, kind, ref, due_days, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, orgId, c.id, b.kind, b.ref, b.due_days ?? null, req.user!.id]); }
  catch (e: any) { if (e?.errno === 1062) throw new AppError(409, 'DUPLICATE', 'That rule already exists for this course.'); throw e; }
  await audit({ orgId, actor: req.user, action: 'lms.auto_rule_added', entityType: 'lms_course', entityId: c.id, next: { kind: b.kind, ref: b.ref }, req }); ok(res, { id }, undefined, 201);
}));
router.delete('/auto-rules/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const r = await exec(`DELETE FROM lms_auto_rules WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgId]); if (!r.affectedRows) throw notFound('Rule');
  await audit({ orgId, actor: req.user, action: 'lms.auto_rule_removed', entityType: 'lms_auto_rule', entityId: String(req.params.id), req }); ok(res, { deleted: true });
}));
/** Run every rule of the course over the people it covers today (new joiners are picked up by themselves afterwards). */
router.post('/courses/:id/auto-rules/apply', manage, limit('lms auto', 10), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCourse(orgId, parse(uuid, req.params.id)); if (c.status !== 'published') throw new AppError(409, 'NOT_PUBLISHED', 'Publish the course first.');
  const out = await tx(async (db) => { const rules = await query(`SELECT * FROM lms_auto_rules WHERE course_id = $1`, [c.id], db); let users = 0, learners = 0; for (const r of rules) { const x = await applyRule(db, r as any); users += x.users; learners += x.learners; } return { users, learners, rules: rules.length }; });
  await audit({ orgId, actor: req.user, action: 'lms.auto_rules_applied', entityType: 'lms_course', entityId: c.id, next: out, req }); ok(res, out);
}));

// ------------------------------------------------------------------ team training matrix
async function matrix(req: any) {
  const orgId = orgIdOf(req); const q = parse(z.object({ role: z.enum(STAFF_ROLES).optional(), q: z.string().max(80).optional() }), req.query);
  const courses = await query(`SELECT c.id, c.title, (SELECT COUNT(*) FROM lms_lessons l WHERE l.course_id = c.id AND l.required = TRUE AND l.deleted_at IS NULL) AS total FROM lms_courses c WHERE c.org_id = $1 AND c.deleted_at IS NULL AND c.status = 'published' AND c.audience IN ('staff','both') ORDER BY c.title LIMIT 12`, [orgId]);
  const p = new Params();
  const staff = await query(`SELECT u.id, u.full_name, u.email, GROUP_CONCAT(DISTINCT r.code ORDER BY r.code) AS roles FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id AND r.code IN ${p.in([...STAFF_ROLES])}
      WHERE u.org_id = ${p.add(orgId)} AND u.status = 'active' AND u.deleted_at IS NULL ${q.q ? `AND (u.full_name LIKE ${p.add(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`)} OR u.email LIKE ${p.add(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`)})` : ''} ${q.role ? `AND EXISTS (SELECT 1 FROM user_roles u2 JOIN roles r2 ON r2.id = u2.role_id WHERE u2.user_id = u.id AND r2.code = ${p.add(q.role)})` : ''}
      GROUP BY u.id, u.full_name, u.email ORDER BY u.full_name LIMIT 500`, p.values);
  const cells = new Map<string, any>();
  if (courses.length && staff.length) {
    const cp = new Params();
    for (const e of await query(`SELECT e.user_id, e.course_id, e.status, e.due_at, e.source, (SELECT COUNT(*) FROM lms_progress g JOIN lms_lessons x ON x.id = g.lesson_id AND x.deleted_at IS NULL AND x.required = TRUE WHERE g.enrollment_id = e.id AND g.completed_at IS NOT NULL) AS done
        FROM lms_enrollments e WHERE e.org_id = ${cp.add(orgId)} AND e.status <> 'removed' AND e.user_id IN ${cp.in(staff.map((s) => s.id))} AND e.course_id IN ${cp.in(courses.map((c) => c.id))}`, cp.values)) {
      const total = Number(courses.find((c) => c.id === e.course_id)!.total); const percent = e.status === 'completed' ? 100 : total ? Math.round((Number(e.done) / total) * 100) : 0;
      cells.set(`${e.user_id}|${e.course_id}`, { status: e.status === 'completed' ? 'done' : percent > 0 ? 'started' : 'assigned', percent, due_at: e.due_at, overdue: e.status !== 'completed' && !!e.due_at && new Date(e.due_at).getTime() < Date.now(), source: e.source });
    }
  }
  const rows = staff.map((s) => ({ user_id: s.id, name: s.full_name, email: s.email, roles: String(s.roles).split(','), cells: Object.fromEntries(courses.map((c) => [c.id, cells.get(`${s.id}|${c.id}`) ?? null])) }));
  const all = rows.flatMap((r) => Object.values(r.cells)).filter(Boolean) as any[];
  return { courses: courses.map((c) => ({ id: c.id, title: c.title })), rows, summary: { people: rows.length, assigned: all.length, done: all.filter((c) => c.status === 'done').length, overdue: all.filter((c) => c.overdue).length } };
}
router.get('/team', wrap(async (req, res) => ok(res, await matrix(req))));
router.get('/team.csv', wrap(async (req, res) => {
  const m = await matrix(req); const cell = (v: unknown) => { const t = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`; };
  const csv = [['Name', 'E-mail', 'Roles', ...m.courses.map((c) => c.title)].map(cell).join(','), ...m.rows.map((r) => [r.name, r.email, r.roles.join(' / '), ...m.courses.map((c) => { const x = r.cells[c.id]; return x ? `${x.status}${x.status === 'done' ? '' : ` ${x.percent}%`}${x.overdue ? ' (overdue)' : ''}` : 'not assigned'; })].map(cell).join(','))].join('\r\n');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'lms.team_exported', entityType: 'lms_course', entityId: 'team', req });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="team-training.csv"', 'Cache-Control': 'no-store' }).send('﻿' + csv + '\r\n');
}));
void resolveStaff;
export default router;
