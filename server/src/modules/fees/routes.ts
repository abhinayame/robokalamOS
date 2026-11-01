import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { csvList, ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { resolveLearnerIds, selectorSchema } from '../selection/resolver.js';
import { fromPaise, rupees, toPaise, todayIn } from './money.js';
import { getPaymentProvider, isConfigured, isWebhookConfigured } from './razorpay.js';
import { createPayLink } from './paylinks.js';
import { editPayment, setFeeDiscount, voidPayment, checkDiscountAllowed } from './adjust.js';
import { RECEIPT_TEMPLATES, drawReceipt, loadReceiptData, newReceiptDoc, receiptFileName, sampleReceipt } from './receipt.js';
import { METHODS, applyPayment, assignPlan, learnerLedger, loadPayment, orgInfo, refundPayment } from './service.js';

const router = Router();
router.use(requireOrg);
const staffRead = requirePerm('fee:read');
const manage = requirePerm('fee:manage');
const selfOrStaff = requireAnyPerm('fee:read', 'portal:learner', 'portal:parent');

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const money = z.number({ message: 'Enter an amount.' }).positive('Enter an amount greater than zero.').max(10_000_000, 'That amount is too large.')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Use at most 2 decimal places.');

/** A learner the caller may see (staff scope, or a learner's own / a parent's children). 404 otherwise. */
async function visibleLearner(req: Request, id: string) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const l = await queryOne(`SELECT l.id, l.full_name, l.learner_code, l.mobile, l.email FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!l) throw notFound('Learner');
  return l;
}

router.get('/settings', staffRead, wrap(async (req, res) => { ok(res, { receipt_email: !!(await queryOne(`SELECT receipt_email FROM organizations WHERE id = $1`, [orgIdOf(req)]))?.receipt_email }); }));
router.put('/settings', manage, wrap(async (req, res) => {
  const b = parse(z.object({ receipt_email: z.boolean() }), req.body); const orgId = orgIdOf(req);
  await exec(`UPDATE organizations SET receipt_email = $2 WHERE id = $1`, [orgId, b.receipt_email]);
  await audit({ orgId, actor: req.user, action: 'fees.settings_updated', entityType: 'organization', entityId: orgId, next: b, req });
  ok(res, b);
}));

router.get('/status', selfOrStaff, wrap(async (_req, res) => {
  // Only whether things are set. Values are never returned.
  ok(res, { online_payments: isConfigured(), webhook_configured: isWebhookConfigured(), methods: METHODS });
}));

// ------------------------------------------------------------------ plans
const planBody = z.object({
  name: z.string().trim().min(2, 'Name the plan.').max(120), description: z.string().trim().max(500).nullish(),
  items: z.array(z.object({ label: z.string().trim().min(1, 'Name each installment.').max(120), amount: money, due_days: z.number().int().min(0).max(1825).default(0) })).min(1, 'Add at least one installment.').max(60),
});
const dupName = (e: any) => { if (e?.errno === 1062) throw conflict('A plan with that name already exists.', 'DUPLICATE'); throw e; };

router.get('/plans', staffRead, wrap(async (req, res) => {
  const plans = await query(`SELECT p.id, p.name, p.description, p.total_amount, p.status, p.created_at, (SELECT COUNT(*) FROM learner_fees f WHERE f.plan_id = p.id AND f.status = 'active') AS learners FROM fee_plans p WHERE p.org_id = $1 ORDER BY p.status, p.name`, [orgIdOf(req)]);
  const items = plans.length ? await query(`SELECT plan_id, id, label, amount, due_days FROM fee_plan_items WHERE org_id = $1 ORDER BY position, id`, [orgIdOf(req)]) : [];
  ok(res, plans.map((p) => ({ ...p, learners: Number(p.learners), items: items.filter((i) => i.plan_id === p.id).map(({ plan_id, ...i }) => i) })));
}));

async function writeItems(db: any, orgId: string, planId: string, items: z.infer<typeof planBody>['items']) {
  await exec(`DELETE FROM fee_plan_items WHERE plan_id = $1 AND org_id = $2`, [planId, orgId], db);
  for (const [k, it] of items.entries()) await exec(`INSERT INTO fee_plan_items (id, org_id, plan_id, label, amount, due_days, position) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [newId(), orgId, planId, it.label, it.amount.toFixed(2), it.due_days, k], db);
  return fromPaise(items.reduce((s, i) => s + toPaise(i.amount), 0));
}

