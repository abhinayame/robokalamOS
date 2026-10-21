import crypto from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode';
import { appUrl } from '../../lib/appurl.js';
import { z } from 'zod';
import { exec, newId, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { recordActivity } from '../../lib/timeline.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg } from '../../middleware/auth.js';
import { assertManage, assertWritable, openRoom } from '../classroom/access.js';

/**
 * QR check-in. The teacher opens check-in for one class and shows a QR code that changes every 30 seconds; a learner who is signed in scans it
 * and is marked present (or late). The code is signed with a secret that never leaves the server, so it cannot be forged, and a photo of an old
 * screen stops working within a minute. Only an active member of the class's batch can check in, and only around the class time.
 */
const router = Router(); // mounted at /api/checkin
router.use(requireOrg);
const STEP = 30;            // seconds a code stays current
const LATE_AFTER_MIN = 10;  // arriving later than this after the start is "late"
const sign = (secret: string, sessionId: string, win: number) => crypto.createHmac('sha256', secret).update(`${sessionId}.${win}`).digest('hex').slice(0, 20);
const tokenFor = (secret: string, sessionId: string, now = Date.now()) => { const win = Math.floor(now / 1000 / STEP); return `${sessionId}.${win}.${sign(secret, sessionId, win)}`; };
function checkToken(secret: string, token: string, now = Date.now()): string | null {
  const [sid, w, sig] = token.split('.'); const win = Number(w); const cur = Math.floor(now / 1000 / STEP);
  if (!sid || !sig || !Number.isInteger(win) || (win !== cur && win !== cur - 1)) return null;
  const want = sign(secret, sid, win); return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? sid : null;
}
async function sessionFor(req: any, sessionId: string, db?: any) {
  const s = await queryOne(`SELECT id, batch_id, title, starts_at, ends_at, status, checkin_secret, checkin_open_until FROM class_sessions WHERE id = $1 AND org_id = $2`, [sessionId, orgIdOf(req)], db);
  if (!s) throw notFound('Class'); return s;
}

router.post('/sessions/:id/open', wrap(async (req, res) => {
  const b = parse(z.object({ minutes: z.number().int().min(2).max(120).default(20) }), req.body ?? {}); const s = await sessionFor(req, parse(uuid, req.params.id));
  const room = await openRoom(req, s.batch_id); assertManage(room); assertWritable(room);
  if (s.status === 'cancelled') throw new AppError(409, 'CANCELLED', 'This class was cancelled.');
  const secret = s.checkin_secret ?? crypto.randomBytes(16).toString('hex');
  await exec(`UPDATE class_sessions SET checkin_secret = $2, checkin_open_until = DATE_ADD(NOW(3), INTERVAL $3 MINUTE) WHERE id = $1`, [s.id, secret, b.minutes]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'checkin.opened', entityType: 'class_session', entityId: s.id, next: { minutes: b.minutes }, req });
  ok(res, { open_until: new Date(Date.now() + b.minutes * 60_000).toISOString() });
}));
router.post('/sessions/:id/close', wrap(async (req, res) => {
  const s = await sessionFor(req, parse(uuid, req.params.id)); const room = await openRoom(req, s.batch_id); assertManage(room);
  await exec(`UPDATE class_sessions SET checkin_open_until = NULL WHERE id = $1`, [s.id]); ok(res, { closed: true });
}));
/** The code to put on screen right now, how long it lasts, and how many have checked in. */
router.get('/sessions/:id/code', wrap(async (req, res) => {
  const s = await sessionFor(req, parse(uuid, req.params.id)); const room = await openRoom(req, s.batch_id); assertManage(room);
  const open = s.checkin_secret && s.checkin_open_until && new Date(s.checkin_open_until).getTime() > Date.now();
  const n = Number((await queryOne(`SELECT COUNT(*) AS n FROM attendance WHERE session_id = $1 AND source = 'qr'`, [s.id]))!.n);
  if (!open) return ok(res, { open: false, checked_in: n });
  const path = `/checkin/${tokenFor(s.checkin_secret, s.id)}`;
  ok(res, { open: true, path, qr: await QRCode.toDataURL(`${appUrl()}${path}`, { margin: 1, width: 360 }), expires_in: STEP - (Math.floor(Date.now() / 1000) % STEP), open_until: s.checkin_open_until, checked_in: n });
}));

/** A learner scans the code. */
router.post('/', limit('check-in', 20), wrap(async (req, res) => {
  const b = parse(z.object({ token: z.string().trim().min(20).max(200) }), req.body); const u = req.user!;
  if (!u.roles.includes('learner') || !u.access.ownLearnerIds.length) throw forbidden('Only learners check in to class.');
  const sid = b.token.split('.')[0] ?? ''; if (!/^[0-9a-f-]{36}$/.test(sid)) throw new AppError(400, 'BAD_CODE', 'That code is not valid. Ask your teacher to show it again.');
  const out = await tx(async (db) => {
    const s = await queryOne(`SELECT id, org_id, batch_id, title, starts_at, ends_at, status, created_by, checkin_secret, checkin_open_until FROM class_sessions WHERE id = $1 AND org_id = $2`, [sid, orgIdOf(req)], db);
    if (!s?.checkin_secret || checkToken(s.checkin_secret, b.token) !== s.id) throw new AppError(400, 'BAD_CODE', 'That code has expired. Scan the one on the screen now.');
    if (!s.checkin_open_until || new Date(s.checkin_open_until).getTime() < Date.now()) throw new AppError(409, 'CLOSED', 'Check-in for this class is closed.');
    if (s.status === 'cancelled') throw new AppError(409, 'CANCELLED', 'This class was cancelled.');
    const lid = (await queryOne(`SELECT m.learner_id FROM learner_batch_memberships m WHERE m.batch_id = $1 AND m.status = 'active' AND m.learner_id IN (${u.access.ownLearnerIds.map((_, i) => `$${i + 2}`).join(',')}) LIMIT 1`, [s.batch_id, ...u.access.ownLearnerIds], db))?.learner_id;
    if (!lid) throw forbidden('You are not in this class.');
    const start = new Date(s.starts_at).getTime(); const status = Date.now() - start > LATE_AFTER_MIN * 60_000 ? 'late' : 'present';
    const prev = await queryOne(`SELECT status, source FROM attendance WHERE session_id = $1 AND learner_id = $2`, [s.id, lid], db);
    if (prev && prev.source === 'manual') return { status: prev.status, already: true, title: s.title };   // a teacher's mark always wins
    if (prev?.source === 'qr') return { status: prev.status, already: true, title: s.title };
    await exec(`INSERT INTO attendance (id, org_id, session_id, batch_id, learner_id, status, note, marked_by, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'qr')
        ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), marked_by = VALUES(marked_by), marked_at = NOW(3), source = 'qr'`, [newId(), s.org_id, s.id, s.batch_id, lid, status, 'Checked in by QR code', u.id], db);
    await recordActivity(db, { orgId: s.org_id, learnerId: lid, batchId: s.batch_id, type: 'attendance.marked', title: `Checked in (${status})`, meta: { session_id: s.id, source: 'qr' }, actorUserId: u.id });
    return { status, already: false, title: s.title };
  });
  ok(res, out);
}));
export default router;
