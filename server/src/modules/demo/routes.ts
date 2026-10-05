import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { appUrl } from '../../lib/appurl.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { normalizeMobile } from '../../lib/phone.js';
import { notifyUsers } from '../../lib/notify.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm, type AuthUser } from '../../middleware/auth.js';
import { queueMessage } from '../email/outbox.js';
import { isConfigured as emailConfigured } from '../email/provider.js';
import { createFollowUp, ensureLead, logCrmActivity } from '../crm/service.js';
import { changeStatus } from '../crm/routes.js';
import { assertBranch, createLearner } from '../learners/service.js';
import { linkParent, upsertParent } from '../parents/service.js';

const BEFORE_DEMO = ['new', 'contacted', 'interested', 'follow_up', 'demo_scheduled'];
const isoDt = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const slotBody = z.object({
  title: z.string().trim().min(2, 'Name the demo.').max(120), starts_at: isoDt, ends_at: isoDt, capacity: z.number().int().min(1).max(500).default(10),
  branch_id: uuid.nullish(), course_id: uuid.nullish(), meeting_url: z.string().trim().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'Use a link that starts with https://').nullish().or(z.literal('').transform(() => null)),
  location: z.string().trim().max(200).nullish(), host_user_id: uuid.nullish(),
}).refine((b) => b.ends_at > b.starts_at, { message: 'The demo must end after it starts.', path: ['ends_at'] });

const SEATS = `(SELECT COUNT(*) FROM demo_bookings b WHERE b.slot_id = s.id AND b.status IN ('booked','attended'))`;

// ------------------------------------------------------------------ staff
const router = Router(); // mounted at /api/demo
router.use(requireOrg, requirePerm('crm:read'));
const manage = requirePerm('crm:manage');

router.get('/settings', wrap(async (req, res) => {
  const o = await queryOne(`SELECT slug, demo_booking_enabled FROM organizations WHERE id = $1`, [orgIdOf(req)]);
  ok(res, { enabled: !!o?.demo_booking_enabled, public_url: `${appUrl()}/book-demo/${o?.slug}` });
}));
router.put('/settings', manage, wrap(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean() }), req.body); const orgId = orgIdOf(req);
  await exec(`UPDATE organizations SET demo_booking_enabled = $2 WHERE id = $1`, [orgId, b.enabled]);
  await audit({ orgId, actor: req.user, action: b.enabled ? 'demo.public_page_enabled' : 'demo.public_page_disabled', entityType: 'organization', entityId: orgId, req });
  ok(res, { enabled: b.enabled });
}));

