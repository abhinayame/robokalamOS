import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { notifyAbout } from '../../lib/notify.js';
import { recordActivity } from '../../lib/timeline.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { assertManage, assertWritable, openRoom, viewedLearner } from '../classroom/access.js';
import { addDays, attendancePct, providerFromUrl, weekdayOf, zonedToUtc } from './time.js';

export const sessionsRouter = Router();      // mounted at /api/classrooms
export const attendanceRouter = Router();    // mounted at /api/attendance
sessionsRouter.use(requireOrg, requirePerm('attendance:read'));
attendanceRouter.use(requireOrg, requirePerm('attendance:read'));

const httpUrl = z.string().trim().max(1000).url().refine((u) => /^https?:\/\//i.test(u), 'Use a link that starts with http:// or https://');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUSES = ['present', 'absent', 'late', 'excused'] as const;
const CLASS_SQL = `s.id, s.batch_id, s.title, s.starts_at, s.ends_at, s.meeting_provider, s.meeting_url, s.status, s.cancel_reason`;

// A learner may open the meeting link from shortly before the start until the class is over.
const joinable = (s: { status: string; starts_at: any; ends_at: any }, now = Date.now()) => {
  if (!['scheduled', 'started'].includes(s.status)) return false;
  const start = new Date(s.starts_at).getTime(); const end = s.ends_at ? new Date(s.ends_at).getTime() : start + 3 * 3600_000;
  return now >= start - 15 * 60_000 && now <= end + 30 * 60_000;
};
const shape = (s: any, canManage: boolean, mine?: any) => ({
  id: s.id, batch_id: s.batch_id, batch_name: s.batch_name, title: s.title, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status, cancel_reason: s.cancel_reason,
  meeting_provider: s.meeting_provider, has_meeting: !!s.meeting_url,
  ...(canManage || joinable(s) ? { meeting_url: s.meeting_url } : {}),
  can_join: !!s.meeting_url && joinable(s),
  ...(canManage ? { marked: s.marked == null ? undefined : Number(s.marked) } : { my_status: mine?.status ?? null }),
});

// ------------------------------------------------------------------ sessions of a classroom
sessionsRouter.get('/:batchId/sessions', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional(), status: z.enum(['scheduled', 'started', 'completed', 'cancelled']).optional(), learner_id: uuid.optional() }), req.query);
  const p = new Params();
  const w = [`s.batch_id = ${p.add(room.batch.id)}`];
  if (q.from) w.push(`s.starts_at >= ${p.add(`${q.from} 00:00:00`)}`);
  if (q.to) w.push(`s.starts_at < ${p.add(`${addDays(q.to, 1)} 00:00:00`)}`);
  if (q.status) w.push(`s.status = ${p.add(q.status)}`);
  const rows = await query(`SELECT ${CLASS_SQL}, (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS marked FROM class_sessions s WHERE ${w.join(' AND ')} ORDER BY s.starts_at DESC LIMIT 400`, p.values);
  const lid = room.canManage ? null : viewedLearner(room, q.learner_id);
  const mine = new Map<string, any>();
  if (lid && rows.length) { const ap = new Params(); for (const a of await query(`SELECT session_id, status FROM attendance WHERE learner_id = ${ap.add(lid)} AND session_id IN ${ap.in(rows.map((r) => r.id))}`, ap.values)) mine.set(a.session_id, a); }
  ok(res, rows.map((r) => shape({ ...r, batch_name: room.batch.name }, room.canManage, mine.get(r.id))), { can_manage: room.canManage, writable: room.writable });
}));

const sessionBody = z.object({
  title: z.string().trim().max(255).nullish(),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }).nullish(),
  meeting_url: httpUrl.nullish().or(z.literal('').transform(() => null)),
  meeting_provider: z.enum(['google_meet', 'zoom', 'webrtc', 'other']).nullish(),
});
const checkTimes = (s?: string, e?: string | null) => { if (s && e && new Date(e) <= new Date(s)) throw badRequest('The class must end after it starts.', [{ field: 'ends_at', message: 'Pick a time after the start.' }]); };
const dup = (e: any) => { if (e?.errno === 1062) throw conflict('This batch already has a class at that time.', 'DUPLICATE_SESSION'); throw e; };

