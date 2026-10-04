import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { setZoomProvider, validationAnswer, type MeetingInput, type MeetingResult, type ZoomProvider } from '../src/modules/live/zoom.js';
import { normName, sweepLiveSessions } from '../src/modules/live/service.js';

const SECRET = 'zoom-webhook-token-test';
class FakeZoom implements ZoomProvider {
  made: MeetingInput[] = []; deleted: string[] = []; n = 0; fail = false;
  async createMeeting(i: MeetingInput): Promise<MeetingResult> { this.made.push(i); if (this.fail) return { ok: false, retriable: true, code: 'HTTP_500', message: 'boom' }; const id = String(88000000000 + ++this.n + Math.floor(Math.random() * 1e6)); return { ok: true, id, joinUrl: `https://zoom.us/j/${id}?pwd=abc` }; }
  async deleteMeeting(id: string) { this.deleted.push(id); }
  async startUrl(id: string) { return { ok: true as const, url: `https://zoom.us/s/${id}?zak=fresh` }; }
}
const fake = new FakeZoom();
const hook = (body: object, o: { secret?: string; ts?: number; sig?: string } = {}) => {
  const raw = JSON.stringify(body); const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const sig = o.sig ?? `v0=${crypto.createHmac('sha256', o.secret ?? SECRET).update(`v0:${ts}:${raw}`).digest('hex')}`;
  return request(app).post('/api/webhooks/zoom').set('Content-Type', 'application/json').set('x-zm-signature', sig).set('x-zm-request-timestamp', ts).send(raw);
};
const ev = (event: string, meetingId: string, extra: object = {}) => ({ event, event_ts: Date.now(), payload: { account_id: 'a', object: { id: meetingId, uuid: `u-${meetingId}`, ...extra } } });
const iso = (d: Date) => d.toISOString();
const MIN = 60_000;

let w: World, other: World;
let ravi: any, meena: any, kabir: any, diya: any, sam1: any, sam2: any, outsider: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, rv: ReturnType<typeof client>, parentTok: ReturnType<typeof client>, outsiderC: ReturnType<typeof client>;
const sessions: { id: string; meeting: string; start: Date }[] = [];

async function newClass(minutesAgo: number, title: string, durationMin = 60) {
  const start = new Date(Date.now() - minutesAgo * MIN);
  const r = await t1.post(`/api/classrooms/${w.batches.roboA}/sessions`, { title, starts_at: iso(start), ends_at: iso(new Date(start.getTime() + durationMin * MIN)) });
  expect(r.status).toBe(201); return { id: r.body.data.id as string, start };
}
const join = (m: string, name: string, at: Date, extra: object = {}, pid = `p-${name}`) => hook(ev('meeting.participant_joined', m, { participant: { user_name: name, participant_uuid: pid, join_time: iso(at), ...extra } }));
const leave = (m: string, name: string, at: Date, pid = `p-${name}`) => hook(ev('meeting.participant_left', m, { participant: { user_name: name, participant_uuid: pid, leave_time: iso(at) } }));
const marks = async (sid: string) => Object.fromEntries((await query(`SELECT l.full_name, a.status, a.source, a.note, a.joined_minutes FROM attendance a JOIN learners l ON l.id = a.learner_id WHERE a.session_id = $1`, [sid])).map((r) => [r.full_name, r]));