router.post('/plans', manage, wrap(async (req, res) => {
  const b = parse(planBody, req.body); const orgId = orgIdOf(req); const id = newId();
  await tx(async (db) => {
    await exec(`INSERT INTO fee_plans (id, org_id, name, description, total_amount, created_by) VALUES ($1,$2,$3,$4,1,$5)`, [id, orgId, b.name, b.description ?? null, req.user!.id], db).catch(dupName);
    const total = await writeItems(db, orgId, id, b.items);
    await exec(`UPDATE fee_plans SET total_amount = $2 WHERE id = $1`, [id, total], db);
    await audit({ orgId, actor: req.user, action: 'fee_plan.created', entityType: 'fee_plan', entityId: id, next: { name: b.name, total, installments: b.items.length }, req }, db);
  });
  ok(res, { id }, undefined, 201);
}));

router.patch('/plans/:id', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  const b = parse(planBody.partial().extend({ status: z.enum(['active', 'archived']).optional() }), req.body);
  await tx(async (db) => {
    const plan = await queryOne(`SELECT id FROM fee_plans WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, orgId], db);
    if (!plan) throw notFound('Fee plan');
    if (b.items) {
      const used = Number((await queryOne(`SELECT COUNT(*) AS n FROM learner_fees WHERE plan_id = $1`, [id], db))!.n);
      if (used) throw conflict('This plan has already been given to learners, so its installments cannot change. Archive it and create a new plan.', 'PLAN_IN_USE');
      const total = await writeItems(db, orgId, id, b.items);
      await exec(`UPDATE fee_plans SET total_amount = $2 WHERE id = $1`, [id, total], db);
    }
    if (b.name !== undefined) await exec(`UPDATE fee_plans SET name = $2 WHERE id = $1`, [id, b.name], db).catch(dupName);
    if (b.description !== undefined) await exec(`UPDATE fee_plans SET description = $2 WHERE id = $1`, [id, b.description ?? null], db);
    if (b.status) await exec(`UPDATE fee_plans SET status = $2 WHERE id = $1`, [id, b.status], db);
    await audit({ orgId, actor: req.user, action: 'fee_plan.updated', entityType: 'fee_plan', entityId: id, next: { name: b.name, status: b.status, items_changed: !!b.items }, req }, db);
  });
  ok(res, { id });
}));

// ------------------------------------------------------------------ assigning
const MAX_ASSIGN = 20_000;
router.post('/assign', limit('bulk', 30), manage, wrap(async (req, res) => {
  const b = parse(z.object({
    plan_id: uuid, selector: selectorSchema, batch_id: uuid.nullish(), start_date: date,
    discount: z.object({ type: z.enum(['amount', 'percent']), value: z.number().min(0), reason: z.string().trim().max(200).nullish(), preset_id: uuid.nullish() }).optional(), level_label: z.string().trim().max(60).nullish(), dry_run: z.boolean().default(false),
    confirm: z.boolean().optional(),
  }), req.body);
  if (!b.dry_run && b.confirm !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Review the numbers and confirm to assign this fee.');
  const orgId = orgIdOf(req);
  const plan = await queryOne(`SELECT total_amount FROM fee_plans WHERE id = $1 AND org_id = $2`, [b.plan_id, orgId]);
  if (!plan) throw notFound('Fee plan');
  const grossP = toPaise(plan.total_amount);
  const discountP = !b.discount ? 0 : b.discount.type === 'amount' ? toPaise(b.discount.value) : Math.round((grossP * Math.min(b.discount.value, 100)) / 100);
  if (discountP > 0) { if (discountP > grossP) throw badRequest('The discount cannot be more than the fee.', [{ field: 'discount', message: 'Lower the discount.' }]); await checkDiscountAllowed(undefined, orgId, req.user!, (discountP / grossP) * 100); }
  const out = await tx(async (db) => {
    const ids = await resolveLearnerIds(req.user!, orgId, b.selector, db, MAX_ASSIGN + 1);
    if (ids.length > MAX_ASSIGN) throw badRequest(`A fee can be assigned to at most ${MAX_ASSIGN.toLocaleString('en-IN')} learners at once. Narrow the selection.`);
    if (!ids.length) throw badRequest('No learners match this selection.');
    // The fee is tied to a batch only when the sender says so: assigning one plan twice by different selections cannot double-bill a learner.
    const batchId = b.batch_id ?? null;
    return assignPlan(db, { orgId, user: req.user!, req }, { planId: b.plan_id, learnerIds: ids, batchId, startDate: b.start_date, discountPaise: discountP, discountType: b.discount?.type ?? null, discountValue: b.discount?.value ?? null, discountReason: b.discount?.reason ?? null, levelLabel: b.level_label ?? null }, b.dry_run);
  });
  ok(res, out, undefined, out.dry_run ? 200 : 201);
}));

/** A one-off charge (exam fee, kit, late fee) that is not part of a plan. */
router.post('/learners/:id/fees', manage, wrap(async (req, res) => {
  const b = parse(z.object({ title: z.string().trim().min(2, 'Name the charge.').max(160), amount: money, due_date: date, batch_id: uuid.nullish(), note: z.string().trim().max(300).nullish() }), req.body);
  const l = await visibleLearner(req, parse(uuid, req.params.id)); const orgId = orgIdOf(req);
  const fid = newId();
  await tx(async (db) => {
    if (b.batch_id && !(await queryOne(`SELECT 1 FROM batches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [b.batch_id, orgId], db))) throw notFound('Batch');
    await exec(`INSERT INTO learner_fees (id, org_id, learner_id, batch_id, title, gross_amount, discount_amount, net_amount, start_date, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,0,$6,$7,$8,$9)`, [fid, orgId, l.id, b.batch_id ?? null, b.title, b.amount.toFixed(2), b.due_date, b.note ?? null, req.user!.id], db);
    await exec(`INSERT INTO fee_installments (id, org_id, learner_fee_id, learner_id, label, amount, due_date, base_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$6)`, [newId(), orgId, fid, l.id, b.title, b.amount.toFixed(2), b.due_date], db);
    await audit({ orgId, actor: req.user, action: 'fee.charge_added', entityType: 'learner_fee', entityId: fid, next: { learner_id: l.id, title: b.title, amount: b.amount }, req }, db);
  });
  ok(res, { id: fid }, undefined, 201);
}));

