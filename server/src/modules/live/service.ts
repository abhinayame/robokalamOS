import { createHash } from 'node:crypto';
import { exec, newId, query, queryOne, tx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { notifyAbout } from '../../lib/notify.js';
import { recordActivity } from '../../lib/timeline.js';

/** Rules for turning a join log into attendance. */
export const LATE_AFTER_MIN = 10;          // first join more than this long after the start = late
export const MIN_PRESENT_MIN = 10;         // never less than this many minutes ...
export const PRESENT_SHARE = 0.5;          // ... and at least this share of the class to count as present

export const normName = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export interface SessionRow { id: string; org_id: string; batch_id: string; title: string | null; starts_at: string; ends_at: string | null; status: string; created_by: string; live_started_at: string | null; live_ended_at: string | null; zoom_meeting_id: string | null; batch_name?: string }

export async function sessionByMeeting(meetingId: string, db?: Db) {
  return queryOne(`SELECT s.id, s.org_id, s.batch_id, s.title, s.starts_at, s.ends_at, s.status, s.created_by, s.live_started_at, s.live_ended_at, s.zoom_meeting_id, b.name AS batch_name FROM class_sessions s JOIN batches b ON b.id = s.batch_id WHERE s.zoom_meeting_id = $1`, [meetingId], db) as Promise<SessionRow | null>;
}

/** Which learner of this batch does a Zoom participant most likely be? Alias a teacher confirmed, then email, then exact name; never a guess between two people. */
export async function matchLearner(db: Db, orgId: string, batchId: string, name: string, email: string | null): Promise<{ learnerId: string; method: 'alias' | 'email' | 'name' } | null> {
  const members = await query(`SELECT l.id, l.full_name, l.email FROM learners l JOIN learner_batch_memberships m ON m.learner_id = l.id AND m.batch_id = $1 AND m.status = 'active' WHERE l.org_id = $2 AND l.deleted_at IS NULL`, [batchId, orgId], db);
  const ids = new Set(members.map((m) => m.id as string));
  const n = normName(name);
  if (n) {
    const a = await queryOne(`SELECT learner_id FROM live_aliases WHERE org_id = $1 AND alias = $2`, [orgId, n], db);
    if (a && ids.has(a.learner_id)) return { learnerId: a.learner_id, method: 'alias' };
  }
  const e = email?.trim().toLowerCase();
  if (e) { const hit = members.filter((m) => m.email && String(m.email).toLowerCase() === e); if (hit.length === 1) return { learnerId: hit[0]!.id, method: 'email' }; }
  if (n) { const hit = members.filter((m) => normName(m.full_name) === n); if (hit.length === 1) return { learnerId: hit[0]!.id, method: 'name' }; }
  return null;
}

const mins = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
const toDate = (v: unknown) => new Date(String(v));

export interface Finalized { learners: number; present: number; late: number; absent: number; skipped_manual: number; unmatched_participants: number; changed: number }

/**
 * Turn the join log of one class into attendance. Safe to run again (after a teacher matches a name, or when Zoom's "ended" event is
 * late): rows marked by auto are recalculated, rows a teacher marked by hand are never touched.
 */
export async function finalizeAttendance(sessionId: string, now = new Date()): Promise<Finalized & { held: boolean }> {
  return tx(async (db) => {
    const s = await queryOne(`SELECT id, org_id, batch_id, title, starts_at, ends_at, status, created_by, live_started_at, live_ended_at FROM class_sessions WHERE id = $1 FOR UPDATE`, [sessionId], db) as SessionRow | null;
    const out: Finalized & { held: boolean } = { learners: 0, present: 0, late: 0, absent: 0, skipped_manual: 0, unmatched_participants: 0, changed: 0, held: false };
    if (!s || s.status === 'cancelled') return out;
    const parts = await query(`SELECT id, name, email, joined_at, left_at, learner_id FROM live_participants WHERE session_id = $1 ORDER BY joined_at, id`, [sessionId], db);
    if (!parts.length) return out;                              // nobody came, or no join data: marks stay entirely with the teacher
    out.held = true;
    // names that could not be matched yet may match now (a roster change, a new alias)
    for (const p of parts.filter((x) => !x.learner_id)) {
      const m = await matchLearner(db, s.org_id, s.batch_id, p.name, p.email);
      if (m) { await exec(`UPDATE live_participants SET learner_id = $2, match_method = $3 WHERE id = $1`, [p.id, m.learnerId, m.method], db); p.learner_id = m.learnerId; }
    }
    out.unmatched_participants = new Set(parts.filter((x) => !x.learner_id).map((x) => normName(x.name))).size;

    const start = toDate(s.starts_at);
    const end = s.live_ended_at ? toDate(s.live_ended_at) : now;
    const scheduled = s.ends_at ? mins(start, toDate(s.ends_at)) : s.live_started_at && s.live_ended_at ? mins(toDate(s.live_started_at), toDate(s.live_ended_at)) : 60;
    const needed = Math.max(MIN_PRESENT_MIN, Math.round(scheduled * PRESENT_SHARE));
    const per = new Map<string, { minutes: number; first: Date }>();
    for (const p of parts.filter((x) => x.learner_id)) {
      const j = toDate(p.joined_at); const l = p.left_at ? toDate(p.left_at) : end;
      const cur = per.get(p.learner_id) ?? { minutes: 0, first: j };
      cur.minutes += mins(j, l < j ? j : l); if (j < cur.first) cur.first = j; per.set(p.learner_id, cur);
    }
    const roster = await query(`SELECT l.id FROM learners l JOIN learner_batch_memberships m ON m.learner_id = l.id AND m.batch_id = $1 AND m.status = 'active' WHERE l.org_id = $2 AND l.deleted_at IS NULL`, [s.batch_id, s.org_id], db);
    const existing = new Map((await query(`SELECT learner_id, status, source FROM attendance WHERE session_id = $1`, [sessionId], db)).map((r) => [r.learner_id as string, r]));
    const newlyAbsent: string[] = [];
    for (const r of roster) {
      const prev = existing.get(r.id);
      if (prev?.source === 'manual') { out.skipped_manual++; continue; }
      const got = per.get(r.id);
      let status: 'present' | 'late' | 'absent'; let note: string; const minutes = got?.minutes ?? 0;
      if (!got) { status = 'absent'; note = 'Zoom: did not join'; }
      else if (got.minutes < needed) { status = 'absent'; note = `Zoom: joined for only ${got.minutes} min (needs ${needed})`; }
      else if (mins(start, got.first) > LATE_AFTER_MIN && got.first > start) { status = 'late'; note = `Zoom: joined ${mins(start, got.first)} min after the start, stayed ${got.minutes} min`; }
      else { status = 'present'; note = `Zoom: stayed ${got.minutes} min`; }
      out.learners++; out[status]++;
      if (prev && prev.status === status) { await exec(`UPDATE attendance SET note = $3, joined_minutes = $4 WHERE session_id = $1 AND learner_id = $2`, [sessionId, r.id, note, minutes], db); continue; }
      await exec(`INSERT INTO attendance (id, org_id, session_id, batch_id, learner_id, status, note, marked_by, source, joined_minutes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'auto',$9)
                  ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), marked_by = VALUES(marked_by), marked_at = NOW(3), source = 'auto', joined_minutes = VALUES(joined_minutes)`,
        [newId(), s.org_id, sessionId, s.batch_id, r.id, status, note, s.created_by, minutes], db);
      out.changed++;
      if (status === 'absent' && prev?.status !== 'absent') newlyAbsent.push(r.id);
      await recordActivity(db, { orgId: s.org_id, learnerId: r.id, batchId: s.batch_id, type: 'attendance.marked', title: `Marked ${status} from Zoom`, meta: { session_id: sessionId, minutes }, actorUserId: null });
    }
    if (newlyAbsent.length) await notifyAbout(db, { orgId: s.org_id, learnerIds: newlyAbsent, kind: 'attendance.absent', title: 'Marked absent', body: `Absent from ${s.title ?? 'the class'} on ${String(s.starts_at).slice(0, 10)}.`, link: '/portal' });
    await exec(`UPDATE class_sessions SET attendance_finalized_at = NOW(3), status = IF(status IN ('scheduled','started'), 'completed', status) WHERE id = $1`, [sessionId], db);
    await audit({ orgId: s.org_id, actor: null, action: 'attendance.auto_marked', entityType: 'class_session', entityId: sessionId, next: out }, db);
    return out;
  });
}

// ------------------------------------------------------------------ webhook events
export type Outcome = 'applied' | 'ignored' | 'unmatched' | 'duplicate';
const when = (v: unknown, fallback = new Date()) => { const d = v ? new Date(String(v)) : fallback; return Number.isNaN(d.getTime()) ? fallback : d; };

export async function onMeetingStarted(db: Db, s: SessionRow, startTime: unknown) {
  await exec(`UPDATE class_sessions SET live_started_at = COALESCE(live_started_at, $2), status = IF(status = 'scheduled', 'started', status) WHERE id = $1`, [s.id, when(startTime)], db);
  return 'applied' as Outcome;
}

/** A join is identified by who joined which meeting when, not by the envelope around it, so a re-sent or re-wrapped event cannot add time twice. */
const identity = (...parts: string[]) => createHash('sha256').update(parts.join('|')).digest('hex');

export async function onParticipantJoined(db: Db, s: SessionRow, p: any): Promise<Outcome> {
  const name = String(p?.user_name ?? p?.name ?? '').trim().slice(0, 200) || 'Unknown participant';
  const zid = String(p?.participant_uuid ?? p?.id ?? p?.user_id ?? name).slice(0, 100);
  const joined = when(p?.join_time ?? p?.date_time);
  const email = p?.email ? String(p.email).slice(0, 200) : null;
  const m = await matchLearner(db, s.org_id, s.batch_id, name, email);
  try {
    await exec(`INSERT INTO live_participants (org_id, session_id, zoom_participant_id, name, email, joined_at, learner_id, match_method, event_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.org_id, s.id, zid, name, email, joined, m?.learnerId ?? null, m?.method ?? null, identity('join', s.id, zid, joined.toISOString())], db);
  } catch (e: any) { if (e?.errno === 1062) return 'duplicate'; throw e; }
  await exec(`UPDATE class_sessions SET live_started_at = COALESCE(live_started_at, $2), status = IF(status = 'scheduled', 'started', status) WHERE id = $1`, [s.id, joined], db);
  return 'applied';
}

export async function onParticipantLeft(db: Db, s: SessionRow, p: any): Promise<Outcome> {
  const name = String(p?.user_name ?? p?.name ?? '').trim().slice(0, 200) || 'Unknown participant';
  const zid = String(p?.participant_uuid ?? p?.id ?? p?.user_id ?? name).slice(0, 100);
  const left = when(p?.leave_time ?? p?.date_time);
  const r = await exec(`UPDATE live_participants SET left_at = $3 WHERE id = (SELECT id FROM (SELECT id FROM live_participants WHERE session_id = $1 AND zoom_participant_id = $2 AND left_at IS NULL ORDER BY joined_at DESC, id DESC LIMIT 1) x)`, [s.id, zid, left], db);
  return r.affectedRows ? 'applied' : 'ignored';
}

export async function onMeetingEnded(db: Db, s: SessionRow, endTime: unknown) {
  const end = when(endTime);
  await exec(`UPDATE class_sessions SET live_ended_at = COALESCE(live_ended_at, $2) WHERE id = $1`, [s.id, end], db);
  await exec(`UPDATE live_participants SET left_at = $2 WHERE session_id = $1 AND left_at IS NULL`, [s.id, end], db);
  return 'applied' as Outcome;
}

export async function onRecording(db: Db, s: SessionRow, o: any): Promise<Outcome> {
  const url = String(o?.share_url ?? '').trim();
  if (!/^https:\/\//i.test(url)) return 'ignored';                          // only ever store a real https link
  try {
    await exec(`INSERT INTO class_recordings (id, org_id, session_id, share_url, passcode, duration_min, size_mb, recorded_at, event_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId(), s.org_id, s.id, url.slice(0, 1000), o?.password ? String(o.password).slice(0, 100) : null, Number.isFinite(Number(o?.duration)) ? Number(o.duration) : null, Number.isFinite(Number(o?.total_size)) ? Math.round((Number(o.total_size) / 1048576) * 10) / 10 : null, o?.start_time ? when(o.start_time) : null, identity('recording', s.id, url)], db);
  } catch (e: any) { if (e?.errno === 1062) return 'duplicate'; throw e; }
  const ids = (await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [s.batch_id], db)).map((r) => r.learner_id as string);
  await notifyAbout(db, { orgId: s.org_id, learnerIds: ids, kind: 'recording', title: `Recording available: ${s.title ?? s.batch_name ?? 'class'}`, body: 'Watch it again from My Classes.', link: '/classes' });
  return 'applied';
}

/** Zoom's "ended" event can be lost. Classes that started long ago and never ended get closed and marked from what we have. */
export async function sweepLiveSessions() {
  const stale = await query(`SELECT id FROM class_sessions WHERE live_started_at IS NOT NULL AND live_ended_at IS NULL AND live_started_at < DATE_SUB(NOW(3), INTERVAL 6 HOUR) LIMIT 50`);
  let closed = 0;
  for (const s of stale) {
    await tx(async (db) => { await exec(`UPDATE class_sessions SET live_ended_at = DATE_ADD(live_started_at, INTERVAL 3 HOUR) WHERE id = $1 AND live_ended_at IS NULL`, [s.id], db); await exec(`UPDATE live_participants SET left_at = DATE_ADD((SELECT live_started_at FROM class_sessions WHERE id = $1), INTERVAL 3 HOUR) WHERE session_id = $1 AND left_at IS NULL`, [s.id], db); });
    await finalizeAttendance(s.id); closed++;
  }
  return closed;
}
