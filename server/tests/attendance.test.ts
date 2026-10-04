import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World;
let ravi: any, meena: any, stranger: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, parent: ReturnType<typeof client>;
const room = () => `/api/classrooms/${w.batches.roboA}`;
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  const mk = (n: string, extra: object = {}) => newLearner(w, { full_name: n, email: `${n.toLowerCase().replace(/\W/g, '')}-${uniq()}@kids.test`, ...extra });
  ravi = await mk('Ravi Child', { parent: { full_name: 'Parent P', mobile: '9855555555', email: `pp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA, w.batches.roboB] });
  meena = await mk('Meena Child', { batch_ids: [w.batches.roboA] });
  stranger = await mk('Stranger Kid', { batch_ids: [w.batches.aiC] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  for (const l of [ravi, meena, stranger]) await w.admin.post(`/api/learners/${l.id}/login`, { password: PASSWORD });
  t1 = client(await login(w.teachers.t1.email)); t2 = client(await login(w.teachers.t2.email));
  rv = client(await login(ravi.email)); mn = client(await login(meena.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
});

describe('class sessions', () => {
  it('teacher schedules, generates from the batch schedule (idempotent); others cannot', async () => {
    expect((await rv.post(`${room()}/sessions`, { starts_at: iso(3600e3) })).status).toBe(403);
    expect((await t2.post(`${room()}/sessions`, { starts_at: iso(3600e3) })).status).toBe(404);
    expect((await t1.post(`${room()}/sessions`, { starts_at: iso(7200e3), ends_at: iso(3600e3) })).status).toBe(400);
    expect((await t1.post(`${room()}/sessions`, { starts_at: iso(7200e3), meeting_url: 'javascript:alert(1)' })).status).toBe(400);
    const fixed = iso(5 * 86400e3);
    const s = await t1.post(`${room()}/sessions`, { title: 'Intro', starts_at: fixed, meeting_url: 'https://meet.google.com/abc-defg-hij' });
    expect(s.status).toBe(201);
    expect((await t1.post(`${room()}/sessions`, { starts_at: fixed })).status).toBe(409);       // same slot
    const g = await t1.post(`${room()}/sessions/generate`, { from: day(10), to: day(12) });
    expect(g.status).toBe(201); expect(g.body.data.created).toBe(3);
    expect((await t1.post(`${room()}/sessions/generate`, { from: day(10), to: day(12) })).body.data).toMatchObject({ created: 0, skipped: 3 });
    expect((await t1.post(`${room()}/sessions/generate`, { from: day(10), to: day(300) })).status).toBe(400);
    expect((await t1.post(`${room()}/sessions/generate`, { from: day(12), to: day(10) })).status).toBe(400);
    const list = (await t1.get(`${room()}/sessions`)).body.data;
    expect(list).toHaveLength(4);
    expect(list.find((x: any) => x.title === 'Intro').meeting_provider).toBe('google_meet');
  });
  it('learners see classes but the meeting link only when it is time to join', async () => {
    const live = await t1.post(`${room()}/sessions`, { title: 'Live now', starts_at: iso(-5 * 60e3), ends_at: iso(3600e3), meeting_url: 'https://zoom.us/j/123' });
    const mine = (await rv.get(`${room()}/sessions`)).body.data;
    const far = mine.find((x: any) => x.title === 'Intro');
    expect(far).toMatchObject({ has_meeting: true, can_join: false }); expect(far.meeting_url).toBeUndefined();
    const now = mine.find((x: any) => x.title === 'Live now');
    expect(now).toMatchObject({ can_join: true, meeting_url: 'https://zoom.us/j/123', meeting_provider: 'zoom' });
    expect((await t1.get(`${room()}/sessions`)).body.data.find((x: any) => x.title === 'Intro').meeting_url).toBeTruthy();   // staff always
    expect((await client(await login(stranger.email)).get(`${room()}/sessions`)).status).toBe(404);
    expect((await other.admin.get(`${room()}/sessions`)).status).toBe(404);
    expect((await rv.get('/api/attendance/classes')).body.data.some((x: any) => x.title === 'Live now' && x.can_join)).toBe(true);
    void live;
  });
  it('status transitions are enforced; cancelling notifies learners and parents but not the teacher', async () => {
    const s = await t1.post(`${room()}/sessions`, { title: 'To cancel', starts_at: iso(9 * 86400e3 + 1000) });
    const id = s.body.data.id;
    expect((await t1.patch(`${room()}/sessions/${id}`, { status: 'started' })).status).toBe(200);
    expect((await t1.patch(`${room()}/sessions/${id}`, { status: 'scheduled' })).status).toBe(409);
    expect((await t1.patch(`${room()}/sessions/${id}`, { status: 'cancelled', cancel_reason: 'Teacher unwell' })).status).toBe(200);
    expect((await rv.get('/api/notifications?unread=1')).body.data.some((n: any) => n.kind === 'class.cancelled')).toBe(true);
    expect((await parent.get('/api/notifications')).body.data.some((n: any) => n.kind === 'class.cancelled' && n.learner_name === 'Ravi Child')).toBe(true);
    expect((await t1.get('/api/notifications')).body.data.some((n: any) => n.kind === 'class.cancelled')).toBe(false);
    expect((await t1.put(`${room()}/sessions/${id}/attendance`, { entries: [{ learner_id: ravi.id, status: 'present' }] })).status).toBe(409);
    expect((await rv.patch(`${room()}/sessions/${id}`, { status: 'started' })).status).toBe(403);
  });
});

describe('attendance marking and percentages', () => {
  let sessions: string[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 4; i++) sessions.push((await t1.post(`${room()}/sessions`, { title: `Class ${i + 1}`, starts_at: iso(-(i + 1) * 86400e3 - 7 * 3600e3) })).body.data.id);
  });
  it('sheet shows the roster; only active members can be marked; duplicates merged; session auto-completes', async () => {
    const sheet = await t1.get(`${room()}/sessions/${sessions[0]}/attendance`);
    expect(sheet.body.data.rows.map((r: any) => r.full_name).sort()).toEqual(['Meena Child', 'Ravi Child']);
    expect((await t1.put(`${room()}/sessions/${sessions[0]}/attendance`, { entries: [{ learner_id: stranger.id, status: 'present' }] })).status).toBe(400);
    expect((await t1.put(`${room()}/sessions/${sessions[0]}/attendance`, { entries: [{ learner_id: ravi.id, status: 'bogus' }] })).status).toBe(400);
    expect((await rv.put(`${room()}/sessions/${sessions[0]}/attendance`, { entries: [{ learner_id: ravi.id, status: 'present' }] })).status).toBe(403);
    expect((await t2.put(`${room()}/sessions/${sessions[0]}/attendance`, { entries: [{ learner_id: ravi.id, status: 'present' }] })).status).toBe(404);
    const save = await t1.put(`${room()}/sessions/${sessions[0]}/attendance`, { entries: [{ learner_id: ravi.id, status: 'absent' }, { learner_id: ravi.id, status: 'present' }, { learner_id: meena.id, status: 'present' }] });
    expect(save.body.data).toMatchObject({ marked: 2, changed: 0 });
    expect((await t1.get(`${room()}/sessions`)).body.data.find((x: any) => x.id === sessions[0]).status).toBe('completed');
  });
  it('absent marks notify learner and parent once; re-saving the same mark does not repeat it', async () => {
    const before = (await parent.get('/api/notifications')).body.meta.total;
    const e = { entries: [{ learner_id: ravi.id, status: 'absent', note: 'Fever' }, { learner_id: meena.id, status: 'late' }] };
    expect((await t1.put(`${room()}/sessions/${sessions[1]}/attendance`, e)).body.data.notified_absent).toBe(1);
    expect((await t1.put(`${room()}/sessions/${sessions[1]}/attendance`, { entries: [{ learner_id: ravi.id, status: 'absent', note: 'Fever' }] })).body.data.notified_absent).toBe(0);
    const n = (await parent.get('/api/notifications')).body;
    expect(n.meta.total).toBe(before + 1);
    expect(n.data[0]).toMatchObject({ kind: 'attendance.absent', learner_name: 'Ravi Child' });
    expect((await mn.get('/api/notifications')).body.data.some((x: any) => x.kind === 'attendance.absent')).toBe(false);
  });
  it('percentages: present+late over present+late+absent; excused and unmarked are not counted; corrections work', async () => {
    await t1.put(`${room()}/sessions/${sessions[2]}/attendance`, { entries: [{ learner_id: ravi.id, status: 'excused' }, { learner_id: meena.id, status: 'absent' }] });
    const rep = (await t1.get(`${room()}/attendance/report`)).body.data;
    const r = rep.learners.find((x: any) => x.full_name === 'Ravi Child'); const m = rep.learners.find((x: any) => x.full_name === 'Meena Child');
    expect(r).toMatchObject({ present: 1, absent: 1, excused: 1, pct: 50, low: true });
    expect(m).toMatchObject({ present: 1, late: 1, absent: 1, pct: 66.67, low: true });
    expect(rep.sessions.find((s: any) => s.id === sessions[2]).absent).toBe(1);
    await t1.put(`${room()}/sessions/${sessions[1]}/attendance`, { entries: [{ learner_id: ravi.id, status: 'present' }] });    // correction
    expect((await t1.get(`${room()}/attendance/report`)).body.data.learners.find((x: any) => x.full_name === 'Ravi Child').pct).toBe(100);
  });
  it('a learner in two batches gets separate per-batch figures; the other batch is never merged in', async () => {
    const sB = (await w.admin.post(`/api/classrooms/${w.batches.roboB}/sessions`, { title: 'B1', starts_at: iso(-3 * 86400e3) })).body.data.id;
    await w.admin.put(`/api/classrooms/${w.batches.roboB}/sessions/${sB}/attendance`, { entries: [{ learner_id: ravi.id, status: 'absent' }] });
    const sum = (await rv.get('/api/attendance/summary')).body.data;
    expect(sum.batches).toHaveLength(2);
    expect(sum.batches.find((b: any) => b.batch_id === w.batches.roboA)).toMatchObject({ present: 2, absent: 0, excused: 1, pct: 100 });
    expect(sum.batches.find((b: any) => b.batch_id === w.batches.roboB)).toMatchObject({ absent: 1, pct: 0 });
    expect(sum.overall.pct).toBe(66.67);
    expect(sum.monthly.length).toBeGreaterThan(0);
    expect((await t1.get(`${room()}/attendance/report`)).body.data.learners.find((x: any) => x.full_name === 'Ravi Child').pct).toBe(100);   // roboA report unaffected
    // a teacher of A cannot read batch B's attendance through the learner
    const tsum = (await t1.get(`/api/attendance/summary?learner_id=${ravi.id}`)).body.data;
    expect(tsum.batches.map((b: any) => b.batch_id)).toEqual([w.batches.roboA]);
  });
  it('privacy: learners see only their own marks; parents their child; strangers and other orgs nothing', async () => {
    const mine = (await mn.get(`${room()}/attendance/report`)).body.data;
    expect(mine.learners.map((l: any) => l.full_name)).toEqual(['Meena Child']); expect(mine.sessions).toBeUndefined();
    expect((await mn.get(`${room()}/attendance/report?learner_id=${ravi.id}`)).body.data.learners).toHaveLength(0);
    expect((await parent.get('/api/attendance/summary')).body.data.batches).toHaveLength(2);
    expect((await mn.get(`/api/attendance/summary?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await t2.get(`/api/attendance/summary?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await other.admin.get(`/api/attendance/summary?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await rv.get(`${room()}/sessions`)).body.data.find((x: any) => x.id === sessions[1]).my_status).toBe('present');
  });
});