router.post('/fees/:id/cancel', manage, wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(2, 'Say why.').max(200) }), req.body); const orgId = orgIdOf(req); const id = parse(uuid, req.params.id);
  await tx(async (db) => {
    const f = await queryOne(`SELECT id, learner_id, status FROM learner_fees WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, orgId], db);
    if (!f) throw notFound('Fee');
    await visibleLearner(req, f.learner_id);
    if (f.status === 'cancelled') throw conflict('Already cancelled.', 'ALREADY_CANCELLED');
    const paid = Number((await queryOne(`SELECT COUNT(*) AS n FROM fee_installments WHERE learner_fee_id = $1 AND paid_amount > 0`, [id], db))!.n);
    if (paid) throw conflict('Some of this fee has been paid. Refund those payments first, or lower the unpaid installments instead.', 'HAS_PAYMENTS');
    await exec(`UPDATE learner_fees SET status = 'cancelled', cancelled_at = NOW(3), cancel_reason = $2 WHERE id = $1`, [id, b.reason], db);
    await exec(`UPDATE fee_installments SET status = 'cancelled' WHERE learner_fee_id = $1`, [id], db);
    await audit({ orgId, actor: req.user, action: 'fee.cancelled', entityType: 'learner_fee', entityId: id, next: { reason: b.reason }, req }, db);
  });
  ok(res, { id, cancelled: true });
}));

/** Change the due date or lower/raise one installment (lowering an unpaid part is how a waiver is recorded). Never below what is already paid. */
router.patch('/installments/:id', manage, wrap(async (req, res) => {
  const b = parse(z.object({ due_date: date.optional(), amount: money.optional(), reason: z.string().trim().min(2, 'Say why.').max(200) }), req.body);
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.id);
  await tx(async (db) => {
    const i = await queryOne(`SELECT i.id, i.amount, i.paid_amount, i.status, i.learner_id, i.learner_fee_id FROM fee_installments i WHERE i.id = $1 AND i.org_id = $2 FOR UPDATE`, [id, orgId], db);
    if (!i) throw notFound('Installment');
    await visibleLearner(req, i.learner_id);
    if (i.status === 'cancelled') throw conflict('This installment is cancelled.', 'CANCELLED');
    const paidP = toPaise(i.paid_amount);
    const newAmount = b.amount !== undefined ? toPaise(b.amount) : toPaise(i.amount);
    if (newAmount < paidP) throw badRequest(`${rupees(paidP)} is already paid on this installment, so it cannot go below that.`, [{ field: 'amount', message: `At least ${rupees(paidP)}.` }]);
    await exec(`UPDATE fee_installments SET amount = $2, base_amount = GREATEST(COALESCE(base_amount, 0), $2), due_date = COALESCE($3, due_date), status = $4 WHERE id = $1`, [id, fromPaise(newAmount), b.due_date ?? null, newAmount <= paidP ? 'paid' : paidP > 0 ? 'partial' : 'pending'], db);
    const tot = await queryOne(`SELECT COALESCE(SUM(amount), 0) AS s FROM fee_installments WHERE learner_fee_id = $1 AND status <> 'cancelled'`, [i.learner_fee_id], db);
    const net = toPaise(tot!.s); const f = await queryOne(`SELECT gross_amount FROM learner_fees WHERE id = $1`, [i.learner_fee_id], db);
    const gross = Math.max(toPaise(f!.gross_amount), net);
    await exec(`UPDATE learner_fees SET net_amount = $2, gross_amount = $3, discount_amount = $4 WHERE id = $1`, [i.learner_fee_id, fromPaise(net), fromPaise(gross), fromPaise(gross - net)], db);
    await audit({ orgId, actor: req.user, action: 'fee.installment_adjusted', entityType: 'fee_installment', entityId: id, previous: { amount: i.amount }, next: { amount: fromPaise(newAmount), due_date: b.due_date, reason: b.reason }, req }, db);
  });
  ok(res, { id });
}));

// ------------------------------------------------------------------ ledger (staff, learner, parent)
router.get('/learners/:id', selfOrStaff, wrap(async (req, res) => {
  const l = await visibleLearner(req, parse(uuid, req.params.id));
  ok(res, await learnerLedger(orgIdOf(req), l.id, (await orgInfo(orgIdOf(req))).tz));
}));

/** A learner's or parent's own fees, one ledger per child. */
router.get('/me', requireAnyPerm('portal:learner', 'portal:parent'), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const tz = (await orgInfo(orgId)).tz;
  ok(res, await Promise.all(req.user!.access.ownLearnerIds.map((id) => learnerLedger(orgId, id, tz))));
}));

// ------------------------------------------------------------------ dues
const dueQuery = paging.extend({
  status: z.enum(['overdue', 'upcoming', 'all']).default('overdue'), batch_id: csvList(uuid), search: z.string().trim().max(100).optional(),
  from: date.optional(), to: date.optional(), min_days_overdue: z.coerce.number().int().min(0).max(3650).optional(),
  sort: z.enum(['due_date', 'amount', 'name']).default('due_date'),
});
export function duesWhere(req: Request, f: Partial<z.infer<typeof dueQuery>>, p: Params, tz: string) {
  const sc = learnerScope(req.user!, p, 'l');
  const today = p.add(todayIn(tz));
  const w = [`i.org_id = ${p.add(orgIdOf(req))}`, `f.status = 'active'`, `i.status IN ('pending','partial')`, 'l.deleted_at IS NULL'];
  if (sc) w.push(sc);
  if (f.status === 'overdue' || f.min_days_overdue !== undefined) w.push(`i.due_date < ${today}`);
  if (f.status === 'upcoming') w.push(`i.due_date >= ${today}`);
  if (f.min_days_overdue) w.push(`DATEDIFF(${today}, i.due_date) >= ${p.add(f.min_days_overdue)}`);
  if (f.batch_id?.length) w.push(`f.batch_id IN ${p.in(f.batch_id)}`);
  if (f.from) w.push(`i.due_date >= ${p.add(f.from)}`); if (f.to) w.push(`i.due_date <= ${p.add(f.to)}`);
  if (f.search) { const s = `%${f.search.replace(/[%_\\]/g, '\\$&')}%`; w.push(`(l.full_name LIKE ${p.add(s)} OR l.learner_code LIKE ${p.add(s)})`); }
  return { where: w.join(' AND '), today };
}

router.get('/dues', staffRead, wrap(async (req, res) => {
  const q = parse(dueQuery, req.query); const tz = (await orgInfo(orgIdOf(req))).tz;
  const p = new Params(); const { where, today } = duesWhere(req, q, p, tz);
  const base = `FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id JOIN learners l ON l.id = i.learner_id LEFT JOIN batches b ON b.id = f.batch_id WHERE ${where}`;
  const agg = await queryOne(`SELECT COUNT(*) AS n, COALESCE(SUM(i.amount - i.paid_amount), 0) AS balance, COUNT(DISTINCT i.learner_id) AS learners ${base}`, p.values);
  const order = q.sort === 'amount' ? '(i.amount - i.paid_amount) DESC' : q.sort === 'name' ? 'l.full_name ASC' : `i.due_date ${q.order === 'desc' ? 'DESC' : 'ASC'}`;
  const rows = await query(`SELECT i.id, i.label, i.amount, i.paid_amount, (i.amount - i.paid_amount) AS balance, i.due_date, i.status, DATEDIFF(${today}, i.due_date) AS days_overdue,
      l.id AS learner_id, l.learner_code, l.full_name, b.name AS batch_name, f.title AS fee_title,
      (SELECT pa.mobile FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL WHERE lp.learner_id = l.id ORDER BY lp.is_primary DESC, pa.id LIMIT 1) AS parent_mobile
    ${base} ORDER BY ${order}, i.id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows.map((r) => ({ ...r, days_overdue: Number(r.days_overdue) })), { page: q.page, page_size: q.page_size, total: Number(agg!.n), total_pages: Math.ceil(Number(agg!.n) / q.page_size), balance: fromPaise(toPaise(agg!.balance)), learners: Number(agg!.learners) });
}));

