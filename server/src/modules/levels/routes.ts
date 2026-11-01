import { Router } from 'express';
import { z } from 'zod';
import { Params, newId, query, queryOne, tx, exec } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { notifyAbout } from '../../lib/notify.js';
import { learnerScope } from '../../lib/scope.js';
import { recordActivity } from '../../lib/timeline.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { enrollLearners, removeLearners } from '../batches/enrollment.js';
import { checkDiscountAllowed } from '../fees/adjust.js';
import { assignPlan } from '../fees/service.js';
import { fromPaise, toPaise } from '../fees/money.js';
import { awardBadge } from '../gamification/awards.js';

/**
 * A learner's years with the school as one journey: every batch and level in order, how long they have been here, what they paid at each
 * level, and a single "move up a level" action that finishes the old batch, joins the new one, can bill the next level (with a discount),
 * and gives a "Level N complete" badge they can share as a picture.
 */
const router = Router(); // mounted at /api/levels
router.use(requireOrg);
const seeAll = requireAnyPerm('learner:read', 'portal:learner', 'portal:parent');

async function visible(req: any, id: string) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const l = await queryOne(`SELECT l.id, l.full_name, l.learner_code, l.created_at FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!l) throw notFound('Learner');
  return l;
}
const months = (from: Date, to = new Date()) => Math.max(0, (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) - (to.getDate() < from.getDate() ? 1 : 0));

router.get('/learners/:id/journey', seeAll, wrap(async (req, res) => {
  const l = await visible(req, parse(uuid, req.params.id)); const orgId = orgIdOf(req);
  const rows = await query(`SELECT m.id, m.batch_id, m.status, m.joined_at, m.left_at, b.name AS batch_name, b.batch_code, c.id AS course_id, c.name AS course_name, c.level_no, p.name AS program_name,
      (SELECT COALESCE(SUM(f.net_amount), 0) FROM learner_fees f WHERE f.learner_id = m.learner_id AND f.batch_id = m.batch_id AND f.status = 'active') AS fee_net,
      (SELECT COALESCE(SUM(i.paid_amount), 0) FROM learner_fees f JOIN fee_installments i ON i.learner_fee_id = f.id AND i.status <> 'cancelled' WHERE f.learner_id = m.learner_id AND f.batch_id = m.batch_id AND f.status = 'active') AS fee_paid,
      (SELECT COALESCE(SUM(f.discount_amount), 0) FROM learner_fees f WHERE f.learner_id = m.learner_id AND f.batch_id = m.batch_id AND f.status = 'active') AS fee_discount
    FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id JOIN courses c ON c.id = b.course_id JOIN programs p ON p.id = c.program_id
    WHERE m.learner_id = $1 AND m.org_id = $2 ORDER BY m.joined_at, m.id`, [l.id, orgId]);
  const certs = Number((await queryOne(`SELECT COUNT(*) AS n FROM certificates WHERE learner_id = $1 AND revoked_at IS NULL`, [l.id]))!.n);
  const badges = await query(`SELECT lb.id, bd.name, bd.icon, lb.awarded_at FROM learner_badges lb JOIN badges bd ON bd.id = lb.badge_id WHERE lb.learner_id = $1 AND lb.revoked_at IS NULL AND bd.category = 'Levels' ORDER BY lb.awarded_at`, [l.id]);
  const first = rows[0] ? new Date(rows[0].joined_at) : new Date(l.created_at); const active = rows.filter((r) => r.status === 'active');
  const totalNet = rows.reduce((s, r) => s + toPaise(r.fee_net), 0); const totalPaid = rows.reduce((s, r) => s + toPaise(r.fee_paid), 0);
  ok(res, { learner: { id: l.id, full_name: l.full_name, learner_code: l.learner_code }, since: first.toISOString(), months_with_us: months(first),
    current_level: active.reduce((m, r) => Math.max(m, r.level_no ?? 0), 0) || null, levels_finished: rows.filter((r) => r.status === 'completed').length, certificates: certs, level_badges: badges,
    fees: { net: fromPaise(totalNet), paid: fromPaise(totalPaid), discount: fromPaise(rows.reduce((s, r) => s + toPaise(r.fee_discount), 0)) },
    steps: rows.map((r) => ({ id: r.id, batch_id: r.batch_id, batch_name: r.batch_name, batch_code: r.batch_code, course_name: r.course_name, program_name: r.program_name, level_no: r.level_no, status: r.status, joined_at: r.joined_at, left_at: r.left_at, fee_net: r.fee_net, fee_paid: r.fee_paid, fee_discount: r.fee_discount })) });
}));

/** Batches this learner could move up to: later levels of the same program that are open, with seats. */
router.get('/learners/:id/next-batches', requirePerm('batch:enroll'), wrap(async (req, res) => {
  const l = await visible(req, parse(uuid, req.params.id)); const orgId = orgIdOf(req);
  const cur = await queryOne(`SELECT c.program_id, MAX(c.level_no) AS lv FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id JOIN courses c ON c.id = b.course_id WHERE m.learner_id = $1 AND m.org_id = $2 AND m.status IN ('active','completed') GROUP BY c.program_id ORDER BY MAX(m.joined_at) DESC LIMIT 1`, [l.id, orgId]);
  const rows = await query(`SELECT b.id, b.name, b.batch_code, b.status, b.capacity, c.name AS course_name, c.level_no, c.program_id, p.name AS program_name,
      (SELECT COUNT(*) FROM learner_batch_memberships x WHERE x.batch_id = b.id AND x.status = 'active') AS filled,
      EXISTS (SELECT 1 FROM learner_batch_memberships y WHERE y.batch_id = b.id AND y.learner_id = $2 AND y.status = 'active') AS already
    FROM batches b JOIN courses c ON c.id = b.course_id AND c.deleted_at IS NULL JOIN programs p ON p.id = c.program_id
    WHERE b.org_id = $1 AND b.deleted_at IS NULL AND b.status IN ('active','upcoming') ORDER BY (c.program_id = $3) DESC, c.level_no, b.name LIMIT 200`, [orgId, l.id, cur?.program_id ?? '-']);
  const lv = cur?.lv == null ? 0 : Number(cur.lv);
  ok(res, rows.filter((r) => !r.already).map((r) => ({ id: r.id, name: r.name, batch_code: r.batch_code, course_name: r.course_name, program_name: r.program_name, level_no: r.level_no, seats_left: r.capacity == null ? null : Math.max(0, r.capacity - Number(r.filled)),
    suggested: r.program_id === cur?.program_id && r.level_no != null && r.level_no > lv })), { current_level: lv || null });
}));

router.post('/learners/:id/promote', requirePerm('batch:enroll'), wrap(async (req, res) => {
  const b = parse(z.object({ to_batch_id: uuid, from_batch_id: uuid.nullish(), plan_id: uuid.nullish(), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), discount: z.object({ type: z.enum(['percent', 'amount']), value: z.number().positive(), reason: z.string().trim().max(200).nullish() }).nullish(), note: z.string().trim().max(200).nullish() }), req.body);
  const l = await visible(req, parse(uuid, req.params.id)); const orgId = orgIdOf(req); const u = req.user!;
  if (b.plan_id && !(u.isSuperAdmin || u.permissions.has('fee:manage'))) throw forbidden('You are not allowed to bill fees.');
  if (b.discount && !b.plan_id) throw badRequest('Choose a fee plan to give a discount on.');
  const out = await tx(async (db) => {
    const to = await queryOne(`SELECT b.id, b.name, c.id AS course_id, c.name AS course_name, c.level_no FROM batches b JOIN courses c ON c.id = b.course_id WHERE b.id = $1 AND b.org_id = $2 AND b.deleted_at IS NULL`, [b.to_batch_id, orgId], db);
    if (!to) throw notFound('Batch');
    const from = await queryOne(`SELECT b.id, b.name, c.name AS course_name, c.level_no FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id JOIN courses c ON c.id = b.course_id
        WHERE m.learner_id = $1 AND m.org_id = $2 AND m.status = 'active' AND m.batch_id <> $3 ${b.from_batch_id ? 'AND m.batch_id = $4' : 'AND (c.level_no IS NULL OR $5 IS NULL OR c.level_no < $5)'} ORDER BY c.level_no DESC, m.joined_at DESC LIMIT 1`,
      b.from_batch_id ? [l.id, orgId, b.to_batch_id, b.from_batch_id] : [l.id, orgId, b.to_batch_id, null, to.level_no ?? null], db);
    if (b.from_batch_id && !from) throw conflict('The learner is not in the batch you are moving up from.', 'NOT_A_MEMBER');
    const c = { db, user: u, orgId, req };
    if (from) await removeLearners(c, from.id, [l.id], { status: 'completed', reason: b.note ?? 'Moved up a level' });
    const joined = await enrollLearners(c, to.id, [l.id], from ? { transferredFrom: { id: from.id, name: from.name } } : {});
    if (!joined.joined && !joined.rejoined) throw conflict('The learner is already in that batch.', 'ALREADY_MEMBER');
    let fee: any = null;
    if (b.plan_id) {
      const plan = await queryOne(`SELECT total_amount FROM fee_plans WHERE id = $1 AND org_id = $2`, [b.plan_id, orgId], db); if (!plan) throw notFound('Fee plan');
      const gross = toPaise(plan.total_amount); const dP = !b.discount ? 0 : b.discount.type === 'amount' ? toPaise(b.discount.value) : Math.round((gross * Math.min(b.discount.value, 100)) / 100);
      if (dP > 0) await checkDiscountAllowed(db, orgId, u, (dP / gross) * 100);
      fee = await assignPlan(db, { orgId, user: u, req }, { planId: b.plan_id, learnerIds: [l.id], batchId: to.id, startDate: b.start_date ?? new Date().toISOString().slice(0, 10), discountPaise: dP, discountType: b.discount?.type ?? null, discountValue: b.discount?.value ?? null, discountReason: b.discount?.reason ?? null, levelLabel: to.level_no ? `Level ${to.level_no}` : null }, false);
    }
    // a "Level N complete" badge, made the first time it is needed, so the family has something to celebrate and share
    let badge: { learner_badge_id: string | null; name: string } | null = null;
    if (from) {
      const label = from.level_no ? `Level ${from.level_no} complete` : `${from.course_name} complete`;
      let bd = await queryOne(`SELECT id FROM badges WHERE org_id = $1 AND name = $2`, [orgId, label], db);
      if (!bd) { const id = newId(); await exec(`INSERT INTO badges (id, org_id, name, description, icon, category, xp_reward, status, created_by) VALUES ($1,$2,$3,$4,'🏅','Levels',100,'active',$5)`, [id, orgId, label, 'Finished a level and moved up.', u.id], db); bd = { id }; }
      await awardBadge(db, req, { badgeId: bd.id, ids: [l.id], batchId: from.id, reason: `Finished ${from.course_name}${to.level_no ? ` and moved up to Level ${to.level_no}` : ''}` });
      badge = { learner_badge_id: (await queryOne(`SELECT id FROM learner_badges WHERE learner_id = $1 AND badge_id = $2 AND revoked_at IS NULL ORDER BY awarded_at DESC LIMIT 1`, [l.id, bd.id], db))?.id ?? null, name: label };
    }
    await notifyAbout(db, { orgId, learnerIds: [l.id], kind: 'level.promoted', title: `Welcome to ${to.level_no ? `Level ${to.level_no}` : to.course_name}!`, body: `${to.name} starts a new chapter. Well done on finishing ${from?.course_name ?? 'the last one'}.`, link: '/achievements', excludeUserId: u.id });
    await recordActivity(db, { orgId, learnerId: l.id, batchId: to.id, type: 'level.promoted', title: `Moved up to ${to.level_no ? `Level ${to.level_no}: ` : ''}${to.course_name}`, description: from ? `From ${from.name}` : null, actorUserId: u.id });
    await audit({ orgId, actor: u, action: 'learner.promoted', entityType: 'learner', entityId: l.id, next: { from: from?.id ?? null, to: to.id, plan_id: b.plan_id ?? null, discount: b.discount ?? null }, req }, db);
    return { learner_id: l.id, from: from ? { id: from.id, name: from.name, level_no: from.level_no } : null, to: { id: to.id, name: to.name, level_no: to.level_no, course_name: to.course_name }, fee, badge };
  });
  ok(res, out, undefined, 201);
}));
export default router;
