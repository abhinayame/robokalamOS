import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { normalizeMobile } from '../../lib/phone.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requirePerm } from '../../middleware/auth.js';
import { getEmailProvider, isConfigured as emailOn } from '../email/provider.js';
import { getPaymentProvider, isConfigured as razorpayOn } from '../fees/razorpay.js';
import { getZoom, isConfigured as zoomOn } from '../live/zoom.js';
import { isConfigured as pushOn, pushToUser } from '../push/service.js';
import { isConfigured as waOn, senderNumberSet, sendTemplateMessage } from '../comms/aisensy.js';

/**
 * One-click checks that a provider really works with the keys in the environment. Every check is harmless and cleans up after itself:
 * e-mail goes to the person pressing the button, Razorpay makes a 1-rupee link and cancels it, Zoom makes a meeting for tomorrow and deletes it,
 * WhatsApp sends one template message to a number the admin types (templates cost money and must be approved, so it is never automatic).
 * Results never include keys; provider messages are already redacted by the providers.
 */
const router = Router(); // mounted under /api/system
const gate = [requirePerm('system:test'), limit('self-test', 10)];
type Out = { ok: boolean; step: string; detail: string };
const done = (res: any, req: any, provider: string, r: Out) => audit({ orgId: orgIdOf(req), actor: req.user, action: `selftest.${provider}`, entityType: 'system', entityId: provider, next: { ok: r.ok, step: r.step }, req }).then(() => ok(res, r));

router.post('/selftest/email', ...gate, wrap(async (req, res) => {
  if (!emailOn()) return done(res, req, 'email', { ok: false, step: 'config', detail: 'Set SMTP_HOST and SMTP_FROM (and SMTP_USER / SMTP_PASSWORD) in the environment, then restart.' });
  const to = req.user!.email; if (!to) throw badRequest('Your account has no e-mail address to send the test to.');
  const r = await getEmailProvider().send({ to, subject: 'Robokalam test e-mail', text: 'If you can read this, your SMTP settings work. No action needed.' });
  return done(res, req, 'email', r.ok ? { ok: true, step: 'sent', detail: `Sent to ${to}. Check the inbox (and spam) to be sure it arrived.` } : { ok: false, step: r.code, detail: r.message });
}));

router.post('/selftest/razorpay', ...gate, wrap(async (req, res) => {
  if (!razorpayOn()) return done(res, req, 'razorpay', { ok: false, step: 'config', detail: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the environment, then restart.' });
  const p = getPaymentProvider();
  const r = await p.createLink({ amountPaise: 100, referenceId: `selftest-${Date.now()}`, description: 'Robokalam self-test (cancelled immediately)', expiresAt: new Date(Date.now() + 20 * 60_000), customer: { name: 'Self test' } });
  if (!r.ok) return done(res, req, 'razorpay', { ok: false, step: r.code, detail: r.message });
  await p.cancelLink(r.id);
  return done(res, req, 'razorpay', { ok: true, step: 'created and cancelled', detail: 'Razorpay accepted your keys: a Rs 1 test link was created and cancelled. Nobody was charged.' });
}));

router.post('/selftest/zoom', ...gate, wrap(async (req, res) => {
  if (!zoomOn()) return done(res, req, 'zoom', { ok: false, step: 'config', detail: 'Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (and ZOOM_HOST_USER) in the environment, then restart.' });
  const z2 = getZoom();
  const r = await z2.createMeeting({ topic: 'Robokalam self-test (deleted immediately)', startsAt: new Date(Date.now() + 24 * 3600_000), durationMin: 15, timezone: 'Asia/Kolkata' });
  if (!r.ok) return done(res, req, 'zoom', { ok: false, step: r.code, detail: r.message });
  await z2.deleteMeeting(r.id);
  return done(res, req, 'zoom', { ok: true, step: 'created and deleted', detail: 'Zoom accepted your app: a test meeting was created for tomorrow and deleted.' });
}));

router.post('/selftest/whatsapp', ...gate, wrap(async (req, res) => {
  const b = parse(z.object({ phone: z.string().trim().min(8).max(20), campaign_name: z.string().trim().min(2).max(120), params: z.array(z.string().max(200)).max(10).default([]) }), req.body);
  if (!waOn() || !senderNumberSet()) return done(res, req, 'whatsapp', { ok: false, step: 'config', detail: 'WhatsApp keys or sender number are not set in the environment.' });
  const e164 = normalizeMobile(b.phone); if (!e164) throw badRequest('That is not a valid mobile number.', [{ field: 'phone', message: 'Use a 10-digit Indian mobile or +country code.' }]);
  const r = await sendTemplateMessage({ destination: e164.slice(1), campaignName: b.campaign_name, userName: 'Test', templateParams: b.params });
  return done(res, req, 'whatsapp', r.ok ? { ok: true, step: 'accepted', detail: `The provider accepted the message to ${e164}. Check that the phone received it. "Accepted" is not "delivered".` } : { ok: false, step: r.code, detail: r.message });
}));

router.post('/selftest/push', ...gate, wrap(async (req, res) => {
  if (!pushOn()) return done(res, req, 'push', { ok: false, step: 'config', detail: 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto:you@school.in) in the environment, then restart. Make the keys with: npx web-push generate-vapid-keys' });
  const n = await pushToUser(req.user!.id, { title: 'Robokalam test notification', body: 'Push notifications work on this device.', url: '/' });
  return done(res, req, 'push', n ? { ok: true, step: 'sent', detail: `Sent to ${n} of your device${n === 1 ? '' : 's'}.` } : { ok: false, step: 'no devices', detail: 'Keys are set, but none of your devices allowed notifications yet. Open Account on your phone or computer and press "Turn on notifications".' });
}));
export default router;