router.get('/summary', staffRead, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const tz = (await orgInfo(orgId)).tz; const today = todayIn(tz);
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const a = await queryOne(`SELECT COALESCE(SUM(i.amount), 0) AS billed, COALESCE(SUM(i.paid_amount), 0) AS paid,
      COALESCE(SUM(IF(i.status IN ('pending','partial') AND i.due_date < ${p.add(today)}, i.amount - i.paid_amount, 0)), 0) AS overdue,
      COALESCE(SUM(IF(i.status IN ('pending','partial') AND i.due_date < ${p.add(today)}, 1, 0)), 0) AS overdue_count,
      COUNT(DISTINCT IF(i.status IN ('pending','partial') AND i.due_date < ${p.add(today)}, i.learner_id, NULL)) AS overdue_learners
    FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id AND f.status = 'active' JOIN learners l ON l.id = i.learner_id AND l.deleted_at IS NULL
    WHERE i.org_id = ${p.add(orgId)} AND i.status <> 'cancelled' ${sc ? `AND ${sc}` : ''}`, p.values);
  const mp = new Params(); const msc = learnerScope(req.user!, mp, 'l');
  const month = await queryOne(`SELECT COALESCE(SUM(p.amount - p.refunded_amount), 0) AS collected, COUNT(*) AS payments FROM payments p JOIN learners l ON l.id = p.learner_id
      WHERE p.org_id = ${mp.add(orgId)} AND p.paid_at >= ${mp.add(`${today.slice(0, 7)}-01 00:00:00`)} ${msc ? `AND ${msc}` : ''}`, mp.values);
  const billed = toPaise(a!.billed); const paid = toPaise(a!.paid);
  ok(res, { billed: fromPaise(billed), collected: fromPaise(paid), outstanding: fromPaise(billed - paid), overdue: fromPaise(toPaise(a!.overdue)), overdue_installments: Number(a!.overdue_count), overdue_learners: Number(a!.overdue_learners),
    collected_this_month: fromPaise(toPaise(month!.collected)), payments_this_month: Number(month!.payments), collection_rate_pct: billed ? Math.round((paid / billed) * 1000) / 10 : null });
}));