sessionsRouter.post('/:batchId/sessions', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(sessionBody, req.body); checkTimes(b.starts_at, b.ends_at);
  const id = newId(); const orgId = orgIdOf(req);
  await exec(`INSERT INTO class_sessions (id, org_id, batch_id, title, starts_at, ends_at, meeting_provider, meeting_url, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, orgId, room.batch.id, b.title ?? null, new Date(b.starts_at), b.ends_at ? new Date(b.ends_at) : null, b.meeting_url ? (b.meeting_provider ?? providerFromUrl(b.meeting_url)) : null, b.meeting_url ?? null, req.user!.id]).catch(dup);
  await audit({ orgId, actor: req.user, action: 'session.created', entityType: 'class_session', entityId: id, next: { batch: room.batch.batch_code, starts_at: b.starts_at }, req });
  ok(res, { id }, undefined, 201);
}));

/** Create the classes a batch's weekly schedule implies for a date range (in the organization's timezone). Safe to repeat. */
sessionsRouter.post('/:batchId/sessions/generate', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(z.object({ from: isoDate, to: isoDate, meeting_url: httpUrl.nullish() }), req.body);
  if (b.to < b.from) throw badRequest('The end date must be after the start date.', [{ field: 'to', message: 'Pick a date after the start.' }]);
  if (new Date(`${b.to}T00:00:00Z`).getTime() - new Date(`${b.from}T00:00:00Z`).getTime() > 92 * 86_400_000) throw badRequest('Generate at most about three months at a time.', [{ field: 'to', message: 'Pick a shorter range.' }]);
  const batch = await queryOne(`SELECT schedule, start_date, end_date FROM batches WHERE id = $1`, [room.batch.id]);
  const sch = batch!.schedule ?? {};
  if (!Array.isArray(sch.days) || !sch.days.length || !sch.start) throw badRequest('Set the batch schedule (days and start time) first.');
  const tz = (await queryOne(`SELECT timezone FROM organizations WHERE id = $1`, [orgIdOf(req)]))!.timezone as string;
  const orgId = orgIdOf(req); let created = 0; let skipped = 0;
  for (let d = b.from; d <= b.to; d = addDays(d, 1)) {
    if (!sch.days.includes(weekdayOf(d))) continue;
    if ((batch!.start_date && d < String(batch!.start_date).slice(0, 10)) || (batch!.end_date && d > String(batch!.end_date).slice(0, 10))) continue;
    const starts = zonedToUtc(d, sch.start, tz); const ends = sch.end ? zonedToUtc(d, sch.end, tz) : null;
    try {
      await exec(`INSERT INTO class_sessions (id, org_id, batch_id, starts_at, ends_at, meeting_provider, meeting_url, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId(), orgId, room.batch.id, starts, ends && ends > starts ? ends : null, b.meeting_url ? providerFromUrl(b.meeting_url) : null, b.meeting_url ?? null, req.user!.id]);
      created++;
    } catch (e: any) { if (e?.errno === 1062) skipped++; else throw e; }
  }
  await audit({ orgId, actor: req.user, action: 'session.generated', entityType: 'batch', entityId: room.batch.id, next: { ...b, created, skipped }, req });
  ok(res, { created, skipped }, undefined, created ? 201 : 200);
}));

