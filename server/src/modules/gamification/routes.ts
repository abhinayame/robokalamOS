import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { batchScope, learnerScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { openRoom } from '../classroom/access.js';
import { awardBadge, awardXp, checkPoints, verifyTargets } from './awards.js';
import { DEFAULT_LEVELS, getLevels, levelFor } from './xp.js';

const router = Router();
router.use(requireOrg, requirePerm('gamification:read'));
const manage = requirePerm('gamification:manage');
const award = requirePerm('gamification:award');

async function visibleLearner(req: any, requested?: string) {
  const user = req.user!; const orgId = orgIdOf(req);
  const id = requested ?? user.access.ownLearnerIds[0];
  if (!id) throw badRequest('Choose a learner.', [{ field: 'learner_id', message: 'This is required.' }]);
  const p = new Params(); const sc = learnerScope(user, p, 'l');
  const l = await queryOne(`SELECT l.id, l.full_name FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgId)} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!l) throw notFound('Learner');
  return l as { id: string; full_name: string };
}
const sum = async (learnerId: string) => Number((await queryOne(`SELECT COALESCE(SUM(points), 0) AS n FROM xp_transactions WHERE learner_id = $1`, [learnerId]))!.n);

// ------------------------------------------------------------------ a learner's XP, level and ledger
router.get('/overview', wrap(async (req, res) => {
  const l = await visibleLearner(req, parse(z.object({ learner_id: uuid.optional() }), req.query).learner_id);
  const xp = await sum(l.id);
  const { levels } = await getLevels(orgIdOf(req));
  const badgeCount = Number((await queryOne(`SELECT COUNT(*) AS n FROM learner_badges WHERE learner_id = $1 AND revoked_at IS NULL`, [l.id]))!.n);
  const week = Number((await queryOne(`SELECT COALESCE(SUM(points), 0) AS n FROM xp_transactions WHERE learner_id = $1 AND created_at >= DATE_SUB(NOW(3), INTERVAL 7 DAY)`, [l.id]))!.n);
  ok(res, { learner: l, xp, xp_last_7_days: week, badges: badgeCount, ...levelFor(xp, levels) });
}));

router.get('/xp', wrap(async (req, res) => {
  const q = parse(z.object({ learner_id: uuid.optional(), page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25) }), req.query);
  const l = await visibleLearner(req, q.learner_id);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM xp_transactions WHERE learner_id = $1`, [l.id]))!.n);
  const rows = await query(
    `SELECT x.id, x.points, x.reason, x.source_type, x.created_at, x.batch_id, b.name AS batch_name, u.full_name AS awarded_by
       FROM xp_transactions x LEFT JOIN batches b ON b.id = x.batch_id LEFT JOIN users u ON u.id = x.created_by
      WHERE x.learner_id = $1 ORDER BY x.created_at DESC, x.id DESC LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, [l.id]);
  ok(res, rows, { page: q.page, page_size: q.page_size, total, balance: await sum(l.id) });
}));

const xpBody = z.object({
  batch_id: uuid.nullish(), learner_ids: z.array(uuid).min(1).max(500), points: z.number().int(),
  reason: z.string().trim().min(2, 'Say why (e.g. Class participation).').max(255), request_id: uuid.optional(),
});
router.post('/xp', award, wrap(async (req, res) => {
  const b = parse(xpBody, req.body);
  checkPoints(req, b.points);
  const out = await tx(async (db) => {
    const t = await verifyTargets(req, b.learner_ids, b.batch_id, db);
    return { ...(await awardXp(db, req, { ids: t.ids, batchId: b.batch_id, points: b.points, reason: b.reason, requestId: b.request_id })), learners: t.ids.length };
  });
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'xp.awarded', entityType: 'xp', entityId: null, next: { points: b.points, reason: b.reason, batch_id: b.batch_id, ...out }, req });
  ok(res, out, undefined, 201);
}));

// ------------------------------------------------------------------ badges
const badgeBody = z.object({
  name: z.string().trim().min(2, 'Name the badge.').max(120), description: z.string().trim().max(500).nullish(),
  icon: z.string().trim().min(1).max(16).default('🏆'), category: z.string().trim().max(60).nullish(),
  xp_reward: z.number().int().min(0).max(10_000).default(0), criteria: z.string().trim().max(500).nullish(),
  status: z.enum(['active', 'inactive', 'archived']).default('active'),
});
router.get('/badges', wrap(async (req, res) => {
  const canManage = req.user!.isSuperAdmin || req.user!.permissions.has('gamification:manage');
  const rows = await query(
    `SELECT b.id, b.name, b.description, b.icon, b.category, b.xp_reward, b.criteria, b.status, b.created_at,
            (SELECT COUNT(*) FROM learner_badges lb WHERE lb.badge_id = b.id AND lb.revoked_at IS NULL) AS awarded
       FROM badges b WHERE b.org_id = $1 ${canManage ? '' : `AND b.status = 'active'`} AND b.status <> 'archived' ORDER BY b.category, b.name LIMIT 500`, [orgIdOf(req)]);
  ok(res, rows.map((r) => ({ ...r, awarded: Number(r.awarded) })));
}));
const dupName = (e: any) => { if (e?.errno === 1062) throw conflict('A badge with that name already exists.', 'DUPLICATE_BADGE'); throw e; };
router.post('/badges', manage, wrap(async (req, res) => {
  const b = parse(badgeBody, req.body); const id = newId();
  await exec(`INSERT INTO badges (id, org_id, name, description, icon, category, xp_reward, criteria, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, orgIdOf(req), b.name, b.description ?? null, b.icon, b.category ?? null, b.xp_reward, b.criteria ?? null, b.status, req.user!.id]).catch(dupName);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'badge.created', entityType: 'badge', entityId: id, next: b, req });
  ok(res, { id }, undefined, 201);
}));
router.patch('/badges/:id', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const b = parse(badgeBody.partial(), req.body);
  if (!(await queryOne(`SELECT 1 FROM badges WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req)]))) throw notFound('Badge');
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of ['name', 'description', 'icon', 'category', 'xp_reward', 'criteria', 'status'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 2}`); }
  if (sets.length) await exec(`UPDATE badges SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req), ...vals]).catch(dupName);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'badge.updated', entityType: 'badge', entityId: id, next: b, req });
  ok(res, { id });
}));

router.post('/badges/:id/award', award, wrap(async (req, res) => {
  const b = parse(z.object({ batch_id: uuid.nullish(), learner_ids: z.array(uuid).min(1).max(500), reason: z.string().trim().max(500).nullish() }), req.body);
  const out = await tx(async (db) => {
    const t = await verifyTargets(req, b.learner_ids, b.batch_id, db);
    return awardBadge(db, req, { badgeId: parse(uuid, req.params.id), ids: t.ids, batchId: b.batch_id, reason: b.reason });
  });
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'badge.awarded', entityType: 'badge', entityId: req.params.id as string, next: { ...out, batch_id: b.batch_id }, req });
  ok(res, out, undefined, 201);
}));

/** Take a badge back (mistake, misconduct). Its XP is reversed in the ledger; both rows stay as the trail. */
router.post('/learner-badges/:id/revoke', award, wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(2, 'Say why.').max(255) }), req.body); const orgId = orgIdOf(req);
  const out = await tx(async (db) => {
    const lb = await queryOne(`SELECT lb.id, lb.learner_id, lb.batch_id, lb.awarded_by, lb.xp_awarded, bd.name FROM learner_badges lb JOIN badges bd ON bd.id = lb.badge_id WHERE lb.id = $1 AND lb.org_id = $2 AND lb.revoked_at IS NULL FOR UPDATE`, [parse(uuid, req.params.id), orgId], db);
    if (!lb) throw notFound('Badge award');
    const user = req.user!; const admin = user.isSuperAdmin || user.permissions.has('gamification:manage');
    if (!admin) {   // a teacher may only undo what falls inside their own batches
      if (!lb.batch_id) throw forbidden('Only admins can revoke this badge.');
      const room = await openRoom(req, lb.batch_id, db);
      if (!room.canManage) throw notFound('Badge award');
    }
    await exec(`UPDATE learner_badges SET revoked_at = NOW(3), revoked_by = $1, revoke_reason = $2 WHERE id = $3`, [user.id, b.reason, lb.id], db);
    const { setSourceXp } = await import('./xp.js');
    await setSourceXp(db, { orgId, learnerId: lb.learner_id, batchId: lb.batch_id, reason: `Badge: ${lb.name}`, sourceType: 'badge', sourceId: lb.id, target: 0, userId: user.id });
    return { id: lb.id };
  });
  await audit({ orgId, actor: req.user, action: 'badge.revoked', entityType: 'learner_badge', entityId: out.id, next: b, req });
  ok(res, { ...out, revoked: true });
}));

/** Achievement wall: everything a learner has earned, with who awarded it and why. */
router.get('/achievements', wrap(async (req, res) => {
  const l = await visibleLearner(req, parse(z.object({ learner_id: uuid.optional() }), req.query).learner_id);
  const rows = await query(
    `SELECT lb.id, lb.reason, lb.xp_awarded, lb.awarded_at, lb.batch_id, b.name AS batch_name, bd.id AS badge_id, bd.name, bd.description, bd.icon, bd.category, u.full_name AS awarded_by
       FROM learner_badges lb JOIN badges bd ON bd.id = lb.badge_id JOIN users u ON u.id = lb.awarded_by LEFT JOIN batches b ON b.id = lb.batch_id
      WHERE lb.learner_id = $1 AND lb.revoked_at IS NULL ORDER BY lb.awarded_at DESC, lb.id`, [l.id]);
  ok(res, rows, { learner: l });
}));

// ------------------------------------------------------------------ levels and settings
router.get('/levels', wrap(async (req, res) => { const { levels, custom } = await getLevels(orgIdOf(req)); ok(res, levels, { custom }); }));
router.put('/levels', manage, wrap(async (req, res) => {
  const b = parse(z.union([z.object({ reset: z.literal(true) }), z.object({ levels: z.array(z.object({ name: z.string().trim().min(1, 'Name every level.').max(80), min_xp: z.number().int().min(0).max(10_000_000) })).min(1).max(20) })]), req.body);
  const orgId = orgIdOf(req);
  if ('levels' in b) {
    if (b.levels[0].min_xp !== 0) throw badRequest('The first level must start at 0 XP.', [{ field: 'levels.0.min_xp', message: 'Must be 0.' }]);
    for (let i = 1; i < b.levels.length; i++) if (b.levels[i].min_xp <= b.levels[i - 1].min_xp) throw badRequest(`Level ${i + 1} must need more XP than level ${i}.`, [{ field: `levels.${i}.min_xp`, message: 'Must be higher than the previous level.' }]);
  }
  await tx(async (db) => {
    await exec(`DELETE FROM levels WHERE org_id = $1`, [orgId], db);
    if ('levels' in b) for (const [i, l] of b.levels.entries()) await exec(`INSERT INTO levels (id, org_id, level_no, name, min_xp) VALUES ($1,$2,$3,$4,$5)`, [newId(), orgId, i + 1, l.name, l.min_xp], db);
  });
  await audit({ orgId, actor: req.user, action: 'levels.updated', entityType: 'organization', entityId: orgId, next: 'levels' in b ? { levels: b.levels } : { reset: true }, req });
  const { levels, custom } = await getLevels(orgId);
  ok(res, levels, { custom, defaults: DEFAULT_LEVELS });
}));

async function leaderboardOn(orgId: string) { return !!(await queryOne(`SELECT leaderboard_enabled AS e FROM gamification_settings WHERE org_id = $1`, [orgId]))?.e; }
router.get('/settings', wrap(async (req, res) => ok(res, { leaderboard_enabled: await leaderboardOn(orgIdOf(req)) })));
router.put('/settings', manage, wrap(async (req, res) => {
  const b = parse(z.object({ leaderboard_enabled: z.boolean() }), req.body); const orgId = orgIdOf(req);
  await exec(`INSERT INTO gamification_settings (org_id, leaderboard_enabled, updated_by) VALUES ($1,$2,$3) ON DUPLICATE KEY UPDATE leaderboard_enabled = VALUES(leaderboard_enabled), updated_by = VALUES(updated_by)`, [orgId, b.leaderboard_enabled, req.user!.id]);
  await audit({ orgId, actor: req.user, action: 'gamification.settings_updated', entityType: 'organization', entityId: orgId, next: b, req });
  ok(res, b);
}));

// ------------------------------------------------------------------ leaderboard (optional, admin-controlled)
router.get('/leaderboard', wrap(async (req, res) => {
  const user = req.user!; const orgId = orgIdOf(req);
  if (!(await leaderboardOn(orgId))) throw new AppError(403, 'LEADERBOARD_DISABLED', 'Leaderboards are switched off for this organization.');
  const q = parse(z.object({ scope: z.enum(['batch', 'course', 'program', 'all']).default('batch'), id: uuid.optional(), period: z.enum(['week', 'month', 'all']).default('all'), limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
  const staff = user.isSuperAdmin || user.access.orgWide || user.access.branchIds.length > 0 || user.access.teacher;
  if (q.scope !== 'batch' && !staff) throw forbidden('Only your batch leaderboard is available to you.');
  if (q.scope !== 'all' && !q.id) throw badRequest('Choose what to rank.', [{ field: 'id', message: 'This is required.' }]);

  // Batches the caller may see that fall inside the requested scope.
  const bp = new Params();
  const w = [`b.org_id = ${bp.add(orgId)}`, 'b.deleted_at IS NULL'];
  if (q.scope === 'batch') w.push(`b.id = ${bp.add(q.id)}`); else if (q.scope === 'course') w.push(`b.course_id = ${bp.add(q.id)}`); else if (q.scope === 'program') w.push(`b.program_id = ${bp.add(q.id)}`);
  const sc = batchScope(user, bp, 'b'); if (sc) w.push(sc);
  const batchIds = (await query(`SELECT b.id FROM batches b WHERE ${w.join(' AND ')} LIMIT 5000`, bp.values)).map((r) => r.id as string);
  if (q.scope === 'batch' && !batchIds.length) throw notFound('Classroom');

  const since = q.period === 'week' ? 7 : q.period === 'month' ? 30 : null;
  const xp = new Params();
  const base = `FROM xp_transactions x JOIN learners l ON l.id = x.learner_id AND l.deleted_at IS NULL AND l.status = 'active'
      WHERE x.batch_id IN ${xp.in(batchIds)} ${since ? `AND x.created_at >= DATE_SUB(NOW(3), INTERVAL ${since} DAY)` : ''} GROUP BY x.learner_id, l.full_name HAVING SUM(x.points) > 0`;
  const top = batchIds.length ? await query(`SELECT x.learner_id, l.full_name, SUM(x.points) AS xp ${base} ORDER BY xp DESC, l.full_name, l.id LIMIT ${q.limit}`, xp.values) : [];
  const ids = top.map((r) => r.learner_id as string);
  const bc = new Map<string, number>();
  if (ids.length) {
    const p = new Params();
    for (const r of await query(`SELECT learner_id, COUNT(*) AS n FROM learner_badges WHERE revoked_at IS NULL AND learner_id IN ${p.in(ids)} ${since ? `AND awarded_at >= DATE_SUB(NOW(3), INTERVAL ${since} DAY)` : ''} GROUP BY learner_id`, p.values)) bc.set(r.learner_id, Number(r.n));
  }
  let rank = 0; let prev: number | null = null;
  const rows = top.map((r, i) => { const v = Number(r.xp); if (v !== prev) { rank = i + 1; prev = v; } return { rank, learner_id: r.learner_id, full_name: r.full_name, xp: v, badges: bc.get(r.learner_id) ?? 0, is_me: user.access.ownLearnerIds.includes(r.learner_id) }; });

  // Learners and parents always see where they stand, even outside the top N.
  const me: any[] = [];
  for (const lid of user.access.ownLearnerIds) {
    if (!batchIds.length || rows.some((r) => r.learner_id === lid)) continue;
    const p = new Params();
    const mine = await queryOne(`SELECT COALESCE(SUM(points), 0) AS xp FROM xp_transactions WHERE learner_id = ${p.add(lid)} AND batch_id IN ${p.in(batchIds)} ${since ? `AND created_at >= DATE_SUB(NOW(3), INTERVAL ${since} DAY)` : ''}`, p.values);
    const v = Number(mine!.xp); if (v <= 0) continue;
    const p2 = new Params();
    const ahead = await queryOne(`SELECT COUNT(*) AS n FROM (SELECT x.learner_id FROM xp_transactions x JOIN learners l ON l.id = x.learner_id AND l.deleted_at IS NULL AND l.status = 'active' WHERE x.batch_id IN ${p2.in(batchIds)} ${since ? `AND x.created_at >= DATE_SUB(NOW(3), INTERVAL ${since} DAY)` : ''} GROUP BY x.learner_id HAVING SUM(x.points) > ${p2.add(v)}) t`, p2.values);
    const nm = await queryOne(`SELECT full_name FROM learners WHERE id = $1`, [lid]);
    me.push({ rank: Number(ahead!.n) + 1, learner_id: lid, full_name: nm!.full_name, xp: v, is_me: true });
  }
  ok(res, rows, { scope: q.scope, period: q.period, batches: batchIds.length, me });
}));

export default router;