// ------------------------------------------------------------------ payments
router.post('/payments', limit('bulk', 30), requirePerm('payment:record'), wrap(async (req, res) => {
  const b = parse(z.object({
    learner_id: uuid, amount: money, method: z.enum(METHODS).default('cash'), paid_at: z.string().datetime({ offset: true }).optional(), reference: z.string().trim().max(100).nullish(),
    note: z.string().trim().max(300).nullish(), installment_ids: z.array(uuid).max(60).optional(), request_id: uuid.optional(),
  }), req.body);
  if (b.method === 'online') throw badRequest('Online payments are recorded automatically when the learner pays. Choose how the money was received.', [{ field: 'method', message: 'Choose cash, UPI, card, bank transfer, cheque or other.' }]);
  const l = await visibleLearner(req, b.learner_id); const orgId = orgIdOf(req);
  const paidAt = b.paid_at ? new Date(b.paid_at) : new Date();
  if (paidAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('The payment date cannot be in the future.', [{ field: 'paid_at', message: 'Pick today or an earlier date.' }]);
  const out = await tx((db) => applyPayment(db, orgId, { learnerId: l.id, amountPaise: toPaise(b.amount), method: b.method, provider: 'manual', paidAt, reference: b.reference, note: b.note, requestId: b.request_id, installmentIds: b.installment_ids, recordedBy: req.user!.id, actor: req.user, req }));
  ok(res, out, undefined, out.duplicate ? 200 : 201);
}));

router.get('/payments', staffRead, wrap(async (req, res) => {
  const q = parse(paging.extend({ learner_id: uuid.optional(), method: z.enum(METHODS).optional(), provider: z.enum(['manual', 'razorpay']).optional(), from: date.optional(), to: date.optional(), search: z.string().trim().max(100).optional() }), req.query);
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const w = [`p.org_id = ${p.add(orgIdOf(req))}`, 'l.deleted_at IS NULL']; if (sc) w.push(sc);
  if (q.learner_id) w.push(`p.learner_id = ${p.add(q.learner_id)}`); if (q.method) w.push(`p.method = ${p.add(q.method)}`); if (q.provider) w.push(`p.provider = ${p.add(q.provider)}`);
  if (q.from) w.push(`p.paid_at >= ${p.add(`${q.from} 00:00:00`)}`); if (q.to) w.push(`p.paid_at < ${p.add(`${q.to} 23:59:59.999`)}`);
  if (q.search) { const s = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`; w.push(`(l.full_name LIKE ${p.add(s)} OR l.learner_code LIKE ${p.add(s)} OR p.receipt_no LIKE ${p.add(s)} OR p.reference LIKE ${p.add(s)})`); }
  const base = `FROM payments p JOIN learners l ON l.id = p.learner_id WHERE ${w.join(' AND ')}`;
  const agg = await queryOne(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount - p.refunded_amount), 0) AS net ${base}`, p.values);
  const rows = await query(`SELECT p.id, p.receipt_no, p.amount, p.refunded_amount, p.method, p.provider, p.status, p.paid_at, p.reference, l.id AS learner_id, l.full_name, l.learner_code ${base} ORDER BY p.paid_at DESC, p.id DESC LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows, { page: q.page, page_size: q.page_size, total: Number(agg!.n), total_pages: Math.ceil(Number(agg!.n) / q.page_size), net_collected: fromPaise(toPaise(agg!.net)) });
}));

async function visiblePayment(req: Request, id: string) {
  const d = await loadPayment(orgIdOf(req), id);
  await visibleLearner(req, d.payment.learner_id);
  return d;
}
router.get('/payments/:id', selfOrStaff, wrap(async (req, res) => ok(res, await visiblePayment(req, parse(uuid, req.params.id)))));

router.post('/payments/:id/refund', requirePerm('payment:refund'), wrap(async (req, res) => {
  const b = parse(z.object({ amount: money, reason: z.string().trim().min(2, 'Say why.').max(200) }), req.body);
  const id = parse(uuid, req.params.id); await visiblePayment(req, id);
  ok(res, await tx((db) => refundPayment(db, orgIdOf(req), id, toPaise(b.amount), b.reason, req.user!, req)), undefined, 201);
}));

/** Printable receipt in the school's chosen design. Learners and parents can download their own; staff can try another design with ?template=. */
router.get('/payments/:id/receipt.pdf', selfOrStaff, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); await visiblePayment(req, id);
  const q = parse(z.object({ template: z.enum(RECEIPT_TEMPLATES).optional() }), req.query);
  const d = await loadReceiptData(orgIdOf(req), id);
  if (q.template && req.user!.permissions.has('fee:read')) d.org.template = q.template;
  const doc = newReceiptDoc(d, `Receipt ${d.pay.receiptNo}`);
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${receiptFileName(d.pay.receiptNo)}"`); res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res); drawReceipt(doc, d); doc.end();
}));