const NEXT: Record<string, string[]> = { scheduled: ['started', 'completed', 'cancelled'], started: ['completed', 'cancelled'], completed: [], cancelled: ['scheduled'] };
sessionsRouter.patch('/:batchId/sessions/:id', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room);
  const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  const b = parse(sessionBody.partial().extend({ status: z.enum(['scheduled', 'started', 'completed', 'cancelled']).optional(), cancel_reason: z.string().trim().max(255).nullish() }), req.body);
  const out = await tx(async (db) => {
    const cur = await queryOne(`SELECT * FROM class_sessions WHERE id = $1 AND batch_id = $2 FOR UPDATE`, [id, room.batch.id], db);
    if (!cur) throw notFound('Class');
    if (b.status && b.status !== cur.status && !NEXT[cur.status].includes(b.status)) throw conflict(`A ${cur.status} class cannot become ${b.status}.`, 'BAD_TRANSITION');
    if (cur.status === 'completed' && (b.starts_at || b.ends_at)) throw conflict('A completed class cannot be rescheduled.', 'BAD_TRANSITION');
    if ((b.starts_at || b.status === 'scheduled') && !room.writable) assertWritable(room);
    checkTimes(b.starts_at ?? cur.starts_at, b.ends_at === undefined ? cur.ends_at : b.ends_at);
    const sets: string[] = []; const vals: unknown[] = [];
    const set = (k: string, v: unknown) => { vals.push(v); sets.push(`${k} = $${vals.length + 1}`); };
    if (b.title !== undefined) set('title', b.title ?? null);
    if (b.starts_at) set('starts_at', new Date(b.starts_at));
    if (b.ends_at !== undefined) set('ends_at', b.ends_at ? new Date(b.ends_at) : null);
    if (b.meeting_url !== undefined) { set('meeting_url', b.meeting_url ?? null); set('meeting_provider', b.meeting_url ? (b.meeting_provider ?? providerFromUrl(b.meeting_url)) : null); }
    else if (b.meeting_provider !== undefined) set('meeting_provider', b.meeting_provider ?? null);
    if (b.status) { set('status', b.status); set('cancel_reason', b.status === 'cancelled' ? (b.cancel_reason ?? null) : null); }
    if (sets.length) await exec(`UPDATE class_sessions SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals], db).catch(dup);
    if (b.status === 'cancelled' && cur.status !== 'cancelled') {
      const ids = (await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [room.batch.id], db)).map((r) => r.learner_id as string);
      await notifyAbout(db, { orgId, learnerIds: ids, kind: 'class.cancelled', title: `Class cancelled: ${room.batch.name}`, body: `${cur.title ?? 'The class'} on ${String(cur.starts_at).slice(0, 16).replace('T', ' ')} UTC was cancelled${b.cancel_reason ? `: ${b.cancel_reason}` : ''}.`, link: `/classroom/${room.batch.id}`, excludeUserId: req.user!.id });
    }
    return { id, status: b.status ?? cur.status };
  });
  await audit({ orgId, actor: req.user, action: 'session.updated', entityType: 'class_session', entityId: id, next: b, req });
  ok(res, out);
}));

// ------------------------------------------------------------------ the attendance sheet
sessionsRouter.get('/:batchId/sessions/:id/attendance', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room);
  const s = await queryOne(`SELECT ${CLASS_SQL} FROM class_sessions s WHERE s.id = $1 AND s.batch_id = $2`, [parse(uuid, req.params.id), room.batch.id]);
  if (!s) throw notFound('Class');
  // The roster: today's active members, plus anyone who was already marked (so past marks never vanish if they left).
  const rows = await query(
    `SELECT l.id AS learner_id, l.full_name, l.learner_code, a.status, a.note, a.marked_at
       FROM learners l LEFT JOIN attendance a ON a.learner_id = l.id AND a.session_id = $2
      WHERE l.deleted_at IS NULL AND (a.id IS NOT NULL OR EXISTS (SELECT 1 FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.batch_id = $1 AND m.status = 'active'))
      ORDER BY l.full_name, l.id LIMIT 1000`, [room.batch.id, s.id]);
  ok(res, { session: shape({ ...s, batch_name: room.batch.name }, true), rows });
}));

const sheetBody = z.object({ entries: z.array(z.object({ learner_id: uuid, status: z.enum(STATUSES), note: z.string().trim().max(300).nullish() })).min(1).max(1000) });
sessionsRouter.put('/:batchId/sessions/:id/attendance', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room);
  const b = parse(sheetBody, req.body); const orgId = orgIdOf(req);
  const byLearner = new Map<string, (typeof b.entries)[number]>();
  for (const e of b.entries) byLearner.set(e.learner_id, e);           // one mark per learner, last wins
  const out = await tx(async (db) => {
    const s = await queryOne(`SELECT id, status, title, starts_at FROM class_sessions WHERE id = $1 AND batch_id = $2 FOR UPDATE`, [parse(uuid, req.params.id), room.batch.id], db);
    if (!s) throw notFound('Class');
    if (s.status === 'cancelled') throw conflict('This class was cancelled, so attendance cannot be marked.', 'SESSION_CANCELLED');
    const p = new Params();
    const members = new Set((await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = ${p.add(room.batch.id)} AND status = 'active' AND learner_id IN ${p.in([...byLearner.keys()])}`, p.values, db)).map((r) => r.learner_id as string));
    const outsiders = [...byLearner.keys()].filter((i) => !members.has(i));
    if (outsiders.length) throw badRequest(`${outsiders.length} learner(s) are not active members of this batch.`, outsiders.map((i) => ({ field: i, message: 'Not in this batch.' })));
    const existing = new Map((await query(`SELECT learner_id, status FROM attendance WHERE session_id = $1`, [s.id], db)).map((r) => [r.learner_id as string, r.status as string]));
    const res2 = { marked: 0, changed: 0, unchanged: 0 }; const absentNow: string[] = [];
    for (const e of byLearner.values()) {
      const prev = existing.get(e.learner_id);
      if (prev === e.status && e.note === undefined) { res2.unchanged++; continue; }
      await exec(`INSERT INTO attendance (id, org_id, session_id, batch_id, learner_id, status, note, marked_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                  ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), marked_by = VALUES(marked_by), marked_at = NOW(3)`,
        [newId(), orgId, s.id, room.batch.id, e.learner_id, e.status, e.note ?? null, req.user!.id], db);
      if (prev === undefined) res2.marked++; else res2.changed++;
      if (e.status === 'absent' && prev !== 'absent') absentNow.push(e.learner_id);
      await recordActivity(db, { orgId, learnerId: e.learner_id, batchId: room.batch.id, type: 'attendance.marked', title: `Marked ${e.status}: ${room.batch.name}`, meta: { session_id: s.id }, actorUserId: req.user!.id });
    }
    if (['scheduled', 'started'].includes(s.status)) await exec(`UPDATE class_sessions SET status = 'completed' WHERE id = $1`, [s.id], db);
    for (const lid of absentNow) {
      await notifyAbout(db, { orgId, learnerIds: [lid], kind: 'attendance.absent', title: `Marked absent: ${room.batch.name}`, body: `Absent from ${s.title ?? 'the class'} on ${String(s.starts_at).slice(0, 10)}.`, link: `/classroom/${room.batch.id}`, excludeUserId: req.user!.id });
    }
    return { ...res2, notified_absent: absentNow.length };
  });
  await audit({ orgId, actor: req.user, action: 'attendance.saved', entityType: 'class_session', entityId: req.params.id as string, next: out, req });
  ok(res, out);
}));

