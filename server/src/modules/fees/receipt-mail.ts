import { query, queryOne, type Db } from '../../db/pool.js';
import { appUrl } from '../../lib/appurl.js';
import { validEmail, queueMessage } from '../email/outbox.js';
import { isConfigured as emailConfigured } from '../email/provider.js';
import { rupees, toPaise } from './money.js';

/**
 * E-mail a receipt right after a payment is recorded (manual or online). It goes to the primary parent's address, else the learner's own.
 * Does nothing when e-mail is not configured, the school switched receipts off, or nobody has an address. One receipt per payment, ever.
 */
export async function queueReceiptEmail(db: Db, orgId: string, paymentId: string) {
  if (!emailConfigured()) return null;
  const org = await queryOne(`SELECT name, brand_app_name, brand_color, receipt_email FROM organizations WHERE id = $1`, [orgId], db);
  if (!org?.receipt_email) return null;
  const pay = await queryOne(`SELECT p.amount, p.receipt_no, p.paid_at, p.method, p.unallocated_amount, l.id AS learner_id, l.full_name, l.email AS learner_email FROM payments p JOIN learners l ON l.id = p.learner_id WHERE p.id = $1 AND p.org_id = $2`, [paymentId, orgId], db);
  if (!pay) return null;
  const parent = await queryOne(`SELECT pa.full_name, pa.email FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL WHERE lp.learner_id = $1 AND pa.email IS NOT NULL ORDER BY lp.is_primary DESC, lp.created_at LIMIT 1`, [pay.learner_id], db);
  const to = [parent?.email, pay.learner_email].find((e) => validEmail(e)) as string | undefined;
  if (!to) return null;
  const allocs = await query(`SELECT f.title AS fee_title, i.label, a.amount FROM payment_allocations a JOIN fee_installments i ON i.id = a.installment_id JOIN learner_fees f ON f.id = i.learner_fee_id WHERE a.payment_id = $1 AND a.amount > 0 ORDER BY i.due_date`, [paymentId], db);
  const lines = allocs.map((a) => `${a.fee_title}, ${a.label}: ${rupees(toPaise(a.amount))}`);
  if (toPaise(pay.unallocated_amount) > 0) lines.push(`Advance credit: ${rupees(toPaise(pay.unallocated_amount))}`);
  const name = org.brand_app_name || org.name;
  return queueMessage({ orgId, orgName: name, color: org.brand_color ?? undefined, to, toName: parent?.full_name ?? pay.full_name, category: 'transactional', learnerId: pay.learner_id, dedupeKey: `receipt:${paymentId}`,
    subject: `Payment received: ${rupees(toPaise(pay.amount))} (receipt ${pay.receipt_no})`, title: 'Thank you, we received your payment',
    paragraphs: [`${rupees(toPaise(pay.amount))} received for ${pay.full_name} on ${new Date(pay.paid_at).toISOString().slice(0, 10)} (${String(pay.method).replace('_', ' ')}). Receipt number ${pay.receipt_no}.`, ...(lines.length ? [`Paid towards: ${lines.join('; ')}.`] : []), 'You can download the receipt PDF any time from My fees.'],
    button: { label: 'Open My fees', url: `${appUrl()}/my-fees` } }, db);
}