// ------------------------------------------------------------------ receipt design (settings)
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #12263f.');
const settingsBody = z.object({
  template: z.enum(RECEIPT_TEMPLATES), address: z.string().trim().max(300).nullish().transform((v) => v || null), tax_id: z.string().trim().max(40).nullish().transform((v) => v || null),
  header: z.string().trim().max(160).nullish().transform((v) => v || null), footer: z.string().trim().max(500).nullish().transform((v) => v || null),
  signatory: z.string().trim().max(80).nullish().transform((v) => v || null), signatory_title: z.string().trim().max(80).nullish().transform((v) => v || null),
  accent: hex.nullish().transform((v) => v || null), show_logo: z.boolean().default(true),
});
const readSettings = async (orgId: string) => {
  const o = await queryOne(`SELECT receipt_template, receipt_address, receipt_tax_id, receipt_header, receipt_footer, receipt_signatory, receipt_signatory_title, receipt_accent, receipt_show_logo, receipt_email, discount_limit_percent, brand_color FROM organizations WHERE id = $1`, [orgId]);
  return { template: o!.receipt_template, address: o!.receipt_address, tax_id: o!.receipt_tax_id, header: o!.receipt_header, footer: o!.receipt_footer, signatory: o!.receipt_signatory, signatory_title: o!.receipt_signatory_title, accent: o!.receipt_accent, show_logo: !!o!.receipt_show_logo, brand_color: o!.brand_color ?? '#12263f', receipt_email: !!o!.receipt_email, discount_limit_percent: o!.discount_limit_percent == null ? null : Number(o!.discount_limit_percent) };
};
router.get('/receipt-settings', staffRead, wrap(async (req, res) => ok(res, { ...(await readSettings(orgIdOf(req))), templates: RECEIPT_TEMPLATES })));
router.put('/receipt-settings', manage, wrap(async (req, res) => {
  const b = parse(settingsBody, req.body); const orgId = orgIdOf(req);
  await exec(`UPDATE organizations SET receipt_template = $2, receipt_address = $3, receipt_tax_id = $4, receipt_header = $5, receipt_footer = $6, receipt_signatory = $7, receipt_signatory_title = $8, receipt_accent = $9, receipt_show_logo = $10 WHERE id = $1`,
    [orgId, b.template, b.address, b.tax_id, b.header, b.footer, b.signatory, b.signatory_title, b.accent, b.show_logo]);
  await audit({ orgId, actor: req.user, action: 'fees.receipt_design_updated', entityType: 'organization', entityId: orgId, next: { template: b.template }, req });
  ok(res, await readSettings(orgId));
}));
/** A sample receipt in a design (saved or being tried) so a school can see it before any real payment. */
router.get('/receipt-preview.pdf', staffRead, wrap(async (req, res) => {
  const q = parse(z.object({ template: z.enum(RECEIPT_TEMPLATES).optional(), accent: hex.optional(), revised: z.coerce.boolean().optional(), void: z.coerce.boolean().optional() }), req.query); const orgId = orgIdOf(req);
  const base = await loadReceiptData(orgId, (await queryOne(`SELECT id FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`, [orgId]))?.id ?? '00000000-0000-4000-8000-000000000000').catch(async () => null);
  const org = base?.org ?? (await loadSettingsOnlyOrg(orgId)); org.template = q.template ?? org.template; if (q.accent) org.accent = q.accent;
  const d = sampleReceipt({ org }); if (q.revised) d.pay.revision = 2; if (q.void) { d.pay.status = 'voided'; d.pay.voidReason = 'Recorded twice by mistake'; }
  const doc = newReceiptDoc(d, 'Receipt preview'); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'inline; filename="receipt-preview.pdf"'); res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res); drawReceipt(doc, d); doc.end();
}));
async function loadSettingsOnlyOrg(orgId: string) {
  const s = await readSettings(orgId); const o = await queryOne(`SELECT name, brand_app_name FROM organizations WHERE id = $1`, [orgId]);
  return { name: o?.brand_app_name || o?.name || 'School', address: s.address, taxId: s.tax_id, header: s.header, footer: s.footer, signatory: s.signatory, signatoryTitle: s.signatory_title, accent: s.accent ?? s.brand_color, logo: null as Buffer | null, template: s.template as any };
}
/** The most the accounts team may discount without an owner (empty = no limit). Owners only. */
router.put('/discount-limit', requirePerm('fee:discount_unlimited'), wrap(async (req, res) => {
  const b = parse(z.object({ percent: z.number().int().min(0).max(100).nullable() }), req.body); const orgId = orgIdOf(req);
  await exec(`UPDATE organizations SET discount_limit_percent = $2 WHERE id = $1`, [orgId, b.percent]);
  await audit({ orgId, actor: req.user, action: 'fees.discount_limit_set', entityType: 'organization', entityId: orgId, next: b, req }); ok(res, b);
}));

