import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { enrollLearners } from '../batches/enrollment.js';
import { changeStatus } from '../crm/routes.js';
import { ensureLead, logCrmActivity } from '../crm/service.js';
import { METHODS, applyPayment, assignPlan, orgInfo } from '../fees/service.js';

import { toPaise, todayIn } from '../fees/money.js';

const router = Router(); // mounted at /api/admissions
router.use(requireOrg, requirePerm('crm:manage'));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const body = z.object({
  batch_id: uuid, plan_id: uuid.nullish(), start_date: date.optional(),
  discount: z.object({ type: z.enum(['amount', 'percent']), value: z.number().min(0) }).optional(),
  payment: z.object({ amount: z.number().positive().max(10_000_000), method: z.enum(METHODS), reference: z.string().trim().max(120).nullish(), request_id: z.string().trim().max(64).optional() }).nullish(),
  dry_run: z.boolean().default(false), confirm: z.boolean().optional(),
});

const can = (req: any, perm: string) => req.user.isSuperAdmin || req.user.permissions.has(perm);

/**
 * Admission = one decision: put the lead in a batch, give them a fee plan, optionally take the first payment, and mark them converted.
 * All of it happens in ONE transaction, so a refused step (batch full, bad payment) leaves nothing half-done.
 * Re-running is safe: an existing seat and an existing fee are kept, never doubled.
 */
router.post('/enrol/:learnerId', limit('admission', 30), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const learnerId = parse(uuid, req.params.learnerId); const b = parse(body, req.body);
  if (b.plan_id && !can(req, 'fee:manage')) throw forbidden('Giving a fee plan needs the fee permission.');
  if (b.payment && !(b.plan_id || await queryOne(`SELECT 1 FROM learner_fees WHERE learner_id = $1 AND status = 'active' LIMIT 1`, [learnerId]))) throw badRequest('Choose a fee plan before taking a payment.', [{ field: 'payment', message: 'The learner has no fee to pay yet.' }]);
  if (b.payment && !can(req, 'payment:record')) throw forbidden('Recording a payment needs the payment permission.');
  if (!b.dry_run && b.confirm !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Review the admission and confirm.');

  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const learner = await queryOne(`SELECT l.id, l.full_name, l.learner_code FROM learners l WHERE l.id = ${p.add(learnerId)} AND l.org_id = ${p.add(orgId)} AND l.deleted_at IS NULL AND l.status <> 'archived' ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!learner) throw notFound('Learner');
  const org = await orgInfo(orgId);
  const start = b.start_date ?? todayIn(org.tz);
  const discountP: number | null = b.discount ? (b.discount.type === 'amount' ? toPaise(b.discount.value) : null) : 0;
  const ctx = { orgId, user: req.user!, req };

  const out = await tx(async (db) => {
    const batch = await queryOne(`SELECT b.id, b.name, b.capacity, b.status, (SELECT COUNT(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS seated FROM batches b WHERE b.id = $1 AND b.org_id = $2 AND b.deleted_at IS NULL`, [b.batch_id, orgId], db);
    if (!batch) throw notFound('Batch');
    const member = await queryOne(`SELECT status FROM learner_batch_memberships WHERE learner_id = $1 AND batch_id = $2`, [learnerId, b.batch_id], db);
    const already = member?.status === 'active';
    const seatsLeft = batch.capacity == null ? null : Math.max(0, Number(batch.capacity) - Number(batch.seated));
    let discount = discountP;
    if (b.plan_id && b.discount && discount === null) {
      const plan = await queryOne(`SELECT total_amount FROM fee_plans WHERE id = $1 AND org_id = $2`, [b.plan_id, orgId], db);
      if (!plan) throw notFound('Fee plan');
      discount = Math.round(toPaise(plan.total_amount) * Math.min(100, b.discount.value) / 100);
    }
    const preview: any = { learner, batch: { id: batch.id, name: batch.name, capacity: batch.capacity, seats_left: seatsLeft, status: batch.status }, already_member: already };
    if (b.plan_id) preview.fee = await assignPlan(db, ctx, { planId: b.plan_id, learnerIds: [learnerId], batchId: b.batch_id, startDate: start, discountPaise: discount ?? 0 }, true);
    if (b.dry_run) return { dry_run: true, ...preview, would_block: !already && seatsLeft === 0 ? 'The batch is full.' : null };

    // 1. the seat (capacity is enforced under a lock on the batch)
    const seat = await enrollLearners({ db, user: req.user!, orgId, req }, b.batch_id, [learnerId]);
    // 2. the fee
    const fee = b.plan_id ? await assignPlan(db, ctx, { planId: b.plan_id, learnerIds: [learnerId], batchId: b.batch_id, startDate: start, discountPaise: discount ?? 0 }, false) : null;
    // 3. the first payment, if any (the payment form's request id makes a double click harmless)
    const payment = b.payment ? await applyPayment(db, orgId, { learnerId, amountPaise: toPaise(b.payment.amount), method: b.payment.method, provider: 'manual', paidAt: new Date(), reference: b.payment.reference ?? null, note: 'Admission', recordedBy: req.user!.id, actor: req.user!, req, requestId: b.payment.request_id ?? null }) : null;
    // 4. the CRM record: converted, with the batch it ended in
    await ensureLead(db, { orgId, learnerId, actorId: req.user!.id });
    await exec(`UPDATE crm_leads SET interested_batch_id = $1 WHERE learner_id = $2`, [b.batch_id, learnerId], db);
    const moved = await changeStatus(db, { orgId, learnerId, to: 'converted', actorId: req.user!.id });
    await logCrmActivity(db, { orgId, learnerId, type: 'admission_confirmed', description: `Admitted to ${batch.name}${fee && fee.created ? ` with fee plan (${fee.net_each})` : ''}${payment && !payment.duplicate ? `, first payment ${payment.payment.receipt_no}` : ''}`, staffId: req.user!.id });
    await audit({ orgId, actor: req.user, action: 'admission.confirmed', entityType: 'learner', entityId: learnerId, next: { batch_id: b.batch_id, plan_id: b.plan_id ?? null, paid: !!payment, newly_converted: moved }, req }, db);
    return { dry_run: false, ...preview, seat: { joined: seat.joined, rejoined: seat.rejoined, already_member: seat.already_member }, fee, payment: payment ? { id: payment.payment.id, receipt_no: payment.payment.receipt_no, duplicate: payment.duplicate } : null, converted: true };
  });
  ok(res, out, undefined, out.dry_run ? 200 : 201);
}));

export default router;
