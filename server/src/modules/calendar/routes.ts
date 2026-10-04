import { Router } from 'express';
import { exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { ok, uuid, parse, wrap } from '../../lib/http.js';
import { appUrl } from '../../lib/appurl.js';
import { randomToken, sha256 } from '../../lib/security.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg } from '../../middleware/auth.js';
import { buildIcs, type IcsEvent } from './ics.js';

/** Personal feed: classes of the batches this user teaches, or that their learner(s)/children attend. */
async function feedEvents(userId: string, orgId: string): Promise<{ name: string; events: IcsEvent[] }> {
  const rows = await query(
    `SELECT DISTINCT s.id, s.title, s.starts_at, s.ends_at, s.status, s.meeting_url, s.updated_at, b.name AS batch_name
       FROM class_sessions s JOIN batches b ON b.id = s.batch_id AND b.org_id = s.org_id
      WHERE s.org_id = $1 AND s.starts_at BETWEEN DATE_SUB(NOW(3), INTERVAL 30 DAY) AND DATE_ADD(NOW(3), INTERVAL 120 DAY)
        AND (EXISTS (SELECT 1 FROM teacher_batch_memberships t WHERE t.batch_id = s.batch_id AND t.teacher_user_id = $2 AND t.status = 'active')
          OR EXISTS (SELECT 1 FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id AND l.deleted_at IS NULL
                      WHERE m.batch_id = s.batch_id AND m.status = 'active' AND (l.user_id = $2
                        OR EXISTS (SELECT 1 FROM learner_parents lp JOIN parents p ON p.id = lp.parent_id AND p.deleted_at IS NULL WHERE lp.learner_id = l.id AND p.user_id = $2))))
      ORDER BY s.starts_at LIMIT 1000`, [orgId, userId]);
  const org = await queryOne(`SELECT COALESCE(brand_app_name, name) AS name FROM organizations WHERE id = $1`, [orgId]);
  return { name: `${org?.name ?? 'Classes'} classes`, events: rows.map((r) => ({
    uid: `${r.id}@classes.robokalam`, start: r.starts_at, end: r.ends_at ?? new Date(new Date(r.starts_at).getTime() + 3600_000), title: `${r.batch_name}: ${r.title}`,
    description: r.meeting_url ? `Join: ${r.meeting_url}` : null, location: r.meeting_url ?? null, cancelled: r.status === 'cancelled', updated: r.updated_at })) };
}

// ---- signed-in: manage my feed link (the link is shown once; only its hash is kept)
const router = Router(); // mounted at /api/calendar
router.use(requireOrg);
router.get('/me', wrap(async (req, res) => {
  const t = await queryOne(`SELECT created_at, last_used_at FROM calendar_tokens WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL`, [req.user!.id, orgIdOf(req)]);
  ok(res, { active: !!t, created_at: t?.created_at ?? null, last_used_at: t?.last_used_at ?? null });
}));
router.post('/me/regenerate', limit('calendar link', 10), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const token = randomToken(32);
  await exec(`UPDATE calendar_tokens SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL`, [req.user!.id]);
  await exec(`INSERT INTO calendar_tokens (id, org_id, user_id, token_hash) VALUES ($1,$2,$3,$4)`, [newId(), orgId, req.user!.id, sha256(token)]);
  await audit({ orgId, actor: req.user, action: 'calendar.link_created', entityType: 'user', entityId: req.user!.id, req });
  ok(res, { url: `${appUrl()}/api/public/calendar/${token}.ics` });
}));
router.delete('/me', wrap(async (req, res) => {
  await exec(`UPDATE calendar_tokens SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL`, [req.user!.id]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'calendar.link_revoked', entityType: 'user', entityId: req.user!.id, req });
  ok(res, { revoked: true });
}));
// One class as a .ics file, for "add to my calendar".
router.get('/session/:id.ics', wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  const { events } = await feedEvents(req.user!.id, orgId);
  const e = events.find((x) => x.uid === `${id}@classes.robokalam`);
  if (!e) throw notFound('Class');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="class.ics"', 'Cache-Control': 'no-store' }).send(buildIcs('Class', [e]));
}));
export default router;

// ---- public: the secret link itself is the credential
export const publicCalendar = Router();
publicCalendar.get('/calendar/:file', limit('calendar feed', 60), wrap(async (req, res) => {
  const m = /^([A-Za-z0-9_-]{20,100})\.ics$/.exec(String(req.params.file));
  if (!m) throw notFound('Calendar');
  const t = await queryOne(
    `SELECT c.id, c.org_id, c.user_id FROM calendar_tokens c JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL AND u.status = 'active'
      WHERE c.token_hash = $1 AND c.revoked_at IS NULL`, [sha256(m[1]!)]);
  if (!t) throw notFound('Calendar');
  await exec(`UPDATE calendar_tokens SET last_used_at = NOW(3) WHERE id = $1`, [t.id]);
  const { name, events } = await feedEvents(t.user_id, t.org_id);
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Robots-Tag': 'noindex' }).send(buildIcs(name, events));
}));