beforeAll(async () => {
  setZoomProvider(fake);
  w = await buildWorld(); other = await buildWorld();
  const mk = (n: string, extra: object = {}) => newLearner(w, { full_name: n, batch_ids: [w.batches.roboA], ...extra });
  ravi = await mk('Ravi Kumar', { email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Ravi Parent', mobile: '9850000001', email: `rp-${uniq()}@fam.test` } });
  meena = await mk('Meena Iyer'); kabir = await mk('Kabir Das'); diya = await mk('Diya Nair', { email: `diya-${uniq()}@kids.test` }); sam1 = await mk('Sam Lee'); sam2 = await mk('Sam Lee');
  outsider = await newLearner(w, { full_name: 'Outsider Kid', email: `out-${uniq()}@kids.test`, batch_ids: [w.batches.pyB] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD }); await w.admin.post(`/api/learners/${outsider.id}/login`, { password: PASSWORD }); await w.admin.post(`/api/learners/${diya.id}/login`, { password: PASSWORD });
  t1 = client(await login(w.teachers.t1.email)); t2 = client(await login(w.teachers.t2.email)); rv = client(await login(ravi.email)); outsiderC = client(await login(outsider.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  parentTok = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
});

describe('the webhook is only trusted when signed', () => {
  it('answers Zoom\'s one-time URL challenge, and refuses unsigned, wrongly signed and replayed events', async () => {
    const ch = await request(app).post('/api/webhooks/zoom').send({ event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } });
    expect(ch.status).toBe(200); expect(ch.body).toEqual(validationAnswer('abc123'));
    expect(ch.body.encryptedToken).toBe(crypto.createHmac('sha256', SECRET).update('abc123').digest('hex'));
    const body = ev('meeting.started', '123');
    expect((await request(app).post('/api/webhooks/zoom').send(body)).status).toBe(404);
    expect((await hook(body, { secret: 'wrong-secret-wrong' })).status).toBe(404);
    expect((await hook(body, { sig: 'v0=deadbeef' })).status).toBe(404);
    expect((await hook(body, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(404);          // an hour-old signature cannot be replayed
    expect((await hook(body)).body.data.outcome).toBe('unmatched');                                      // valid signature, meeting we do not know
  });
});

describe('creating meetings', () => {
  it('lets a batch teacher create one meeting per class, and nobody else', async () => {
    const c = await newClass(40, 'Line follower');
    expect((await rv.post(`/api/live/sessions/${c.id}/meeting`)).status).toBe(403);          // a learner cannot
    expect((await t2.post(`/api/live/sessions/${c.id}/meeting`)).status).toBe(404);          // a teacher of another batch cannot even see it
    expect((await other.admin.post(`/api/live/sessions/${c.id}/meeting`)).status).toBe(404);
    fake.fail = true; const bad = await t1.post(`/api/live/sessions/${c.id}/meeting`); fake.fail = false;
    expect(bad.status).toBe(502); expect(bad.body.error.code).toBe('ZOOM_ERROR');
    expect((await queryOne(`SELECT zoom_meeting_id FROM class_sessions WHERE id = $1`, [c.id]))!.zoom_meeting_id).toBeNull();
    const ok = await t1.post(`/api/live/sessions/${c.id}/meeting`);
    expect(ok.status).toBe(201); expect(ok.body.data.meeting_url).toMatch(/^https:\/\/zoom\.us\/j\//);
    const row = await queryOne(`SELECT zoom_meeting_id, meeting_provider, meeting_url FROM class_sessions WHERE id = $1`, [c.id]);
    expect(row!.meeting_provider).toBe('zoom'); expect(fake.made.at(-1)!.durationMin).toBe(60); expect(fake.made.at(-1)!.topic).toContain('Robotics Batch A');
    expect((await t1.post(`/api/live/sessions/${c.id}/meeting`)).status).toBe(409);          // once
    sessions.push({ id: c.id, meeting: row!.zoom_meeting_id, start: c.start });
    const st = await t1.post(`/api/live/sessions/${c.id}/start-link`); expect(st.body.data.start_url).toContain('zak=fresh');
    expect((await rv.post(`/api/live/sessions/${c.id}/start-link`)).status).toBe(403);
    expect(JSON.stringify((await t1.get('/api/live/status')).body)).not.toContain('zoom-secret-test-0001');
    const cls = (await t1.get(`/api/classrooms/${w.batches.roboA}/sessions`)).body.data.find((s: any) => s.id === c.id);
    expect(cls).toMatchObject({ has_zoom: true, live: null, recordings: 0 });
  });
  it('can remove a meeting that has not started, and not one that has', async () => {
    const c = await newClass(-120, 'Future class'); await t1.post(`/api/live/sessions/${c.id}/meeting`);
    const m = (await queryOne(`SELECT zoom_meeting_id FROM class_sessions WHERE id = $1`, [c.id]))!.zoom_meeting_id;
    expect((await t1.del(`/api/live/sessions/${c.id}/meeting`)).status).toBe(200); expect(fake.deleted).toContain(m);
    expect((await queryOne(`SELECT meeting_url FROM class_sessions WHERE id = $1`, [c.id]))!.meeting_url).toBeNull();
    const done = await newClass(500, 'Over class', 30);
    expect((await t1.post(`/api/live/sessions/${done.id}/meeting`)).status).toBe(400);       // already over
  });
});

describe('who joined becomes attendance', () => {
  it('records joins and leaves, matches people to learners, and marks present / late / absent by how long they stayed', async () => {
    const s = sessions[0]!; const m = s.meeting; const t = (min: number) => new Date(s.start.getTime() + min * MIN);
    expect((await hook(ev('meeting.started', m, { start_time: iso(t(0)) }))).body.data.outcome).toBe('applied');
    expect((await join(m, 'Ravi K', t(2), { email: ravi.email.toUpperCase() })).body.data.outcome).toBe('applied');   // matched by e-mail, case-insensitive
    const dupe = ev('meeting.participant_joined', m, { participant: { user_name: 'Ravi K', participant_uuid: 'p-Ravi K', join_time: iso(t(2)), email: ravi.email } });
    expect((await hook(dupe)).body.data.outcome).toBe('duplicate');                                                    // same join, re-wrapped: must not add time twice
    expect((await hook(dupe)).body.data.outcome).toBe('duplicate');
    await join(m, 'meena iyer (Mom)', t(25));                                                                         // matched by name, brackets ignored; joins late
    await join(m, 'Kabir Das', t(5)); await leave(m, 'Kabir Das', t(9));                                              // only 4 minutes
    await join(m, 'Guest iPad', t(10), {}, 'p-ipad'); await join(m, 'Sam Lee', t(3));                                // unknown device; two learners called Sam Lee
    expect((await queryOne(`SELECT status FROM class_sessions WHERE id = $1`, [s.id]))!.status).toBe('started');
    // the teacher marks Kabir by hand while the class is still running: that must never be overwritten
    expect((await t1.put(`/api/classrooms/${w.batches.roboA}/sessions/${s.id}/attendance`, { entries: [{ learner_id: kabir.id, status: 'excused', note: 'Told us in advance' }] })).status).toBe(200);
    await leave(m, 'Ravi K', t(58));
    expect((await hook(ev('meeting.ended', m, { end_time: iso(t(60)) }))).body.data.outcome).toBe('applied');
    const mk = await marks(s.id);
    expect(mk['Ravi Kumar']).toMatchObject({ status: 'present', source: 'auto', joined_minutes: 56 });
    expect(mk['Meena Iyer']).toMatchObject({ status: 'late', source: 'auto' }); expect(mk['Meena Iyer'].note).toContain('25 min after the start');
    expect(mk['Kabir Das']).toMatchObject({ status: 'excused', source: 'manual' });                                    // teacher's mark stands
    expect(mk['Diya Nair']).toMatchObject({ status: 'absent', source: 'auto' }); expect(mk['Diya Nair'].note).toContain('did not join');
    const sams = await query(`SELECT a.status FROM attendance a JOIN learners l ON l.id = a.learner_id WHERE a.session_id = $1 AND l.full_name = 'Sam Lee'`, [s.id]);
    expect(sams.map((x) => x.status)).toEqual(['absent', 'absent']);                                                   // an ambiguous name is never guessed
    const cls = await queryOne(`SELECT status, live_started_at, live_ended_at, attendance_finalized_at FROM class_sessions WHERE id = $1`, [s.id]);
    expect(cls!.status).toBe('completed'); expect(cls!.attendance_finalized_at).not.toBeNull();
    // a learner with a login is told about the absence; the present one is not
    const n = await query(`SELECT user_id FROM notifications WHERE org_id = $1 AND kind = 'attendance.absent'`, [w.orgId]);
    expect(n.length).toBe(1);
  });
  it('shows the teacher who could not be matched, lets them fix it once, remembers it, and recalculates', async () => {
    const s = sessions[0]!;
    expect((await rv.get(`/api/live/sessions/${s.id}/participants`)).status).toBe(403);
    const p = (await t1.get(`/api/live/sessions/${s.id}/participants`)).body.data;
    expect(p.unmatched.map((x: any) => x.name).sort()).toEqual(['Guest iPad', 'Sam Lee']);
    expect(p.not_joined.map((l: any) => l.full_name)).toContain('Diya Nair');
    expect((await t1.post(`/api/live/sessions/${s.id}/match`, { name: 'Guest iPad', learner_id: outsider.id })).status).toBe(400);      // not in this batch
    const fix = await t1.post(`/api/live/sessions/${s.id}/match`, { name: 'Guest iPad', learner_id: diya.id });
    expect(fix.status).toBe(200); expect(fix.body.data.attendance.present).toBeGreaterThanOrEqual(2);
    expect((await marks(s.id))['Diya Nair']).toMatchObject({ status: 'present', source: 'auto' });
    expect((await queryOne(`SELECT learner_id FROM live_aliases WHERE org_id = $1 AND alias = 'guest ipad'`, [w.orgId]))!.learner_id).toBe(diya.id);
    expect((await t1.post(`/api/live/sessions/${s.id}/match`, { name: 'Nobody Here', learner_id: diya.id })).status).toBe(404);
    expect((await t2.post(`/api/live/sessions/${s.id}/match`, { name: 'Guest iPad', learner_id: diya.id })).status).toBe(404);
  });
  it('uses a remembered name automatically in the next class, and survives repeated or late events', async () => {
    const c = await newClass(35, 'Next class'); await t1.post(`/api/live/sessions/${c.id}/meeting`);
    const m = (await queryOne(`SELECT zoom_meeting_id FROM class_sessions WHERE id = $1`, [c.id]))!.zoom_meeting_id; const t = (min: number) => new Date(c.start.getTime() + min * MIN);
    await hook(ev('meeting.started', m, { start_time: iso(t(0)) }));
    await join(m, 'GUEST   iPad!', t(1), {}, 'p-ipad-2');                                       // different capitalisation and punctuation, same alias
    await join(m, 'Ravi Kumar', t(1)); await leave(m, 'Ravi Kumar', t(20)); await join(m, 'Ravi Kumar', t(25), {}, 'p-Ravi Kumar');   // left and came back
    await hook(ev('meeting.ended', m, { end_time: iso(t(60)) }));
    const mk = await marks(c.id);
    expect(mk['Diya Nair']).toMatchObject({ status: 'present', source: 'auto' });
    expect(mk['Ravi Kumar'].joined_minutes).toBe(19 + 35); expect(mk['Ravi Kumar'].status).toBe('present');               // minutes add up across rejoins
    const again = await t1.post(`/api/live/sessions/${c.id}/finalize`); expect(again.status).toBe(200); expect(again.body.data.changed).toBe(0);   // recalculating changes nothing
    const a = (await query(`SELECT COUNT(*) AS n FROM attendance WHERE session_id = $1`, [c.id]))[0].n; expect(a).toBe(6);
    expect(normName('  Mé nā (Mom) ')).toBe('me na');
  });
  it('turns a class whose end event never arrived into attendance after a while, and tells staff when one was missed', async () => {
    const c = await newClass(400, 'Lost end event', 60); await t1.post(`/api/live/sessions/${c.id}/meeting`);
    const m = (await queryOne(`SELECT zoom_meeting_id FROM class_sessions WHERE id = $1`, [c.id]))!.zoom_meeting_id;
    // the class is long over, so the meeting cannot be created now; give it a meeting id directly like a class that really ran
    await exec(`UPDATE class_sessions SET zoom_meeting_id = $2 WHERE id = $1`, [c.id, '777000111']);
    void m;
    const start = c.start; await hook(ev('meeting.started', '777000111', { start_time: iso(start) })); await join('777000111', 'Meena Iyer', new Date(start.getTime() + MIN)); await leave('777000111', 'Meena Iyer', new Date(start.getTime() + 55 * MIN));
    expect((await marks(c.id))['Meena Iyer']).toBeUndefined();                                           // nothing until the class is closed
    await exec(`UPDATE class_sessions SET live_started_at = DATE_SUB(NOW(3), INTERVAL 7 HOUR) WHERE id = $1`, [c.id]);
    expect(await sweepLiveSessions()).toBeGreaterThanOrEqual(1);
    expect((await marks(c.id))['Meena Iyer']).toMatchObject({ status: 'present', source: 'auto' });
  });
});

describe('recordings', () => {
  it('stores only https links, tells the class, and shows them to members and parents but nobody else', async () => {
    const s = sessions[0]!;
    const rec = (url: string, extra: object = {}) => hook(ev('recording.completed', s.meeting, { share_url: url, password: 'pw123', duration: 58, total_size: 52428800, start_time: iso(s.start), ...extra }));
    expect((await rec('http://zoom.us/rec/share/insecure')).body.data.outcome).toBe('ignored');
    expect((await rec('javascript:alert(1)')).body.data.outcome).toBe('ignored');
    const good = await rec('https://zoom.us/rec/share/abc'); expect(good.body.data.outcome).toBe('applied');
    expect((await rec('https://zoom.us/rec/share/abc')).body.data.outcome).toBe('duplicate');
    for (const c of [rv, parentTok, t1]) { const r = await c.get(`/api/live/sessions/${s.id}/recordings`); expect(r.status).toBe(200); expect(r.body.data).toHaveLength(1); }
    const r = (await rv.get(`/api/live/sessions/${s.id}/recordings`)).body.data[0]; expect(r.share_url).toBe('https://zoom.us/rec/share/abc'); expect(r.passcode).toBe('pw123'); expect(Number(r.size_mb)).toBe(50);
    expect((await outsiderC.get(`/api/live/sessions/${s.id}/recordings`)).status).toBe(404);       // another batch's learner
    expect((await other.admin.get(`/api/live/sessions/${s.id}/recordings`)).status).toBe(404);
    expect((await query(`SELECT COUNT(*) AS n FROM notifications WHERE org_id = $1 AND kind = 'recording'`, [w.orgId]))[0].n).toBeGreaterThanOrEqual(1);
    expect((await t1.get(`/api/classrooms/${w.batches.roboA}/sessions`)).body.data.find((x: any) => x.id === s.id).recordings).toBe(1);
  });
});

describe('audit and monitoring', () => {
  it('audits meetings, matches and automatic marking, and the system status reports Zoom without secrets', async () => {
    const a = (await query(`SELECT DISTINCT action FROM audit_logs WHERE org_id = $1 AND (action LIKE 'live.%' OR action = 'attendance.auto_marked')`, [w.orgId])).map((r) => r.action);
    expect(a).toEqual(expect.arrayContaining(['live.meeting_created', 'live.meeting_removed', 'live.start_link_issued', 'live.participant_matched', 'attendance.auto_marked']));
    const st = (await client(w.superToken, w.orgId).get('/api/system/status')).body.data;
    expect(st.live).toMatchObject({ zoom_configured: true, webhook_configured: true }); expect(JSON.stringify(st)).not.toContain('zoom-secret-test-0001');
    expect(st.integrity.find((c: any) => c.id === 'live_unmarked')).toMatchObject({ ok: true });
    expect(st.integrity_ok).toBe(true);
  });
});