router.get('/slots', wrap(async (req, res) => {
  const upcoming = req.query.when !== 'past';
  ok(res, await query(`SELECT s.id, s.title, s.starts_at, s.ends_at, s.capacity, s.status, s.meeting_url, s.location, s.branch_id, s.course_id, ${SEATS} AS booked,
      (SELECT COUNT(*) FROM demo_bookings b WHERE b.slot_id = s.id AND b.status = 'attended') AS attended
    FROM demo_slots s WHERE s.org_id = $1 AND s.starts_at ${upcoming ? '>=' : '<'} DATE_SUB(NOW(3), INTERVAL 2 HOUR) ORDER BY s.starts_at ${upcoming ? 'ASC' : 'DESC'} LIMIT 200`, [orgIdOf(req)]));
}));
router.post('/slots', manage, wrap(async (req, res) => {
  const b = parse(slotBody, req.body); const orgId = orgIdOf(req); const id = newId();
  if (b.starts_at.getTime() < Date.now() - 60_000) throw badRequest('A demo cannot start in the past.', [{ field: 'starts_at', message: 'Pick a future time.' }]);
  await tx(async (db) => {
    await assertBranch(db, orgId, b.branch_id);
    if (b.host_user_id && !(await queryOne(`SELECT 1 FROM users WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [b.host_user_id, orgId], db))) throw badRequest('Unknown host.');
    await exec(`INSERT INTO demo_slots (id, org_id, branch_id, course_id, title, starts_at, ends_at, capacity, meeting_url, location, host_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, orgId, b.branch_id ?? null, b.course_id ?? null, b.title, b.starts_at, b.ends_at, b.capacity, b.meeting_url ?? null, b.location ?? null, b.host_user_id ?? null, req.user!.id], db);
    await audit({ orgId, actor: req.user, action: 'demo.slot_created', entityType: 'demo_slot', entityId: id, next: { title: b.title, starts_at: b.starts_at }, req }, db);
  });
  ok(res, { id }, undefined, 201);
}));
router.patch('/slots/:id', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  const b = parse(z.object({ capacity: z.number().int().min(1).max(500).optional(), status: z.enum(['open', 'cancelled']).optional(), meeting_url: z.string().trim().url().max(500).nullish(), location: z.string().trim().max(200).nullish() }), req.body);
  await tx(async (db) => {
    const s = await queryOne(`SELECT id, title, status, capacity FROM demo_slots WHERE id = $1 AND org_id = $2 FOR UPDATE`, [id, orgId], db);
    if (!s) throw notFound('Demo slot');
    if (b.capacity !== undefined) {
      const n = Number((await queryOne(`SELECT COUNT(*) AS n FROM demo_bookings WHERE slot_id = $1 AND status IN ('booked','attended')`, [id], db))!.n);
      if (b.capacity < n) throw conflict(`${n} seat(s) are already booked. Capacity cannot go below that.`, 'CAPACITY_BELOW_BOOKED');
    }
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of ['capacity', 'status', 'meeting_url', 'location'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 2}`); }
    if (sets.length) await exec(`UPDATE demo_slots SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, [id, orgId, ...vals], db);
    if (b.status === 'cancelled' && s.status !== 'cancelled') {
      const aff = await query(`SELECT learner_id FROM demo_bookings WHERE slot_id = $1 AND status = 'booked'`, [id], db);
      await exec(`UPDATE demo_bookings SET status = 'cancelled' WHERE slot_id = $1 AND status = 'booked'`, [id], db);
      for (const a of aff) await logCrmActivity(db, { orgId, learnerId: a.learner_id, type: 'note', description: `Demo "${s.title}" was cancelled; the family needs a new slot`, staffId: req.user!.id });
    }
    await audit({ orgId, actor: req.user, action: 'demo.slot_updated', entityType: 'demo_slot', entityId: id, next: b, req }, db);
  });
  ok(res, { id });
}));

router.get('/bookings', wrap(async (req, res) => {
  const q = parse(z.object({ slot_id: uuid.optional(), status: z.enum(['booked', 'attended', 'no_show', 'cancelled']).optional() }), req.query);
  const p = new Params(); const w = [`b.org_id = ${p.add(orgIdOf(req))}`];
  if (q.slot_id) w.push(`b.slot_id = ${p.add(q.slot_id)}`); if (q.status) w.push(`b.status = ${p.add(q.status)}`);
  ok(res, await query(`SELECT b.id, b.status, b.booked_via, b.created_at, b.slot_id, s.title AS slot_title, s.starts_at, l.id AS learner_id, l.full_name, l.learner_code,
      (SELECT pa.full_name FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id WHERE lp.learner_id = l.id ORDER BY lp.is_primary DESC LIMIT 1) AS parent_name,
      (SELECT pa.mobile FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id WHERE lp.learner_id = l.id ORDER BY lp.is_primary DESC LIMIT 1) AS parent_mobile
    FROM demo_bookings b JOIN demo_slots s ON s.id = b.slot_id JOIN learners l ON l.id = b.learner_id WHERE ${w.join(' AND ')} ORDER BY s.starts_at DESC, b.created_at LIMIT 300`, p.values));
}));