// ------------------------------------------------------------------ batch report (never mixes batches)
sessionsRouter.get('/:batchId/attendance/report', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional(), learner_id: uuid.optional() }), req.query);
  const p = new Params();
  const w = [`a.batch_id = ${p.add(room.batch.id)}`, `s.status <> 'cancelled'`];
  if (q.from) w.push(`s.starts_at >= ${p.add(`${q.from} 00:00:00`)}`);
  if (q.to) w.push(`s.starts_at < ${p.add(`${addDays(q.to, 1)} 00:00:00`)}`);
  if (!room.canManage) { const me = viewedLearner(room, q.learner_id); w.push(me ? `a.learner_id = ${p.add(me)}` : 'FALSE'); }
  else if (q.learner_id) w.push(`a.learner_id = ${p.add(q.learner_id)}`);
  const per = await query(
    `SELECT l.id AS learner_id, l.full_name, l.learner_code, SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent, SUM(a.status = 'excused') AS excused
       FROM attendance a JOIN class_sessions s ON s.id = a.session_id JOIN learners l ON l.id = a.learner_id WHERE ${w.join(' AND ')} GROUP BY l.id, l.full_name, l.learner_code ORDER BY l.full_name, l.id LIMIT 1000`, p.values);
  const learners = per.map((r) => { const c = { present: Number(r.present), late: Number(r.late), absent: Number(r.absent), excused: Number(r.excused) }; const pct = attendancePct(c);
    return { learner_id: r.learner_id, full_name: r.full_name, ...(room.canManage ? { learner_code: r.learner_code } : {}), ...c, pct, low: pct !== null && pct < 75 }; });
  const p2 = new Params();
  const w2 = [`s.batch_id = ${p2.add(room.batch.id)}`, `s.status <> 'cancelled'`];
  if (q.from) w2.push(`s.starts_at >= ${p2.add(`${q.from} 00:00:00`)}`); if (q.to) w2.push(`s.starts_at < ${p2.add(`${addDays(q.to, 1)} 00:00:00`)}`);
  const sessions = room.canManage ? (await query(
    `SELECT s.id, s.title, s.starts_at, s.status, SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent, SUM(a.status = 'excused') AS excused
       FROM class_sessions s LEFT JOIN attendance a ON a.session_id = s.id WHERE ${w2.join(' AND ')} GROUP BY s.id, s.title, s.starts_at, s.status ORDER BY s.starts_at DESC LIMIT 400`, p2.values))
    .map((r) => { const c = { present: Number(r.present ?? 0), late: Number(r.late ?? 0), absent: Number(r.absent ?? 0), excused: Number(r.excused ?? 0) }; return { id: r.id, title: r.title, starts_at: r.starts_at, status: r.status, ...c, pct: attendancePct(c) }; }) : undefined;
  const tot = learners.reduce((a, l) => ({ present: a.present + l.present, late: a.late + l.late, absent: a.absent + l.absent }), { present: 0, late: 0, absent: 0 });
  ok(res, { learners, sessions, batch_pct: attendancePct(tot), low_count: learners.filter((l) => l.low).length, threshold: 75, can_manage: room.canManage });
}));