// ------------------------------------------------------------------ discounts
router.get('/discount-presets', requireAnyPerm('fee:read', 'fee:discount'), wrap(async (req, res) => ok(res, await query(`SELECT id, name, kind, value, active FROM fee_discount_presets WHERE org_id = $1 ORDER BY active DESC, name`, [orgIdOf(req)]))));
const presetBody = z.object({ name: z.string().trim().min(2, 'Name the discount.').max(80), kind: z.enum(['percent', 'amount']), value: z.number().positive('Enter a value above 0.').max(10_000_000), active: z.boolean().default(true) })
  .refine((x) => x.kind === 'amount' || x.value <= 100, { message: 'A percentage cannot be above 100.', path: ['value'] });
router.post('/discount-presets', manage, wrap(async (req, res) => {
  const b = parse(presetBody, req.body); const id = newId();
  try { await exec(`INSERT INTO fee_discount_presets (id, org_id, name, kind, value, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, orgIdOf(req), b.name, b.kind, b.value, b.active, req.user!.id]); } catch (e) { dupName(e); }
  ok(res, { id }, undefined, 201);
}));
router.put('/discount-presets/:id', manage, wrap(async (req, res) => {
  const b = parse(presetBody, req.body);
  try { const r = await exec(`UPDATE fee_discount_presets SET name = $3, kind = $4, value = $5, active = $6 WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req), b.name, b.kind, b.value, b.active]); if (!r.affectedRows) throw notFound('Discount'); } catch (e) { dupName(e); }
  ok(res, { updated: true });
}));
router.delete('/discount-presets/:id', manage, wrap(async (req, res) => { const r = await exec(`DELETE FROM fee_discount_presets WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req)]); if (!r.affectedRows) throw notFound('Discount'); ok(res, { deleted: true }); }));

/** Give, change or remove the discount on one learner's fee (percent or rupees). The unpaid instalments are re-split; what was paid stays. */
router.post('/fees/:id/discount', requirePerm('fee:discount'), wrap(async (req, res) => {
  const b = parse(z.object({ type: z.enum(['percent', 'amount', 'none']), value: z.number().min(0).max(10_000_000).default(0), reason: z.string().trim().min(2, 'Say why.').max(200), preset_id: uuid.nullish() }), req.body);
  if (b.type === 'percent' && b.value > 100) throw badRequest('A percentage cannot be above 100.', [{ field: 'value', message: 'At most 100.' }]);
  const orgId = orgIdOf(req); const id = parse(uuid, req.params.id);
  const out = await tx(async (db) => { const f = await queryOne(`SELECT learner_id FROM learner_fees WHERE id = $1 AND org_id = $2`, [id, orgId], db); if (!f) throw notFound('Fee'); await visibleLearner(req, f.learner_id);
    if (b.preset_id && !(await queryOne(`SELECT 1 FROM fee_discount_presets WHERE id = $1 AND org_id = $2`, [b.preset_id, orgId], db))) throw notFound('Discount');
    return setFeeDiscount(db, { orgId, user: req.user!, req }, { feeId: id, type: b.type, value: b.value, reason: b.reason, presetId: b.preset_id }); });
  ok(res, out);
}));
router.get('/fees/:id/history', selfOrStaff, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const f = await queryOne(`SELECT learner_id FROM learner_fees WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgId]); if (!f) throw notFound('Fee'); await visibleLearner(req, f.learner_id);
  ok(res, await query(`SELECT a.created_at, a.before_discount, a.after_discount, a.before_net, a.after_net, a.discount_type, a.discount_value, a.reason, u.full_name AS by_name FROM fee_adjustments a LEFT JOIN users u ON u.id = a.adjusted_by WHERE a.learner_fee_id = $1 ORDER BY a.created_at DESC, a.id DESC`, [req.params.id]));
}));

