import type { Request } from 'express';
import { exec, query, queryOne, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { recordActivity } from '../../lib/timeline.js';
import type { AuthUser } from '../../middleware/auth.js';
import { fromPaise, rupees, toPaise } from './money.js';
import { queueReceiptEmail } from './receipt-mail.js';

const statusFor = (amountP: number, paidP: number) => (paidP >= amountP ? 'paid' : paidP > 0 ? 'partial' : 'pending');

/** Split `total` paise by `weights` so the pieces add up to exactly `total` (largest remainder). */
export function splitProportional(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sum <= 0) { const even = Math.floor(total / weights.length); return weights.map((_, i) => even + (i < total - even * weights.length ? 1 : 0)); }
  const raw = weights.map((w) => (w * total) / sum); const base = raw.map(Math.floor); let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; base[i]!++; left--; }
  return base;
}

/** The accounts team may give any discount up to the school's limit; above it (or with no limit set) only owners and people allowed unlimited discounts. */
export async function checkDiscountAllowed(db: Db | undefined, orgId: string, user: AuthUser, pct: number) {
  if (!(user.isSuperAdmin || user.permissions.has('fee:discount'))) throw forbidden('You are not allowed to give discounts.');
  const org = await queryOne(`SELECT discount_limit_percent FROM organizations WHERE id = $1`, [orgId], db as Db);
  const limit = org?.discount_limit_percent == null ? null : Number(org.discount_limit_percent);
  if (limit !== null && pct > limit + 1e-9 && !(user.isSuperAdmin || user.permissions.has('fee:discount_unlimited'))) throw forbidden(`Discounts above ${limit}% need an owner to approve. This one is ${Math.round(pct * 10) / 10}%.`);
}

export interface DiscountInput { feeId: string; type: 'percent' | 'amount' | 'none'; value: number; reason: string; presetId?: string | null }

/**
 * Give, change or remove the discount on one learner's fee. The unpaid installments are re-split in proportion; what is already paid is never
 * touched (an installment cannot go below it). Everything is recorded in the fee's adjustment history.
 */