// ------------------------------------------------------------------ one learner across batches (per-batch, then combined)
async function visibleLearnerId(req: any, requested?: string) {
  const user = req.user!; const orgId = orgIdOf(req);
  const id = requested ?? user.access.ownLearnerIds[0];
  if (!id) throw badRequest('Choose a learner.', [{ field: 'learner_id', message: 'This is required.' }]);
  const p = new Params(); const sc = learnerScope(user, p, 'l');
  if (!(await queryOne(`SELECT 1 FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgId)} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values))) throw notFound('Learner');
  return id as string;
}
/** Batches of a learner the caller may see (staff only see batches in their own scope). */
export function batchVisibility(req: any, p: Params, learnerId: string, b = 'b') {
  const user = req.user!;
  if (user.access.orgWide || user.access.ownLearnerIds.includes(learnerId)) return '';
  const parts: string[] = [];
  if (user.access.branchIds.length) parts.push(`${b}.branch_id IN ${p.in(user.access.branchIds)}`);
  if (user.access.teacher) parts.push(`EXISTS (SELECT 1 FROM teacher_batch_memberships st WHERE st.batch_id = ${b}.id AND st.teacher_user_id = ${p.add(user.id)} AND st.status = 'active')`);
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}

attendanceRouter.get('/summary', wrap(async (req, res) => {
  const q = parse(z.object({ learner_id: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() }), req.query);
  const lid = await visibleLearnerId(req, q.learner_id);
  const p = new Params();
  const w = [`a.learner_id = ${p.add(lid)}`, `s.status <> 'cancelled'`, 'b.deleted_at IS NULL'];
  const vis = batchVisibility(req, p, lid); if (vis) w.push(vis);
  if (q.from) w.push(`s.starts_at >= ${p.add(`${q.from} 00:00:00`)}`); if (q.to) w.push(`s.starts_at < ${p.add(`${addDays(q.to, 1)} 00:00:00`)}`);
  const rows = await query(
    `SELECT a.batch_id, b.name AS batch_name, DATE_FORMAT(s.starts_at, '%Y-%m') AS month, SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent, SUM(a.status = 'excused') AS excused
       FROM attendance a JOIN class_sessions s ON s.id = a.session_id JOIN batches b ON b.id = a.batch_id WHERE ${w.join(' AND ')}
      GROUP BY a.batch_id, b.name, DATE_FORMAT(s.starts_at, '%Y-%m') ORDER BY month`, p.values);
  const add = (a: any, r: any) => ({ present: a.present + Number(r.present), late: a.late + Number(r.late), absent: a.absent + Number(r.absent), excused: a.excused + Number(r.excused) });
  const zero = () => ({ present: 0, late: 0, absent: 0, excused: 0 });
  const per = new Map<string, any>(); let all = zero();
  for (const r of rows) { const cur = per.get(r.batch_id) ?? { batch_id: r.batch_id, batch_name: r.batch_name, ...zero() }; per.set(r.batch_id, { ...cur, ...add(cur, r) }); all = add(all, r); }
  ok(res, {
    learner_id: lid,
    batches: [...per.values()].map((b) => ({ ...b, pct: attendancePct(b) })),
    overall: { ...all, pct: attendancePct(all), note: 'Combined across the batches listed; each batch is also reported on its own.' },
    monthly: rows.map((r) => { const c = { present: Number(r.present), late: Number(r.late), absent: Number(r.absent), excused: Number(r.excused) }; return { month: r.month, batch_id: r.batch_id, batch_name: r.batch_name, ...c, pct: attendancePct(c) }; }),
  });
}));

/** Upcoming and recent classes across a learner's batches, with a Join button when it is time. */
attendanceRouter.get('/classes', wrap(async (req, res) => {
  const q = parse(z.object({ learner_id: uuid.optional(), days: z.coerce.number().int().min(1).max(60).default(14) }), req.query);
  const lid = await visibleLearnerId(req, q.learner_id);
  const p = new Params();
  const w = [`m.learner_id = ${p.add(lid)}`, `m.status = 'active'`, 'b.deleted_at IS NULL', `s.starts_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)`, `s.starts_at < DATE_ADD(NOW(3), INTERVAL ${q.days} DAY)`];
  const vis = batchVisibility(req, p, lid); if (vis) w.push(vis);
  const rows = await query(`SELECT ${CLASS_SQL}, b.name AS batch_name, a.status AS my_status FROM class_sessions s JOIN batches b ON b.id = s.batch_id JOIN learner_batch_memberships m ON m.batch_id = s.batch_id
      LEFT JOIN attendance a ON a.session_id = s.id AND a.learner_id = m.learner_id WHERE ${w.join(' AND ')} ORDER BY s.starts_at LIMIT 200`, p.values);
  ok(res, rows.map((r) => shape(r, false, { status: r.my_status })));
}));
