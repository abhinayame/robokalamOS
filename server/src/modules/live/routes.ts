import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { assertManage, openRoom } from '../classroom/access.js';
import { orgInfo } from '../fees/service.js';
import { getZoom, isConfigured, isWebhookConfigured } from './zoom.js';
import { finalizeAttendance, normName } from './service.js';

const router = Router();
router.use(requireOrg, requirePerm('attendance:read'));

async function sessionAndRoom(req: Request, manage: boolean) {
  const s = await queryOne(`SELECT s.id, s.batch_id, s.title, s.starts_at, s.ends_at, s.status, s.zoom_meeting_id, s.meeting_url, s.live_started_at, s.live_ended_at, s.attendance_finalized_at FROM class_sessions s WHERE s.id = $1 AND s.org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req)]);
  if (!s) throw notFound('Class');
  const room = await openRoom(req, s.batch_id);        // 404 when the batch is outside the caller's scope
  if (manage) assertManage(room);
  return { s, room };
}

router.get('/status', wrap(async (_req, res) => {
  // Only whether things are set. Values are never returned.
  ok(res, { configured: isConfigured(), webhook_configured: isWebhookConfigured(), webhook_path: isWebhookConfigured() ? '/api/webhooks/zoom' : null, host: isConfigured() ? (env.ZOOM_HOST_USER === 'me' ? 'the account owner' : env.ZOOM_HOST_USER) : null });
}));

/** Create the Zoom meeting for a scheduled class and put its join link on the class. */
router.post('/sessions/:id/meeting', limit('bulk', 30), wrap(async (req, res) => {
  const { s, room } = await sessionAndRoom(req, true);
  if (!isConfigured()) throw conflict('Zoom is not connected yet. An admin needs to set the Zoom details on the server.', 'NOT_CONFIGURED');
  if (s.zoom_meeting_id) throw conflict('This class already has a Zoom meeting.', 'ALREADY_HAS_MEETING');
  if (s.status !== 'scheduled') throw conflict(`A ${s.status} class cannot get a new meeting.`, 'NOT_SCHEDULED');
  const start = new Date(s.starts_at); const end = s.ends_at ? new Date(s.ends_at) : null;
  if ((end ?? new Date(start.getTime() + 3600_000)).getTime() < Date.now()) throw badRequest('This class is already over.');
  const dur = Math.min(Math.max(end ? Math.round((end.getTime() - start.getTime()) / 60_000) : 60, 15), 480);
  const org = await orgInfo(orgIdOf(req));
  const r = await getZoom().createMeeting({ topic: `${room.batch.name} · ${s.title ?? 'Class'}`, startsAt: start, durationMin: dur, timezone: org.tz });
  if (!r.ok) throw new AppError(502, 'ZOOM_ERROR', `Zoom could not create the meeting: ${r.message}`);
  try { await exec(`UPDATE class_sessions SET zoom_meeting_id = $2, meeting_provider = 'zoom', meeting_url = $3 WHERE id = $1 AND zoom_meeting_id IS NULL`, [s.id, r.id, r.joinUrl]); }
  catch (e: any) { await getZoom().deleteMeeting(r.id); throw e; }
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'live.meeting_created', entityType: 'class_session', entityId: s.id, next: { meeting_id: r.id, batch: room.batch.batch_code }, req });
  ok(res, { id: s.id, meeting_url: r.joinUrl, meeting_provider: 'zoom' }, undefined, 201);
}));

router.delete('/sessions/:id/meeting', wrap(async (req, res) => {
  const { s } = await sessionAndRoom(req, true);
  if (!s.zoom_meeting_id) throw notFound('Zoom meeting');
  if (s.live_started_at) throw conflict('This class has already started on Zoom.', 'ALREADY_STARTED');
  await getZoom().deleteMeeting(s.zoom_meeting_id);
  await exec(`UPDATE class_sessions SET zoom_meeting_id = NULL, meeting_url = NULL, meeting_provider = NULL WHERE id = $1`, [s.id]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'live.meeting_removed', entityType: 'class_session', entityId: s.id, req });
  ok(res, { id: s.id, removed: true });
}));

/** The host link is fetched fresh each time (it expires) and never stored. */
router.post('/sessions/:id/start-link', limit('bulk', 30), wrap(async (req, res) => {
  const { s } = await sessionAndRoom(req, true);
  if (!s.zoom_meeting_id) throw notFound('Zoom meeting');
  const r = await getZoom().startUrl(s.zoom_meeting_id);
  if (!r.ok) throw new AppError(502, 'ZOOM_ERROR', `Zoom could not give a start link: ${r.message}`);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'live.start_link_issued', entityType: 'class_session', entityId: s.id, req });
  ok(res, { start_url: r.url });
}));

/** Who joined, for how long, and who we could not match to a learner. */
router.get('/sessions/:id/participants', wrap(async (req, res) => {
  const { s, room } = await sessionAndRoom(req, true);
  const rows = await query(`SELECT p.zoom_participant_id, p.name, p.email, p.joined_at, p.left_at, p.learner_id, p.match_method, l.full_name AS learner_name, l.learner_code FROM live_participants p LEFT JOIN learners l ON l.id = p.learner_id WHERE p.session_id = $1 ORDER BY p.joined_at, p.id`, [s.id]);
  const end = s.live_ended_at ? new Date(s.live_ended_at) : new Date();
  const by = new Map<string, any>();
  for (const r of rows) {
    const k = `${normName(r.name)}|${r.learner_id ?? ''}`;
    const m = by.get(k) ?? { name: r.name, email: r.email, joins: 0, minutes: 0, first_joined_at: r.joined_at, learner: r.learner_id ? { id: r.learner_id, full_name: r.learner_name, learner_code: r.learner_code } : null, match_method: r.match_method };
    m.joins++; m.minutes += Math.max(0, Math.round(((r.left_at ? new Date(r.left_at) : end).getTime() - new Date(r.joined_at).getTime()) / 60_000)); by.set(k, m);
  }
  const roster = await query(`SELECT l.id, l.full_name, l.learner_code FROM learners l JOIN learner_batch_memberships m ON m.learner_id = l.id AND m.batch_id = $1 AND m.status = 'active' WHERE l.deleted_at IS NULL ORDER BY l.full_name`, [room.batch.id]);
  const matched = new Set(rows.filter((r) => r.learner_id).map((r) => r.learner_id as string));
  const marks = await query(`SELECT learner_id, status, source, joined_minutes FROM attendance WHERE session_id = $1`, [s.id]);
  ok(res, { session: { id: s.id, title: s.title, starts_at: s.starts_at, live_started_at: s.live_started_at, live_ended_at: s.live_ended_at, finalized_at: s.attendance_finalized_at }, participants: [...by.values()], unmatched: [...by.values()].filter((p) => !p.learner), not_joined: roster.filter((l) => !matched.has(l.id)), roster, marks });
}));

router.post('/sessions/:id/match', wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(200), learner_id: uuid }), req.body);
  const { s, room } = await sessionAndRoom(req, true); const orgId = orgIdOf(req);
  const out = await tx(async (db) => {
    if (!(await queryOne(`SELECT 1 FROM learner_batch_memberships WHERE batch_id = $1 AND learner_id = $2 AND status = 'active'`, [room.batch.id, b.learner_id], db))) throw badRequest('That learner is not an active member of this batch.', [{ field: 'learner_id', message: 'Choose a learner from this batch.' }]);
    const alias = normName(b.name); if (!alias) throw badRequest('That name cannot be used for matching.');
    await exec(`INSERT INTO live_aliases (id, org_id, alias, learner_id, created_by) VALUES ($1,$2,$3,$4,$5) ON DUPLICATE KEY UPDATE learner_id = VALUES(learner_id), created_by = VALUES(created_by)`, [newId(), orgId, alias, b.learner_id, req.user!.id], db);
    const rows = await query(`SELECT id, name FROM live_participants WHERE session_id = $1`, [s.id], db);
    const ids = rows.filter((r) => normName(r.name) === alias).map((r) => r.id as number);
    if (!ids.length) throw notFound('Participant');
    const p = new Params();
    await exec(`UPDATE live_participants SET learner_id = ${p.add(b.learner_id)}, match_method = 'manual' WHERE id IN ${p.in(ids)}`, p.values, db);
    return { rows: ids.length };
  });
  await audit({ orgId, actor: req.user, action: 'live.participant_matched', entityType: 'class_session', entityId: s.id, next: { name: b.name, learner_id: b.learner_id }, req });
  ok(res, { ...out, attendance: await finalizeAttendance(s.id) });
}));

router.post('/sessions/:id/finalize', limit('bulk', 30), wrap(async (req, res) => {
  const { s } = await sessionAndRoom(req, true);
  const r = await finalizeAttendance(s.id);
  if (!r.held) throw conflict('Nobody has joined this class on Zoom yet, so there is nothing to mark from.', 'NO_JOIN_DATA');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'live.attendance_finalized', entityType: 'class_session', entityId: s.id, next: r, req });
  ok(res, r);
}));

/** Recording links are shown to everyone who can open the classroom (members and their parents), nobody else. */
router.get('/sessions/:id/recordings', wrap(async (req, res) => {
  const { s } = await sessionAndRoom(req, false);
  ok(res, await query(`SELECT id, share_url, passcode, duration_min, size_mb, recorded_at FROM class_recordings WHERE session_id = $1 ORDER BY recorded_at, created_at`, [s.id]));
}));

export default router;