describe('notifications', () => {
  it('assignment posted/evaluated/badge notify the learner and parent; read state is per user', async () => {
    const a = await t1.post(`${room()}/assignments`, { title: 'Build a robot', max_marks: 10 });
    expect((await rv.get('/api/notifications')).body.data.some((n: any) => n.kind === 'assignment.posted')).toBe(true);
    expect((await parent.get('/api/notifications')).body.data.some((n: any) => n.kind === 'assignment.posted')).toBe(true);
    const sub = await rv.put(`/api/assignments/${a.body.data.id}/submission`, { body: 'done', submit: true });
    await t1.post(`/api/submissions/${sub.body.data.id}/review`, { action: 'evaluate', score: 9, feedback: 'Nice' });
    expect((await rv.get('/api/notifications')).body.data.some((n: any) => n.kind === 'assignment.evaluated')).toBe(true);
    const list = (await rv.get('/api/notifications')).body;
    expect(list.meta.unread).toBeGreaterThan(0);
    expect((await mn.post(`/api/notifications/${list.data[0].id}/read`)).status).toBe(404);          // not yours
    expect((await rv.post(`/api/notifications/${list.data[0].id}/read`)).status).toBe(200);
    expect((await rv.get('/api/notifications/unread-count')).body.data.unread).toBe(list.meta.unread - 1);
    expect((await rv.post('/api/notifications/read-all')).status).toBe(200);
    expect((await rv.get('/api/notifications/unread-count')).body.data.unread).toBe(0);
    expect((await parent.get('/api/notifications/unread-count')).body.data.unread).toBeGreaterThan(0);   // parent's own state untouched
    const dbOther = await query(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT user_id FROM learners WHERE id = $1)`, [stranger.id]);
    expect(Number(dbOther[0].n)).toBe(0);
  });
});

describe('portal and analytics', () => {
  it('announcements and teacher feedback reach the family; scope enforced', async () => {
    await t1.post(`${room()}/posts`, { kind: 'announcement', body: 'Kits arrive Monday', pinned: true });
    const an = (await parent.get('/api/portal/announcements')).body.data;
    expect(an[0]).toMatchObject({ body: 'Kits arrive Monday', batch_name: 'Robotics Batch A' });
    const fb = (await parent.get('/api/portal/feedback')).body.data;
    expect(fb.some((f: any) => f.feedback === 'Nice' && f.by_teacher === 'Teacher t1')).toBe(true);
    expect((await mn.get(`/api/portal/feedback?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await t2.get(`/api/portal/announcements?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await client(await login(stranger.email)).get('/api/portal/announcements')).body.data).toHaveLength(0);
  });
  it('learner analytics: trends over months, completion and course progress; no cross-learner leaks', async () => {
    const a = (await rv.get('/api/analytics/learner?months=6')).body.data;
    expect(a.months).toHaveLength(6); expect(a.performance).toHaveLength(6); expect(a.attendance).toHaveLength(6);
    expect(a.performance[5].avg_pct).toBe(90);
    expect(a.xp[5].balance).toBe(a.xp[5].earned + 0);
    expect(a.assignment_completion.find((x: any) => x.batch_id === w.batches.roboA)).toMatchObject({ total: 1, done: 1, pct: 100 });
    expect(a.course_progress.find((c: any) => c.course_name === 'Robotics').pct).toBeGreaterThan(0);
    const t = (await t1.get(`/api/analytics/learner?learner_id=${ravi.id}`)).body.data;
    expect(t.assignment_completion.map((x: any) => x.batch_id)).toEqual([w.batches.roboA]);      // staff see only their own batches
    expect((await mn.get(`/api/analytics/learner?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await other.admin.get(`/api/analytics/learner?learner_id=${ravi.id}`)).status).toBe(404);
  });
});
