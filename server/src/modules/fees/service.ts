import { queueReceiptEmail } from './receipt-mail.js';
import type { Request } from 'express';
import { Params, exec, newId, query, queryOne, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextCounter } from '../../lib/codes.js';
import { notifyAbout } from '../../lib/notify.js';
import { recordActivity } from '../../lib/timeline.js';
import type { AuthUser } from '../../middleware/auth.js';
import { addDays, discountedParts, fromPaise, rupees, toPaise, todayIn } from './money.js';

export const METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'online', 'other'] as const;
const chunk = <T,>(a: T[], n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export async function orgInfo(orgId: string, db?: Db) {
  const o = await queryOne(`SELECT name, code_prefix, timezone FROM organizations WHERE id = $1`, [orgId], db);
  if (!o) throw notFound('Organization');
  return { name: o.name as string, prefix: o.code_prefix as string, tz: (o.timezone as string) || 'Asia/Kolkata' };
}

const statusFor = (amountP: number, paidP: number) => (paidP >= amountP ? 'paid' : paidP > 0 ? 'partial' : 'pending');

// ---------------------------------------------------------------------------------------------- payments
export interface PaymentInput {
  learnerId: string; amountPaise: number; method: (typeof METHODS)[number]; provider: 'manual' | 'razorpay'; providerPaymentId?: string | null; linkId?: string | null;
  paidAt: Date; reference?: string | null; note?: string | null; requestId?: string | null; installmentIds?: string[]; allowCredit?: boolean;
  recordedBy: string | null; actor?: AuthUser | null; req?: Request;
}

/**
 * Record one payment and spread it over the learner's open installments, oldest due date first (or exactly the installments named).
 * Runs inside the caller's transaction and locks the learner row, so two payments for one learner are applied one after the other
 * and a retried request (same request_id / provider payment id) returns the payment it already made instead of a second one.
 */
export async function applyPayment(db: Db, orgId: string, p: PaymentInput) {
  if (!(p.amountPaise > 0)) throw badRequest('Enter an amount greater than zero.', [{ field: 'amount', message: 'Must be more than 0.' }]);
  const learner = await queryOne(`SELECT id, full_name, learner_code FROM learners WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [p.learnerId, orgId], db);
  if (!learner) throw notFound('Learner');

  const existing = p.requestId ? await queryOne(`SELECT id FROM payments WHERE org_id = $1 AND request_id = $2`, [orgId, p.requestId], db)
    : p.providerPaymentId ? await queryOne(`SELECT id FROM payments WHERE provider = $1 AND provider_payment_id = $2`, [p.provider, p.providerPaymentId], db) : null;
  if (existing) return { ...(await loadPayment(orgId, existing.id, db)), duplicate: true };

  const ip = new Params();
  const only = p.installmentIds?.length ? `AND i.id IN ${ip.in([...new Set(p.installmentIds)])}` : '';
  const open = await query(
    `SELECT i.id, i.amount, i.paid_amount, i.label FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id AND f.status = 'active'
      WHERE i.learner_id = ${ip.add(p.learnerId)} AND i.org_id = ${ip.add(orgId)} AND i.status IN ('pending','partial') ${only}
      ORDER BY i.due_date, i.created_at, i.id FOR UPDATE`, ip.values, db);
  if (p.installmentIds?.length && open.length !== new Set(p.installmentIds).size) throw badRequest('One of the chosen installments is already paid, cancelled or not this learner\'s.', [{ field: 'installment_ids', message: 'Choose open installments of this learner.' }]);

  let left = p.amountPaise; const allocs: { id: string; add: number; newPaid: number; amount: number }[] = [];
  for (const i of open) {
    if (left <= 0) break;
    const amountP = toPaise(i.amount); const paidP = toPaise(i.paid_amount); const give = Math.min(left, amountP - paidP);
    if (give > 0) { allocs.push({ id: i.id, add: give, newPaid: paidP + give, amount: amountP }); left -= give; }
  }
  if (left > 0 && !p.allowCredit) {
    throw badRequest(`That is ${rupees(left)} more than the learner owes${p.installmentIds?.length ? ' on the chosen installments' : ''}. Lower the amount.`, [{ field: 'amount', message: `At most ${rupees(p.amountPaise - left)}.` }]);
  }

  const id = newId();
  const org = await orgInfo(orgId, db);
  const receipt = `${org.prefix}-RCT-${String(await nextCounter(db, orgId, 'receipt')).padStart(6, '0')}`;
  await exec(
    `INSERT INTO payments (id, org_id, learner_id, amount, unallocated_amount, method, provider, provider_payment_id, payment_link_id, receipt_no, paid_at, reference, note, recorded_by, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, orgId, p.learnerId, fromPaise(p.amountPaise), fromPaise(Math.max(left, 0)), p.method, p.provider, p.providerPaymentId ?? null, p.linkId ?? null, receipt, p.paidAt, p.reference ?? null, p.note ?? null, p.recordedBy, p.requestId ?? null], db);
  for (const a of allocs) {
    await exec(`INSERT INTO payment_allocations (org_id, payment_id, installment_id, amount) VALUES ($1,$2,$3,$4)`, [orgId, id, a.id, fromPaise(a.add)], db);
    await exec(`UPDATE fee_installments SET paid_amount = $2, status = $3 WHERE id = $1`, [a.id, fromPaise(a.newPaid), statusFor(a.amount, a.newPaid)], db);
  }
  await recordActivity(db, { orgId, learnerId: p.learnerId, type: 'fee.payment_received', title: `Payment received: ${rupees(p.amountPaise)}`, description: `Receipt ${receipt} (${p.method})`, meta: { payment_id: id, amount: fromPaise(p.amountPaise) }, actorUserId: p.recordedBy });
  await notifyAbout(db, { orgId, learnerIds: [p.learnerId], kind: 'fee', title: `Payment of ${rupees(p.amountPaise)} received`, body: `Receipt ${receipt}. Thank you.`, link: '/my-fees' });
  await audit({ orgId, actor: p.actor ?? null, action: 'payment.recorded', entityType: 'payment', entityId: id, next: { receipt_no: receipt, learner_id: p.learnerId, amount: fromPaise(p.amountPaise), method: p.method, provider: p.provider, allocated: allocs.length, credit: fromPaise(Math.max(left, 0)) }, req: p.req }, db);
  await queueReceiptEmail(db, orgId, id);
  return { ...(await loadPayment(orgId, id, db)), duplicate: false };
}

export async function loadPayment(orgId: string, id: string, db?: Db) {
  const pay = await queryOne(
    `SELECT p.id, p.learner_id, p.amount, p.unallocated_amount, p.method, p.provider, p.receipt_no, p.status, p.refunded_amount, p.paid_at, p.reference, p.note, p.created_at,
            l.full_name AS learner_name, l.learner_code, u.full_name AS recorded_by_name
       FROM payments p JOIN learners l ON l.id = p.learner_id LEFT JOIN users u ON u.id = p.recorded_by WHERE p.id = $1 AND p.org_id = $2`, [id, orgId], db);
  if (!pay) throw notFound('Payment');
  const allocations = await query(
    `SELECT a.installment_id, a.amount, i.label, i.due_date, f.title AS fee_title FROM payment_allocations a JOIN fee_installments i ON i.id = a.installment_id JOIN learner_fees f ON f.id = i.learner_fee_id
      WHERE a.payment_id = $1 ORDER BY i.due_date, i.id`, [id], db);
  const refunds = await query(`SELECT r.id, r.amount, r.reason, r.created_at, u.full_name AS refunded_by_name FROM fee_refunds r LEFT JOIN users u ON u.id = r.refunded_by WHERE r.payment_id = $1 ORDER BY r.created_at`, [id], db);
  return { payment: pay, allocations, refunds };
}

/** Refund part or all of a payment: money taken back from the latest-due installments first, so older dues stay covered. */
export async function refundPayment(db: Db, orgId: string, paymentId: string, amountPaise: number, reason: string, actor: AuthUser, req?: Request) {
  const pay = await queryOne(`SELECT id, learner_id, amount, refunded_amount, unallocated_amount, provider, receipt_no FROM payments WHERE id = $1 AND org_id = $2 FOR UPDATE`, [paymentId, orgId], db);
  if (!pay) throw notFound('Payment');
  const refundable = toPaise(pay.amount) - toPaise(pay.refunded_amount);
  if (amountPaise <= 0 || amountPaise > refundable) throw badRequest(`You can refund at most ${rupees(refundable)} of this payment.`, [{ field: 'amount', message: `At most ${rupees(refundable)}.` }]);
  await queryOne(`SELECT id FROM learners WHERE id = $1 AND org_id = $2 FOR UPDATE`, [pay.learner_id, orgId], db);

  let left = amountPaise;
  const credit = toPaise(pay.unallocated_amount); const fromCredit = Math.min(credit, left); left -= fromCredit;
  if (left > 0) {
    const allocs = await query(
      `SELECT a.id, a.installment_id, a.amount AS a_amount, i.amount, i.paid_amount FROM payment_allocations a JOIN fee_installments i ON i.id = a.installment_id
        WHERE a.payment_id = $1 AND a.amount > 0 ORDER BY i.due_date DESC, i.id DESC FOR UPDATE`, [paymentId], db);
    for (const a of allocs) {
      if (left <= 0) break;
      const take = Math.min(left, toPaise(a.a_amount)); left -= take;
      const newPaid = toPaise(a.paid_amount) - take;
      await exec(`UPDATE payment_allocations SET amount = $2 WHERE id = $1`, [a.id, fromPaise(toPaise(a.a_amount) - take)], db);
      await exec(`UPDATE fee_installments SET paid_amount = $2, status = $3 WHERE id = $1`, [a.installment_id, fromPaise(newPaid), statusFor(toPaise(a.amount), newPaid)], db);
    }
  }
  const total = toPaise(pay.refunded_amount) + amountPaise;
  await exec(`UPDATE payments SET refunded_amount = $2, unallocated_amount = $3, status = $4 WHERE id = $1`,
    [paymentId, fromPaise(total), fromPaise(credit - fromCredit), total >= toPaise(pay.amount) ? 'refunded' : 'partially_refunded'], db);
  const rid = newId();
  await exec(`INSERT INTO fee_refunds (id, org_id, payment_id, amount, reason, refunded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [rid, orgId, paymentId, fromPaise(amountPaise), reason, actor.id], db);
  await recordActivity(db, { orgId, learnerId: pay.learner_id, type: 'fee.refund', title: `Refund recorded: ${rupees(amountPaise)}`, description: `${reason} (receipt ${pay.receipt_no})`, actorUserId: actor.id });
  await audit({ orgId, actor, action: 'payment.refunded', entityType: 'payment', entityId: paymentId, next: { refund_id: rid, amount: fromPaise(amountPaise), reason }, req }, db);
  return { refund_id: rid, refunded_amount: fromPaise(total), provider_note: pay.provider === 'razorpay' ? 'This records the refund here. Issue the actual refund from the Razorpay dashboard.' : null };
}

// ---------------------------------------------------------------------------------------------- assigning fees
export interface AssignInput { planId: string; learnerIds: string[]; batchId: string | null; startDate: string; discountPaise: number }

/** Give a plan to many learners at once (one fee per learner per plan per batch; already-assigned learners are skipped). */
export async function assignPlan(db: Db, c: { orgId: string; user: AuthUser; req?: Request }, a: AssignInput, dryRun: boolean) {
  const plan = await queryOne(`SELECT id, name, total_amount, status FROM fee_plans WHERE id = $1 AND org_id = $2`, [a.planId, c.orgId], db);
  if (!plan) throw notFound('Fee plan');
  if (plan.status !== 'active') throw conflict('That fee plan is archived.', 'PLAN_ARCHIVED');
  const items = await query(`SELECT id, label, amount, due_days FROM fee_plan_items WHERE plan_id = $1 ORDER BY position, id`, [a.planId], db);
  if (!items.length) throw badRequest('This fee plan has no installments.');
  if (a.batchId && !(await queryOne(`SELECT 1 FROM batches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [a.batchId, c.orgId], db))) throw notFound('Batch');

  const gross = items.reduce((s, i) => s + toPaise(i.amount), 0);
  let parts: number[];
  try { parts = discountedParts(items.map((i) => toPaise(i.amount)), a.discountPaise); } catch { throw badRequest('The discount must be smaller than the fee.', [{ field: 'discount', message: 'Lower the discount.' }]); }
  if (parts.some((x) => x <= 0)) throw badRequest('That discount would leave an installment with nothing to pay. Lower it.', [{ field: 'discount', message: 'Lower the discount.' }]);

  const ids = [...new Set(a.learnerIds)];
  const eligible: string[] = [];
  for (const part of chunk(ids, 1000)) {
    const p = new Params();
    eligible.push(...(await query(`SELECT id FROM learners WHERE id IN ${p.in(part)} AND org_id = ${p.add(c.orgId)} AND deleted_at IS NULL AND status <> 'archived'`, p.values, db)).map((r) => r.id as string));
  }
  const have = new Set<string>();
  for (const part of chunk(eligible, 1000)) {
    const p = new Params();
    for (const r of await query(`SELECT learner_id FROM learner_fees WHERE plan_id = ${p.add(a.planId)} AND status = 'active' AND batch_id <=> ${p.add(a.batchId)} AND learner_id IN ${p.in(part)}`, p.values, db)) have.add(r.learner_id as string);
  }
  const todo = eligible.filter((id) => !have.has(id));
  const net = parts.reduce((s, x) => s + x, 0);
  const out = { requested: ids.length, eligible: eligible.length, already_assigned: have.size, skipped: ids.length - eligible.length, to_create: todo.length, gross_each: fromPaise(gross), net_each: fromPaise(net), total_billed: fromPaise(net * todo.length), installments_each: items.length, dry_run: dryRun, created: 0 };
  if (dryRun || !todo.length) return out;

  for (const part of chunk(todo, 200)) {
    const fp = new Params(); const ip = new Params();
    const feeRows: string[] = []; const instRows: string[] = [];
    for (const lid of part) {
      const fid = newId();
      feeRows.push(`(${fp.add(fid)},${fp.add(c.orgId)},${fp.add(lid)},${fp.add(a.batchId)},${fp.add(a.planId)},${fp.add(plan.name)},${fp.add(fromPaise(gross))},${fp.add(fromPaise(a.discountPaise))},${fp.add(fromPaise(net))},${fp.add(a.startDate)},${fp.add(c.user.id)})`);
      items.forEach((it, k) => instRows.push(`(${ip.add(newId())},${ip.add(c.orgId)},${ip.add(fid)},${ip.add(lid)},${ip.add(it.label)},${ip.add(fromPaise(parts[k]!))},${ip.add(addDays(a.startDate, Number(it.due_days)))})`));
    }
    await exec(`INSERT INTO learner_fees (id, org_id, learner_id, batch_id, plan_id, title, gross_amount, discount_amount, net_amount, start_date, created_by) VALUES ${feeRows.join(',')}`, fp.values, db);
    await exec(`INSERT INTO fee_installments (id, org_id, learner_fee_id, learner_id, label, amount, due_date) VALUES ${instRows.join(',')}`, ip.values, db);
    const tp = new Params();
    await exec(`INSERT INTO learner_activity (org_id, learner_id, batch_id, type, title, description, meta, actor_user_id)
      SELECT ${tp.add(c.orgId)}, l.id, ${tp.add(a.batchId)}, 'fee.assigned', ${tp.add(`Fee assigned: ${plan.name}`)}, ${tp.add(`${rupees(net)} in ${items.length} installment(s)`)}, ${tp.add(JSON.stringify({ plan_id: a.planId }))}, ${tp.add(c.user.id)}
      FROM learners l WHERE l.id IN ${tp.in(part)}`, tp.values, db);
    out.created += part.length;
  }
  await audit({ orgId: c.orgId, actor: c.user, action: 'fee.assigned', entityType: 'fee_plan', entityId: a.planId, next: { plan: plan.name, learners: out.created, net_each: out.net_each, discount: fromPaise(a.discountPaise), batch_id: a.batchId, start_date: a.startDate }, req: c.req }, db);
  return out;
}

