import type { Request } from 'express';
import { env } from '../../config/env.js';
import { exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { Params } from '../../db/pool.js';
import type { AuthUser } from '../../middleware/auth.js';
import { fromPaise, toPaise } from './money.js';
import { getPaymentProvider, isConfigured } from './razorpay.js';

export interface PayLinkCtx { orgId: string; userId: string | null; actor?: AuthUser | null; req?: Request }

/**
 * A hosted payment page for what a learner owes now (all open installments, or the ones named). The caller has already checked that the
 * person may act for this learner. Asking twice for the same dues returns the same live link instead of making a second one.
 */
export async function createPayLink(c: PayLinkCtx, learnerId: string, installmentIds: string[] | undefined) {
  if (!isConfigured()) throw conflict('Online payments are not connected yet. An admin needs to set the Razorpay details on the server.', 'NOT_CONFIGURED');
  const l = await queryOne(`SELECT id, full_name, learner_code, mobile, email FROM learners WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [learnerId, c.orgId]);
  if (!l) throw notFound('Learner');
  const ip = new Params();
  const only = installmentIds?.length ? `AND i.id IN ${ip.in([...new Set(installmentIds)])}` : '';
  const open = await query(`SELECT i.id, i.amount, i.paid_amount FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id AND f.status = 'active'
      WHERE i.learner_id = ${ip.add(l.id)} AND i.org_id = ${ip.add(c.orgId)} AND i.status IN ('pending','partial') ${only} ORDER BY i.due_date, i.id`, ip.values);
  if (installmentIds?.length && open.length !== new Set(installmentIds).size) throw badRequest('Choose installments that are still unpaid.', [{ field: 'installment_ids', message: 'Choose open installments.' }]);
  if (!open.length) throw badRequest('There is nothing to pay right now.');
  const amountP = open.reduce((s, i) => s + toPaise(i.amount) - toPaise(i.paid_amount), 0);
  if (amountP < 100) throw badRequest('The amount due is less than ₹1.');
  const ids = open.map((i) => i.id as string).sort();
  const live = await query(`SELECT id, amount, short_url, expires_at, installment_ids FROM payment_links WHERE learner_id = $1 AND org_id = $2 AND status = 'created' AND expires_at > DATE_ADD(NOW(3), INTERVAL 1 HOUR) ORDER BY created_at DESC LIMIT 10`, [l.id, c.orgId]);
  const same = live.find((x) => toPaise(x.amount) === amountP && JSON.stringify([...(x.installment_ids as string[])].sort()) === JSON.stringify(ids));
  if (same) return { id: same.id as string, short_url: same.short_url as string, amount: same.amount as string, expires_at: same.expires_at as string, reused: true };

  const par = await queryOne(`SELECT pa.mobile, pa.email FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL WHERE lp.learner_id = $1 ORDER BY lp.is_primary DESC, pa.id LIMIT 1`, [l.id]);
  const id = newId(); const expires = new Date(Date.now() + 7 * 86_400_000);
  const first = String(env.CORS_ORIGINS).split(',')[0]?.trim();
  const r = await getPaymentProvider().createLink({ amountPaise: amountP, referenceId: id, description: `Fees for ${l.full_name} (${l.learner_code})`, expiresAt: expires, customer: { name: l.full_name, contact: par?.mobile ?? l.mobile, email: par?.email ?? l.email }, callbackUrl: first?.startsWith('https://') ? `${first}/my-fees` : null });
  if (!r.ok) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', `The payment provider could not create the link: ${r.message}`);
  await exec(`INSERT INTO payment_links (id, org_id, learner_id, amount, installment_ids, provider_link_id, short_url, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, c.orgId, l.id, fromPaise(amountP), JSON.stringify(ids), r.id, r.shortUrl, expires, c.userId]);
  await audit({ orgId: c.orgId, actor: c.actor ?? null, action: 'payment.link_created', entityType: 'payment_link', entityId: id, next: { learner_id: l.id, amount: fromPaise(amountP), installments: ids.length }, req: c.req });
  return { id, short_url: r.shortUrl, amount: fromPaise(amountP), expires_at: expires.toISOString(), reused: false };
}