export async function setFeeDiscount(db: Db, c: { orgId: string; user: AuthUser; req?: Request }, a: DiscountInput) {
  const fee = await queryOne(`SELECT id, learner_id, title, status, gross_amount, discount_amount, net_amount, discount_type, discount_value FROM learner_fees WHERE id = $1 AND org_id = $2 FOR UPDATE`, [a.feeId, c.orgId], db);
  if (!fee) throw notFound('Fee');
  if (fee.status !== 'active') throw conflict('This fee is cancelled, so its discount cannot be changed.', 'CANCELLED');
  const gross = toPaise(fee.gross_amount);
  const discountP = a.type === 'none' ? 0 : a.type === 'percent' ? Math.round((gross * Math.min(Math.max(a.value, 0), 100)) / 100) : toPaise(a.value);
  if (discountP < 0 || discountP > gross) throw badRequest(`The discount can be at most ${rupees(gross)}, the full fee.`, [{ field: 'value', message: `At most ${rupees(gross)}.` }]);
  const pct = gross ? (discountP / gross) * 100 : 0;
  await checkDiscountAllowed(db, c.orgId, c.user, pct);

  const insts = await query(`SELECT id, amount, base_amount, paid_amount, status FROM fee_installments WHERE learner_fee_id = $1 ORDER BY due_date, id FOR UPDATE`, [a.feeId], db);
  if (!insts.length) throw badRequest('This fee has no installments.');
  const net = gross - discountP; const paid = insts.map((i) => toPaise(i.paid_amount));
  const paidTotal = paid.reduce((x, y) => x + y, 0);
  if (net < paidTotal) throw conflict(`${rupees(paidTotal)} has already been paid, which is more than the new fee of ${rupees(net)}. Refund part of it first, or give a smaller discount.`, 'ALREADY_PAID');
  // Instalments with money on them keep at least what was paid; the rest of the fee is shared among the unpaid ones in proportion.
  const weights = insts.map((i) => toPaise(i.base_amount ?? i.amount)); const prop = splitProportional(net, weights); const parts = prop.map((x, i) => (paid[i]! > 0 ? Math.max(x, paid[i]!) : 0));
  const unpaidIdx = insts.map((_, i) => i).filter((i) => paid[i] === 0);
  const lockedSum = parts.reduce((x, y) => x + y, 0);
  if (unpaidIdx.length && lockedSum <= net) { const share = splitProportional(net - lockedSum, unpaidIdx.map((i) => weights[i]!)); unpaidIdx.forEach((i, k) => { parts[i] = share[k]!; }); }
  else { unpaidIdx.forEach((i) => { parts[i] = 0; }); let excess = parts.reduce((x, y) => x + y, 0) - net; for (let i = parts.length - 1; i >= 0 && excess > 0; i--) { const take = Math.min(parts[i]! - paid[i]!, excess); parts[i]! -= take; excess -= take; } if (excess > 0 || parts.reduce((x, y) => x + y, 0) !== net) throw conflict('That discount cannot be spread over the installments already paid. Give a smaller discount.', 'ALREADY_PAID'); }

  for (const [i, inst] of insts.entries()) {
    const part = parts[i]!;
    if (part === 0 && paid[i] === 0) await exec(`UPDATE fee_installments SET status = 'cancelled' WHERE id = $1`, [inst.id], db);          // fully waived: kept for the record, owes nothing
    else await exec(`UPDATE fee_installments SET amount = $2, status = $3 WHERE id = $1`, [inst.id, fromPaise(part), statusFor(part, paid[i]!)], db);
  }
  await exec(`UPDATE learner_fees SET discount_amount = $2, net_amount = $3, discount_type = $4, discount_value = $5, discount_reason = $6 WHERE id = $1`,
    [a.feeId, fromPaise(discountP), fromPaise(net), a.type === 'none' ? null : a.type, a.type === 'none' ? null : a.value, a.type === 'none' ? null : a.reason], db);
  await exec(`INSERT INTO fee_adjustments (org_id, learner_fee_id, learner_id, before_discount, after_discount, before_net, after_net, discount_type, discount_value, reason, preset_id, adjusted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [c.orgId, a.feeId, fee.learner_id, fee.discount_amount, fromPaise(discountP), fee.net_amount, fromPaise(net), a.type === 'none' ? null : a.type, a.type === 'none' ? null : a.value, a.reason, a.presetId ?? null, c.user.id], db);
  await recordActivity(db, { orgId: c.orgId, learnerId: fee.learner_id, type: 'fee.discount', title: discountP ? `Discount of ${rupees(discountP)} on ${fee.title}` : `Discount removed from ${fee.title}`, description: a.reason, actorUserId: c.user.id });
  await audit({ orgId: c.orgId, actor: c.user, action: 'fee.discount_set', entityType: 'learner_fee', entityId: a.feeId, previous: { discount: fee.discount_amount, net: fee.net_amount }, next: { discount: fromPaise(discountP), net: fromPaise(net), type: a.type, value: a.value, reason: a.reason }, req: c.req }, db);
  return { fee_id: a.feeId, gross: fromPaise(gross), discount: fromPaise(discountP), net: fromPaise(net), percent: Math.round(pct * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------- correcting a payment
export interface PaymentPatch { paidAt?: Date; method?: string; reference?: string | null; note?: string | null; amountPaise?: number }
const snap = (p: any) => ({ amount: p.amount, method: p.method, paid_at: p.paid_at, reference: p.reference, note: p.note, unallocated_amount: p.unallocated_amount, revision: p.revision });

/** Take a payment's money back off the installments it was spread over (used by edit and by void). */
async function reverseAllocations(db: Db, orgId: string, paymentId: string) {
  const allocs = await query(`SELECT a.id, a.installment_id, a.amount FROM payment_allocations a JOIN fee_installments i ON i.id = a.installment_id WHERE a.payment_id = $1 AND a.amount > 0 ORDER BY i.due_date, i.id FOR UPDATE`, [paymentId], db);
  for (const a of allocs) {
    const i = await queryOne(`SELECT amount, paid_amount, status FROM fee_installments WHERE id = $1 FOR UPDATE`, [a.installment_id], db);
    if (!i) continue; const newPaid = Math.max(0, toPaise(i.paid_amount) - toPaise(a.amount));
    await exec(`UPDATE fee_installments SET paid_amount = $2, status = $3 WHERE id = $1`, [a.installment_id, fromPaise(newPaid), i.status === 'cancelled' ? 'cancelled' : statusFor(toPaise(i.amount), newPaid)], db);
    await exec(`UPDATE payment_allocations SET amount = 0 WHERE id = $1`, [a.id], db);
  }
  return allocs.map((a) => a.installment_id as string);
}

export async function editPayment(db: Db, c: { orgId: string; user: AuthUser; req?: Request }, paymentId: string, patch: PaymentPatch, reason: string, sendReceipt: boolean) {
  const pay = await queryOne(`SELECT * FROM payments WHERE id = $1 AND org_id = $2 FOR UPDATE`, [paymentId, c.orgId], db);
  if (!pay) throw notFound('Payment');
  await queryOne(`SELECT id FROM learners WHERE id = $1 AND org_id = $2 FOR UPDATE`, [pay.learner_id, c.orgId], db);
  if (pay.status === 'voided') throw conflict('This payment was cancelled, so it cannot be edited.', 'VOIDED');
  const before = snap(pay);
  const amountChanged = patch.amountPaise !== undefined && patch.amountPaise !== toPaise(pay.amount);
  const methodChanged = patch.method !== undefined && patch.method !== pay.method;
  const dateChanged = patch.paidAt !== undefined && patch.paidAt.getTime() !== new Date(pay.paid_at).getTime();
  if (pay.provider === 'razorpay' && (amountChanged || methodChanged || dateChanged)) throw conflict('An online payment is matched with Razorpay, so its amount, date and method cannot be changed. You can still edit the note.', 'ONLINE');
  if (amountChanged && toPaise(pay.refunded_amount) > 0) throw conflict('This payment has a refund on it. Edit the refund instead, or cancel the payment.', 'HAS_REFUND');
  if (patch.amountPaise !== undefined && !(patch.amountPaise > 0)) throw badRequest('Enter an amount greater than zero.', [{ field: 'amount', message: 'Must be more than 0.' }]);

  let amountP = toPaise(pay.amount); let unalloc = toPaise(pay.unallocated_amount);
  if (amountChanged) {
    const prev = await reverseAllocations(db, c.orgId, paymentId);
    const open = await query(`SELECT i.id, i.amount, i.paid_amount FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id AND f.status = 'active' WHERE i.learner_id = $1 AND i.org_id = $2 AND i.status IN ('pending','partial') ORDER BY i.due_date, i.created_at, i.id FOR UPDATE`, [pay.learner_id, c.orgId], db);
    const ordered = [...open.filter((r) => prev.includes(r.id)).sort((x, y) => prev.indexOf(x.id) - prev.indexOf(y.id)), ...open.filter((r) => !prev.includes(r.id))];   // the same installments first, then the oldest dues
    let left = patch.amountPaise!;
    for (const i of ordered) {
      if (left <= 0) break;
      const give = Math.min(left, toPaise(i.amount) - toPaise(i.paid_amount)); if (give <= 0) continue;
      const newPaid = toPaise(i.paid_amount) + give; left -= give;
      await exec(`INSERT INTO payment_allocations (org_id, payment_id, installment_id, amount) VALUES ($1,$2,$3,$4) ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)`, [c.orgId, paymentId, i.id, fromPaise(give)], db);
      await exec(`UPDATE fee_installments SET paid_amount = $2, status = $3 WHERE id = $1`, [i.id, fromPaise(newPaid), statusFor(toPaise(i.amount), newPaid)], db);
    }
    amountP = patch.amountPaise!; unalloc = Math.max(left, 0);
  }
  const rev = Number(pay.revision) + 1;
  await exec(`UPDATE payments SET amount = $2, unallocated_amount = $3, method = $4, paid_at = $5, reference = $6, note = $7, revision = $8, edited_at = NOW(3) WHERE id = $1`,
    [paymentId, fromPaise(amountP), fromPaise(unalloc), patch.method ?? pay.method, patch.paidAt ?? new Date(pay.paid_at), patch.reference === undefined ? pay.reference : patch.reference, patch.note === undefined ? pay.note : patch.note, rev], db);
  const after = snap(await queryOne(`SELECT * FROM payments WHERE id = $1`, [paymentId], db));
  await exec(`INSERT INTO payment_revisions (org_id, payment_id, revision, kind, reason, before_json, after_json, changed_by) VALUES ($1,$2,$3,'edit',$4,$5,$6,$7)`, [c.orgId, paymentId, rev, reason, JSON.stringify(before), JSON.stringify(after), c.user.id], db);
  await recordActivity(db, { orgId: c.orgId, learnerId: pay.learner_id, type: 'fee.payment_corrected', title: `Payment ${pay.receipt_no} corrected`, description: reason, actorUserId: c.user.id });
  await audit({ orgId: c.orgId, actor: c.user, action: 'payment.edited', entityType: 'payment', entityId: paymentId, previous: before, next: { ...after, reason }, req: c.req }, db);
  if (sendReceipt) await queueReceiptEmail(db, c.orgId, paymentId, { revision: rev });
  return { id: paymentId, revision: rev, receipt_no: pay.receipt_no };
}

/** Cancel a payment recorded by mistake: the installments it paid are reopened, and it stops counting everywhere. The receipt is kept, marked VOID. */
export async function voidPayment(db: Db, c: { orgId: string; user: AuthUser; req?: Request }, paymentId: string, reason: string) {
  const pay = await queryOne(`SELECT * FROM payments WHERE id = $1 AND org_id = $2 FOR UPDATE`, [paymentId, c.orgId], db);
  if (!pay) throw notFound('Payment');
  await queryOne(`SELECT id FROM learners WHERE id = $1 AND org_id = $2 FOR UPDATE`, [pay.learner_id, c.orgId], db);
  if (pay.status === 'voided') throw conflict('This payment is already cancelled.', 'VOIDED');
  if (toPaise(pay.refunded_amount) > 0) throw conflict('This payment already has a refund on it, so it cannot be cancelled as a mistake.', 'HAS_REFUND');
  if (pay.provider === 'razorpay') throw conflict('An online payment was really received through Razorpay. Refund it instead of cancelling it.', 'ONLINE');
  const before = snap(pay); await reverseAllocations(db, c.orgId, paymentId); const rev = Number(pay.revision) + 1;
  // refunded_amount = amount makes every total (dashboard, reports, ledger) see it as nothing, with no special cases anywhere
  await exec(`UPDATE payments SET status = 'voided', refunded_amount = amount, unallocated_amount = 0, voided_at = NOW(3), void_reason = $2, revision = $3, edited_at = NOW(3) WHERE id = $1`, [paymentId, reason, rev], db);
  await exec(`INSERT INTO payment_revisions (org_id, payment_id, revision, kind, reason, before_json, after_json, changed_by) VALUES ($1,$2,$3,'void',$4,$5,$6,$7)`, [c.orgId, paymentId, rev, reason, JSON.stringify(before), JSON.stringify({ status: 'voided' }), c.user.id], db);
  await recordActivity(db, { orgId: c.orgId, learnerId: pay.learner_id, type: 'fee.payment_voided', title: `Payment ${pay.receipt_no} cancelled`, description: reason, actorUserId: c.user.id });
  await audit({ orgId: c.orgId, actor: c.user, action: 'payment.voided', entityType: 'payment', entityId: paymentId, previous: before, next: { reason }, req: c.req }, db);
  return { id: paymentId, receipt_no: pay.receipt_no, status: 'voided' as const };
}
void query;