// ------------------------------------------------------------------ correcting payments
/** Fix a payment recorded wrongly (wrong date, method, reference, even amount). The old values are kept in its history and the receipt shows it was corrected. */
router.patch('/payments/:id', requirePerm('payment:edit'), wrap(async (req, res) => {
  const b = parse(z.object({ paid_at: z.string().datetime({ offset: true }).optional(), method: z.enum(METHODS).optional(), reference: z.string().trim().max(100).nullish(), note: z.string().trim().max(300).nullish(), amount: money.optional(),
    reason: z.string().trim().min(2, 'Say what was wrong.').max(200), send_receipt: z.boolean().default(false) }), req.body);
  if (b.method === 'online') throw badRequest('Choose how the money was received.', [{ field: 'method', message: 'Choose cash, UPI, card, bank transfer, cheque or other.' }]);
  const id = parse(uuid, req.params.id); await visiblePayment(req, id);
  const paidAt = b.paid_at ? new Date(b.paid_at) : undefined; if (paidAt && paidAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('The payment date cannot be in the future.', [{ field: 'paid_at', message: 'Pick today or an earlier date.' }]);
  const out = await tx((db) => editPayment(db, { orgId: orgIdOf(req), user: req.user!, req }, id, { paidAt, method: b.method, reference: b.reference, note: b.note, amountPaise: b.amount === undefined ? undefined : toPaise(b.amount) }, b.reason, b.send_receipt));
  ok(res, { ...out, ...(await visiblePayment(req, id)) });
}));
router.post('/payments/:id/void', requirePerm('payment:edit'), wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(2, 'Say why.').max(200) }), req.body); const id = parse(uuid, req.params.id); await visiblePayment(req, id);
  ok(res, await tx((db) => voidPayment(db, { orgId: orgIdOf(req), user: req.user!, req }, id, b.reason)));
}));

// ------------------------------------------------------------------ online payment links
router.post('/pay-links', limit('paylink', 20), requireAnyPerm('payment:record', 'portal:learner', 'portal:parent'), wrap(async (req, res) => {
  const b = parse(z.object({ learner_id: uuid, installment_ids: z.array(uuid).max(60).optional() }), req.body);
  await visibleLearner(req, b.learner_id);          // staff in scope, or the learner / parent themselves
  const out = await createPayLink({ orgId: orgIdOf(req), userId: req.user!.id, actor: req.user, req }, b.learner_id, b.installment_ids);
  ok(res, out, undefined, out.reused ? 200 : 201);
}));

export default router;
