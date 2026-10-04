import { Router } from 'express';
import { exec, newId, query } from '../../db/pool.js';
import { ok, parse, paging, wrap } from '../../lib/http.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { isConfigured } from './provider.js';
import { parseUnsubscribe } from './outbox.js';

// ---- public: the signed link in a notification e-mail turns notification e-mails off for that address
export const publicEmail = Router();
const page = (title: string, msg: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;color:#12263f"><h2>${title}</h2><p>${msg}</p></body>`;
publicEmail.get('/unsubscribe/:token', limit('unsubscribe', 30), wrap(async (req, res) => {
  const u = parseUnsubscribe(String(req.params.token));
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (!u) return void res.status(400).send(page('Link not valid', 'This unsubscribe link is not valid.'));
  await exec(`INSERT IGNORE INTO email_optouts (id, email, org_id) VALUES ($1,$2,$3)`, [newId(), u.email, u.orgId]);
  res.send(page('You are unsubscribed', 'You will no longer get reminders and notices by e-mail from this school. Important account e-mails, such as password resets, are still sent.'));
}));

// ---- staff: delivery status (no message bodies)
const router = Router(); // mounted at /api/email
router.use(requireOrg, requirePerm('comms:read'));
router.get('/status', wrap(async (req, res) => {
  const c = await query(`SELECT status, COUNT(*) AS n FROM email_outbox WHERE org_id = $1 AND created_at > DATE_SUB(NOW(3), INTERVAL 7 DAY) GROUP BY status`, [orgIdOf(req)]);
  ok(res, { configured: isConfigured(), last_7_days: Object.fromEntries(c.map((r) => [r.status, Number(r.n)])) });
}));
router.get('/outbox', wrap(async (req, res) => {
  const pg = parse(paging, req.query); const lim = pg.page_size;
  ok(res, await query(`SELECT id, to_email, subject, category, status, attempts, last_error, created_at, sent_at FROM email_outbox WHERE org_id = $1 ORDER BY created_at DESC LIMIT ${lim} OFFSET ${(pg.page - 1) * lim}`, [orgIdOf(req)]));
}));
export default router;
