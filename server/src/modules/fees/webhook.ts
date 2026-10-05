import crypto from 'node:crypto';
import { Router } from 'express';
import { Params, exec, query, queryOne, tx } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { limit } from '../../middleware/limits.js';
import { toPaise } from './money.js';
import { verifySignature } from './razorpay.js';
import { applyPayment } from './service.js';

/**
 * Razorpay webhooks. Public by necessity, so a request is trusted only when X-Razorpay-Signature matches an HMAC of the exact
 * raw body made with RAZORPAY_WEBHOOK_SECRET. Anything else looks like a 404. Handling is idempotent: the same event twice, or the same
 * payment twice, never records money twice.
 */
const router = Router();

const methodOf = (m: unknown) => ({ upi: 'upi', card: 'card', netbanking: 'bank_transfer', bank_transfer: 'bank_transfer' } as Record<string, string>)[String(m)] ?? 'online';

router.post('/razorpay', limit('webhook', 600), async (req, res) => {
  const raw = (req as any).rawBody as Buffer | undefined;
  if (!verifySignature(raw, req.get('x-razorpay-signature'))) return void res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  const body = req.body as any;
  const event = String(body?.event ?? '');
  const key = (req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(raw!).digest('hex')).slice(0, 190);
  try {
    const out = await tx(async (db) => {
      try {
        await exec(`INSERT INTO webhook_events (provider, event_key, payload, provider_message_id) VALUES ('razorpay',$1,$2,$3)`, [key, JSON.stringify(body ?? null).slice(0, 60000), body?.payload?.payment_link?.entity?.id ?? null], db);
      } catch (e: any) { if (e?.errno === 1062) return 'duplicate'; throw e; }
      let outcome = 'ignored';
      const link = body?.payload?.payment_link?.entity; const pay = body?.payload?.payment?.entity;
      if (event === 'payment_link.paid' && link?.id && pay?.id) {
        const l = await queryOne(`SELECT id, org_id, learner_id, installment_ids, status FROM payment_links WHERE provider = 'razorpay' AND provider_link_id = $1 FOR UPDATE`, [String(link.id)], db);
        if (!l) outcome = 'unmatched';
        else if (l.status === 'paid') outcome = 'duplicate';
        else {
          const sp = new Params();
          const still = await query(`SELECT i.id FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id AND f.status = 'active' WHERE i.learner_id = ${sp.add(l.learner_id)} AND i.status IN ('pending','partial') AND i.id IN ${sp.in(l.installment_ids as string[])}`, sp.values, db);
          await applyPayment(db, l.org_id, { learnerId: l.learner_id, amountPaise: Number(pay.amount) || toPaise(link.amount_paid) || 0, method: methodOf(pay.method) as any, provider: 'razorpay', providerPaymentId: String(pay.id), linkId: l.id, paidAt: new Date(), reference: String(pay.id), note: 'Paid online through a payment link', installmentIds: still.length ? still.map((x) => x.id as string) : undefined, allowCredit: true, recordedBy: null });
          await exec(`UPDATE payment_links SET status = 'paid', paid_at = NOW(3) WHERE id = $1`, [l.id], db);
          outcome = 'applied';
        }
      } else if ((event === 'payment_link.expired' || event === 'payment_link.cancelled') && link?.id) {
        await exec(`UPDATE payment_links SET status = $2 WHERE provider = 'razorpay' AND provider_link_id = $1 AND status = 'created'`, [String(link.id), event.endsWith('expired') ? 'expired' : 'cancelled'], db);
        outcome = 'applied';
      }
      await exec(`UPDATE webhook_events SET outcome = $1 WHERE provider = 'razorpay' AND event_key = $2`, [outcome, key], db);
      return outcome;
    });
    res.json({ ok: true, data: { outcome: out } });
  } catch (e) {
    logger.error({ err: e }, 'razorpay webhook processing failed');
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Could not process the event.' } });   // Razorpay retries
  }
});

export default router;