router.post('/bookings', manage, wrap(async (req, res) => {
  const b = parse(z.object({ slot_id: uuid, learner_id: uuid }), req.body); const orgId = orgIdOf(req);
  const id = await tx(async (db) => {
    const l = await queryOne(`SELECT id FROM learners WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [b.learner_id, orgId], db);
    if (!l) throw notFound('Learner');
    return book(db, orgId, b.slot_id, b.learner_id, 'staff', req.user!.id);
  });
  ok(res, { id }, undefined, 201);
}));

router.post('/bookings/:id/status', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  const b = parse(z.object({ status: z.enum(['attended', 'no_show', 'cancelled']) }), req.body);
  await tx(async (db) => {
    const bk = await queryOne(`SELECT b.id, b.status, b.learner_id, s.title, s.starts_at FROM demo_bookings b JOIN demo_slots s ON s.id = b.slot_id WHERE b.id = $1 AND b.org_id = $2 FOR UPDATE`, [id, orgId], db);
    if (!bk) throw notFound('Booking');
    if (bk.status === b.status) return;
    if (bk.status === 'cancelled') throw conflict('A cancelled booking cannot be changed. Book a new slot instead.', 'BOOKING_CANCELLED');
    if (b.status === 'attended' && new Date(bk.starts_at).getTime() > Date.now() + 15 * 60_000) throw badRequest('This demo has not started yet.');
    await exec(`UPDATE demo_bookings SET status = $2 WHERE id = $1`, [id, b.status], db);
    if (b.status === 'attended') {
      const lead = await queryOne(`SELECT lead_status FROM crm_leads WHERE learner_id = $1`, [bk.learner_id], db);
      if (lead && BEFORE_DEMO.includes(lead.lead_status)) await changeStatus(db, { orgId, learnerId: bk.learner_id, to: 'demo_attended', actorId: req.user!.id });
      await logCrmActivity(db, { orgId, learnerId: bk.learner_id, type: 'demo_attended', description: `Attended the demo "${bk.title}"`, staffId: req.user!.id });
    } else if (b.status === 'no_show') {
      await logCrmActivity(db, { orgId, learnerId: bk.learner_id, type: 'note', description: `Did not come to the demo "${bk.title}"`, staffId: req.user!.id });
      const lead = await queryOne(`SELECT counsellor_user_id FROM crm_leads WHERE learner_id = $1 AND lead_status NOT IN ('converted','not_interested','lost')`, [bk.learner_id], db);
      if (lead?.counsellor_user_id) await createFollowUp(db, { orgId, learnerId: bk.learner_id, assignedTo: lead.counsellor_user_id, dueAt: new Date(Date.now() + 24 * 3600_000), note: `Missed the demo "${bk.title}": offer another slot`, actorId: req.user!.id });
    } else {
      await logCrmActivity(db, { orgId, learnerId: bk.learner_id, type: 'note', description: `Demo booking "${bk.title}" cancelled`, staffId: req.user!.id });
    }
    await audit({ orgId, actor: req.user, action: `demo.booking_${b.status}`, entityType: 'demo_booking', entityId: id, req }, db);
  });
  ok(res, { id, status: b.status });
}));

/** Take one seat. The slot row is locked, so two people can never take the last seat together. */
export async function book(db: any, orgId: string, slotId: string, learnerId: string, via: 'public' | 'staff', actorId: string | null) {
  const s = await queryOne(`SELECT id, title, status, starts_at, capacity, host_user_id, created_by FROM demo_slots WHERE id = $1 AND org_id = $2 FOR UPDATE`, [slotId, orgId], db);
  if (!s) throw notFound('Demo slot');
  if (s.status !== 'open' || new Date(s.starts_at).getTime() < Date.now()) throw conflict('This demo is no longer open for booking.', 'SLOT_CLOSED');
  const n = Number((await queryOne(`SELECT COUNT(*) AS n FROM demo_bookings WHERE slot_id = $1 AND status IN ('booked','attended')`, [slotId], db))!.n);
  if (n >= s.capacity) throw conflict('This demo is full. Please choose another time.', 'SLOT_FULL');
  const live = await queryOne(`SELECT COUNT(*) AS n FROM demo_bookings b JOIN demo_slots x ON x.id = b.slot_id WHERE b.learner_id = $1 AND b.status = 'booked' AND x.starts_at > NOW(3)`, [learnerId], db);
  if (Number(live!.n) >= 2) throw conflict('This child already has two upcoming demos booked.', 'TOO_MANY_BOOKINGS');
  const id = newId();
  try { await exec(`INSERT INTO demo_bookings (id, org_id, slot_id, learner_id, booked_via) VALUES ($1,$2,$3,$4,$5)`, [id, orgId, slotId, learnerId, via], db); }
  catch (e: any) { if (e?.errno === 1062) throw conflict('This child is already booked for this demo.', 'ALREADY_BOOKED'); throw e; }
  const lead = await ensureLead(db, { orgId, learnerId, actorId, fields: { lead_status: 'demo_scheduled', lead_source: via === 'public' ? 'Demo booking page' : null } });
  if (!lead) { const cur = await queryOne(`SELECT lead_status FROM crm_leads WHERE learner_id = $1`, [learnerId], db); if (cur && ['new', 'contacted', 'interested', 'follow_up'].includes(cur.lead_status)) await changeStatus(db, { orgId, learnerId, to: 'demo_scheduled', actorId }); }
  await logCrmActivity(db, { orgId, learnerId, type: 'demo_scheduled', description: `Booked the demo "${s.title}" (${via === 'public' ? 'online booking page' : 'by staff'})`, staffId: actorId });
  const notify = [s.host_user_id, s.created_by].filter((x) => x && x !== actorId) as string[];
  if (notify.length) await notifyUsers(db, { orgId, userIds: notify, kind: 'demo.booked', title: `New demo booking: ${s.title}`, body: `${n + 1} of ${s.capacity} seats taken`, link: '/demo' });
  return id;
}
export default router;

// ------------------------------------------------------------------ public booking page (opt-in per organization)
export const publicDemo = Router();
publicDemo.use(limit('public demo', 60));
const slugRe = /^[a-z0-9][a-z0-9-]{1,48}$/;
async function openOrg(slug: string) {
  if (!slugRe.test(slug)) return null;
  return queryOne(`SELECT id, name, brand_app_name, brand_color FROM organizations WHERE slug = $1 AND status = 'active' AND deleted_at IS NULL AND demo_booking_enabled = TRUE`, [slug]);
}
publicDemo.get('/demo/:slug/slots', wrap(async (req, res) => {
  const o = await openOrg(String(req.params.slug)); if (!o) throw notFound('Demo page');
  const rows = await query(`SELECT s.id, s.title, s.starts_at, s.ends_at, s.location, s.meeting_url IS NOT NULL AS online, s.capacity - ${SEATS} AS seats_left
      FROM demo_slots s WHERE s.org_id = $1 AND s.status = 'open' AND s.starts_at > DATE_ADD(NOW(3), INTERVAL 30 MINUTE) AND s.starts_at < DATE_ADD(NOW(3), INTERVAL 60 DAY) HAVING seats_left > 0 ORDER BY s.starts_at LIMIT 60`, [o.id]);
  res.set('Cache-Control', 'no-store');
  ok(res, { organization: o.brand_app_name || o.name, slots: rows.map((r) => ({ ...r, online: !!r.online, seats_left: Number(r.seats_left) })) });
}));

const publicBody = z.object({
  slot_id: uuid, child_name: z.string().trim().min(2, 'Enter the child\'s name.').max(80), parent_name: z.string().trim().min(2, 'Enter the parent\'s name.').max(80),
  mobile: z.string().trim().min(10, 'Enter a 10 digit mobile number.').max(20), email: z.string().trim().toLowerCase().email().max(160).nullish().or(z.literal('').transform(() => null)),
  website: z.string().max(200).optional(),                       // honeypot: people never see or fill it
});
publicDemo.post('/demo/:slug/book', limit('demo booking', 6), wrap(async (req, res) => {
  const o = await openOrg(String(req.params.slug)); if (!o) throw notFound('Demo page');
  const b = parse(publicBody, req.body);
  const confirmation = { booked: true };
  if (b.website) return void ok(res, confirmation, undefined, 201);            // a bot: look successful, do nothing
  const mobile = normalizeMobile(b.mobile);
  if (!mobile) throw badRequest('Enter a valid 10 digit mobile number.', [{ field: 'mobile', message: 'Invalid mobile number.' }]);
  const recent = await queryOne(`SELECT COUNT(*) AS n FROM demo_bookings bk JOIN learner_parents lp ON lp.learner_id = bk.learner_id JOIN parents pa ON pa.id = lp.parent_id WHERE bk.org_id = $1 AND bk.booked_via = 'public' AND pa.mobile = $2 AND bk.created_at > DATE_SUB(NOW(3), INTERVAL 1 DAY)`, [o.id, mobile]);
  if (Number(recent!.n) >= 4) throw conflict('Too many bookings from this number today. Please call us instead.', 'RATE_LIMITED');

  const slot = await queryOne(`SELECT id, title, starts_at, ends_at, meeting_url, location, branch_id, created_by FROM demo_slots WHERE id = $1 AND org_id = $2`, [b.slot_id, o.id]);
  if (!slot) throw notFound('Demo slot');
  const creator = slot.created_by ? await queryOne(`SELECT id, email, full_name FROM users WHERE id = $1`, [slot.created_by]) : null;
  if (!creator) throw conflict('Booking is not available right now. Please call us.', 'UNAVAILABLE');
  // the lead is created on behalf of whoever published the slot (visible in the audit trail), never anonymously
  const actor = { id: creator.id, email: creator.email, fullName: creator.full_name, userOrgId: o.id, roles: ['org_admin'], isSuperAdmin: false, permissions: new Set<string>(), access: { orgWide: true, branchIds: [], teacher: false, ownLearnerIds: [] }, sessionId: '' } as unknown as AuthUser;

  await tx(async (db) => {
    // an existing child of this parent with the same name is reused; otherwise a new profile (siblings share the parent)
    const sameChild = await queryOne(`SELECT l.id FROM learners l JOIN learner_parents lp ON lp.learner_id = l.id JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL
        WHERE l.org_id = $1 AND l.deleted_at IS NULL AND pa.mobile = $2 AND LOWER(TRIM(l.full_name)) = LOWER($3) LIMIT 1`, [o.id, mobile, b.child_name], db);
    let learnerId = sameChild?.id as string | undefined;
    if (!learnerId) {
      const l = await createLearner(db, { user: actor, orgId: o.id }, { full_name: b.child_name, branch_id: slot.branch_id ?? null, parent: { full_name: b.parent_name, mobile, email: b.email ?? null, relationship: 'guardian' } }, null);
      learnerId = l.id;
    }
    await book(db, o.id, b.slot_id, learnerId!, 'public', null);
    if (b.email && emailConfigured()) {
      await queueMessage({ orgId: o.id, orgName: o.brand_app_name || o.name, color: o.brand_color ?? undefined, to: b.email, toName: b.parent_name, subject: `Your demo class is booked: ${slot.title}`, category: 'transactional', learnerId,
        paragraphs: [`Hi ${b.parent_name}, ${b.child_name}'s demo class is booked.`, `${slot.title} · ${new Date(slot.starts_at).toUTCString().replace(' GMT', ' UTC')}`, slot.meeting_url ? `Join online: ${slot.meeting_url}` : (slot.location ? `Where: ${slot.location}` : 'We will share the details before the class.'), 'If you cannot come, just reply to this e-mail or call us.'], dedupeKey: `demo:${b.slot_id}:${learnerId}` }, db);
    }
    await audit({ orgId: o.id, actor: creator as any, action: 'demo.booked_publicly', entityType: 'learner', entityId: learnerId!, next: { slot_id: b.slot_id }, }, db);
  });
  ok(res, { ...confirmation, title: slot.title, starts_at: slot.starts_at, ends_at: slot.ends_at, online: !!slot.meeting_url, location: slot.location, join_url: slot.meeting_url ?? null }, undefined, 201);
}));