// ---------------------------------------------------------------------------------------------- reading
export interface Ledger {
  learner: { id: string; learner_code: string; full_name: string };
  totals: { billed: string; paid: string; outstanding: string; overdue: string; credit: string };
  fees: any[]; payments: any[]; open_links: any[];
}

export async function learnerLedger(orgId: string, learnerId: string, tz: string): Promise<Ledger> {
  const learner = await queryOne(`SELECT id, learner_code, full_name FROM learners WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [learnerId, orgId]);
  if (!learner) throw notFound('Learner');
  const fees = await query(`SELECT f.id, f.title, f.gross_amount, f.discount_amount, f.net_amount, f.start_date, f.status, f.note, f.cancel_reason, f.created_at, f.batch_id, b.name AS batch_name
      FROM learner_fees f LEFT JOIN batches b ON b.id = f.batch_id WHERE f.learner_id = $1 AND f.org_id = $2 ORDER BY f.created_at DESC`, [learnerId, orgId]);
  const insts = await query(`SELECT id, learner_fee_id, label, amount, paid_amount, due_date, status FROM fee_installments WHERE learner_id = $1 AND org_id = $2 ORDER BY due_date, id`, [learnerId, orgId]);
  const today = todayIn(tz);
  let billed = 0, paid = 0, overdue = 0;
  const byFee = new Map<string, any[]>();
  for (const i of insts) {
    const f = fees.find((x) => x.id === i.learner_fee_id); if (!f) continue;
    const bal = toPaise(i.amount) - toPaise(i.paid_amount);
    const od = f.status === 'active' && i.status !== 'cancelled' && i.status !== 'paid' && String(i.due_date) < today;
    if (f.status === 'active' && i.status !== 'cancelled') { billed += toPaise(i.amount); paid += toPaise(i.paid_amount); if (od) overdue += bal; }
    (byFee.get(i.learner_fee_id) ?? byFee.set(i.learner_fee_id, []).get(i.learner_fee_id)!).push({ ...i, balance: fromPaise(bal), overdue: od });
  }
  const payments = await query(`SELECT p.id, p.amount, p.unallocated_amount, p.refunded_amount, p.method, p.provider, p.receipt_no, p.status, p.paid_at, p.reference, p.note FROM payments p WHERE p.learner_id = $1 AND p.org_id = $2 ORDER BY p.paid_at DESC, p.id DESC LIMIT 200`, [learnerId, orgId]);
  const credit = payments.reduce((s, p) => s + toPaise(p.unallocated_amount), 0);
  const open_links = await query(`SELECT id, amount, short_url, expires_at, created_at FROM payment_links WHERE learner_id = $1 AND org_id = $2 AND status = 'created' AND expires_at > NOW(3) ORDER BY created_at DESC LIMIT 5`, [learnerId, orgId]);
  return {
    learner, fees: fees.map((f) => ({ ...f, installments: byFee.get(f.id) ?? [] })), payments, open_links,
    totals: { billed: fromPaise(billed), paid: fromPaise(paid), outstanding: fromPaise(billed - paid), overdue: fromPaise(overdue), credit: fromPaise(credit) },
  };
}
