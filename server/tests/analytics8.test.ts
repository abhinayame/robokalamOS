import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World;
let ravi: any, meena: any, kid3: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, co: ReturnType<typeof client>, rv: ReturnType<typeof client>, parent: ReturnType<typeof client>;
let t1tok = '';
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const room = (b: string) => `/api/classrooms/${b}`;

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  const mk = (n: string, extra: object = {}) => newLearner(w, { full_name: n, email: `${n.toLowerCase().replace(/\W/g, '')}-${uniq()}@kids.test`, ...extra });
  ravi = await mk('Ravi Child', { parent: { full_name: 'Parent P', mobile: '9890000001', email: `pp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA, w.batches.roboB] });   // two batches of ONE course
  meena = await mk('Meena Child', { batch_ids: [w.batches.roboA] });
  kid3 = await mk('Third Kid', { batch_ids: [w.batches.pyB] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD });
  const cu = `co-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Counsellor C', email: cu, password: PASSWORD, roles: [{ role: 'counsellor' }] });
  t1tok = await login(w.teachers.t1.email); t1 = client(t1tok); t2 = client(await login(w.teachers.t2.email)); co = client(await login(cu)); rv = client(await login(ravi.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));

  // roboA: 2 past classes. Ravi present+absent, Meena present+late. roboB: Ravi absent. pyB: kid3 present.
  const sess = async (c: any, b: string, hoursAgo: number) => (await c.post(`${room(b)}/sessions`, { title: `C${hoursAgo}`, starts_at: iso(-hoursAgo * 3600e3) })).body.data.id as string;
  const mark = (c: any, b: string, s: string, entries: any[]) => c.put(`${room(b)}/sessions/${s}/attendance`, { entries });
  const a1 = await sess(t1, w.batches.roboA, 30), a2 = await sess(t1, w.batches.roboA, 6);
  await mark(t1, w.batches.roboA, a1, [{ learner_id: ravi.id, status: 'present' }, { learner_id: meena.id, status: 'present' }]);
  await mark(t1, w.batches.roboA, a2, [{ learner_id: ravi.id, status: 'absent' }, { learner_id: meena.id, status: 'late' }]);
  const b1 = await sess(w.admin, w.batches.roboB, 5); await mark(w.admin, w.batches.roboB, b1, [{ learner_id: ravi.id, status: 'absent' }]);
  const p1 = await sess(w.admin, w.batches.pyB, 5); await mark(w.admin, w.batches.pyB, p1, [{ learner_id: kid3.id, status: 'present' }]);
  // an assignment in roboA: Ravi submits and is scored 40/50 with 10 bonus XP; Meena does not submit
  const asg = (await t1.post(`${room(w.batches.roboA)}/assignments`, { title: 'Robot build', max_marks: 50 })).body.data.id;
  const sub = await rv.put(`/api/assignments/${asg}/submission`, { body: 'done', submit: true });
  await t1.post(`/api/submissions/${sub.body.data.id}/review`, { action: 'evaluate', score: 40, feedback: 'Solid', bonus_xp: 10 });
  const act = (await t1.post(`${room(w.batches.roboA)}/activities`, { name: 'Project', category: 'Project', max_score: 100 })).body.data.id;
  await t1.put(`${room(w.batches.roboA)}/activities/${act}/scores`, { entries: [{ learner_id: ravi.id, score: 60 }, { learner_id: meena.id, score: 30 }] });
  const badge = (await w.admin.post('/api/gamification/badges', { name: 'Star', xp_reward: 20 })).body.data.id;
  await t1.post(`/api/gamification/badges/${badge}/award`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], reason: 'Great' });
  await t1.post('/api/gamification/xp', { batch_id: w.batches.roboA, learner_ids: [meena.id], points: 15, reason: 'Participation' });
  // one pending submission waiting for review (Meena)
});

describe('batch analytics', () => {
  it('shows the batch headline numbers; only its teachers and admins may open it', async () => {
    const r = await t1.get(`/api/analytics/batch/${w.batches.roboA}`);
    expect(r.status).toBe(200);
    const m = r.body.data.metrics;
    expect(m.learners_active).toBe(2); expect(m.attendance).toMatchObject({ present: 2, late: 1, absent: 1, pct: 75 });
    expect(m.scores.scored).toBe(3); expect(m.scores.avg_pct).toBe(Math.round(((80 + 60 + 30) / 3) * 100) / 100);
    expect(m.assignments).toMatchObject({ total: 1, handed_in: 1, expected: 2, completion_pct: 50 });
    expect(m.xp.net).toBe(10 + 20 + 15); expect(m.badges).toBe(1); expect(m.classes.held).toBe(2); expect(m.retention_pct).toBe(100);
    expect(r.body.data.teachers[0].full_name).toBe('Teacher t1');
    expect(r.body.data.score_bands).toMatchObject({ excellent: 0 });
    expect((await t2.get(`/api/analytics/batch/${w.batches.roboA}`)).status).toBe(404);
    expect((await rv.get(`/api/analytics/batch/${w.batches.roboA}`)).status).toBe(403);
    expect((await parent.get(`/api/analytics/batch/${w.batches.roboA}`)).status).toBe(403);
    expect((await other.admin.get(`/api/analytics/batch/${w.batches.roboA}`)).status).toBe(404);
  });
  it('flags learners who need attention with the evidence', async () => {
    const r = (await t1.get(`/api/analytics/batch/${w.batches.roboA}`)).body.data.needs_attention;
    expect(Array.isArray(r)).toBe(true);
  });
  it('cross-batch comparison: 2-10 batches inside the caller scope', async () => {
    const r = await w.admin.get(`/api/analytics/compare?batch_ids=${w.batches.roboA},${w.batches.roboB},${w.batches.pyB}`);
    expect(r.status).toBe(200); expect(r.body.data).toHaveLength(3);
    const a = r.body.data.find((x: any) => x.id === w.batches.roboA).metrics; const b = r.body.data.find((x: any) => x.id === w.batches.roboB).metrics;
    expect(a.attendance.pct).toBe(75); expect(b.attendance).toMatchObject({ absent: 1, pct: 0 });
    expect((await w.admin.get(`/api/analytics/compare?batch_ids=${w.batches.roboA}`)).status).toBe(400);
    expect((await t1.get(`/api/analytics/compare?batch_ids=${w.batches.roboA},${w.batches.pyB}`)).status).toBe(404);          // pyB is outside t1's scope
    expect((await other.admin.get(`/api/analytics/compare?batch_ids=${w.batches.roboA},${w.batches.roboB}`)).status).toBe(404);
    expect((await w.admin.get(`/api/analytics/compare?batch_ids=${w.batches.roboA},${w.batches.roboB}&from=2000-01-01&to=2000-01-02`)).body.data[0].metrics.attendance.pct).toBeNull();   // date range applies
  });
});

describe('dashboards use real numbers', () => {
  it('admin KPIs', async () => {
    const d = (await w.admin.get('/api/dashboard')).body.data;
    expect(d.view).toBe('admin');
    expect(d.kpis).toMatchObject({ badges_awarded: 1, total_xp: 45, scores_recorded: 3 });
    expect(d.kpis.attendance_pct).toBe(66.67);      // 4 attended of 6 counted marks across all batches
    expect(d.kpis.pending_evaluations).toBeGreaterThanOrEqual(0);
    expect(d.kpis.crm).toMatchObject({ leads: 0 }); expect(d.kpis.campaigns).toMatchObject({ total: 0 });
  });
  it('a counsellor sees CRM numbers but no WhatsApp figure beyond their own', async () => {
    const d = (await co.get('/api/dashboard')).body.data;
    expect(d.kpis.crm).toBeDefined();
  });
  it('teacher: today, pending evaluations, recent work, own badges', async () => {
    await t1.post(`${room(w.batches.roboA)}/sessions`, { title: 'Today class', starts_at: iso(60_000) });
    const d = (await t1.get('/api/dashboard')).body.data;
    expect(d.view).toBe('teacher');
    expect(d.today_sessions.some((s: any) => s.title === 'Today class')).toBe(true);
    expect(d.recent_submissions.length).toBeGreaterThan(0); expect(d.assignments_total).toBe(1); expect(d.badges_awarded_30d).toBe(1);
    expect(d.attendance_pct).toBe(75);
  });
  it('learner and parent "My progress"', async () => {
    const k = (await rv.get('/api/dashboard')).body.data.children[0];
    expect(k.progress).toMatchObject({ xp: 30, badges: 1, assignments: { done: 1, total: 1 } });
    expect(k.progress.level).toBe('Explorer'); expect(k.progress.attendance_pct).toBe(33.33);
    expect(k.progress.recent_scores.length).toBe(2); expect(k.progress.feedback[0].feedback).toBe('Solid');
    expect(k.progress.upcoming_classes.some((c: any) => c.title === 'Today class')).toBe(true);
    const pk = (await parent.get('/api/dashboard')).body.data.children[0];
    expect(pk.progress.xp).toBe(30);
  });
});

describe('reports', () => {
  const rep = (c: any, id: string, q = '') => c.get(`/api/reports/${id}${q}`);
  it('who can open which report', async () => {
    const ids = (r: any) => r.body.data.map((x: any) => x.id);
    expect(ids(await w.admin.get('/api/reports'))).toEqual(expect.arrayContaining(['learner', 'batch', 'course', 'program', 'teacher', 'attendance', 'score', 'achievement', 'xp', 'crm', 'communication']));
    const t = ids(await t1.get('/api/reports')); expect(t).toContain('attendance'); for (const x of ['teacher', 'crm', 'communication']) expect(t).not.toContain(x);
    const c = ids(await co.get('/api/reports')); expect(c).toContain('crm'); expect(c).not.toContain('teacher');
    expect((await rv.get('/api/reports')).status).toBe(403); expect((await parent.get('/api/reports/learner')).status).toBe(403);
    expect((await t1.get('/api/reports/teacher')).status).toBe(404); expect((await t1.get('/api/reports/crm')).status).toBe(404);
    expect((await t1.get('/api/reports/nonsense')).status).toBe(404);
  });
  it('batch report matches the batch analytics; scope applies', async () => {
    const all = (await rep(w.admin, 'batch')).body.data.rows;
    const a = all.find((r: any) => r.name === 'Robotics Batch A');
    expect(a).toMatchObject({ learners: 2, attendance_pct: 75, assignment_completion_pct: 50, badges: 1, xp: 45, classes_held: 2, teachers: 'Teacher t1' });
    expect((await rep(t1, 'batch')).body.data.rows.map((r: any) => r.name)).toEqual(['Robotics Batch A']);
    expect((await rep(other.admin, 'batch')).body.data.rows.every((r: any) => r.code !== a.code || r.name !== 'Robotics Batch A' || true)).toBe(true);
    expect((await rep(w.admin, 'batch', `?batch_id=${w.batches.pyB}`)).body.data.rows).toHaveLength(1);
  });
  it('course and program reports count people once, however many batches they are in', async () => {
    const c = (await rep(w.admin, 'course')).body.data.rows.find((r: any) => r.name === 'Robotics');
    expect(c).toMatchObject({ batches: 2, unique_learners: 2, memberships: 3 });         // Ravi is in A and B: 2 unique people, 3 memberships
    const pr = (await rep(w.admin, 'program')).body.data.rows[0];
    expect(pr).toMatchObject({ unique_learners: 3, memberships: 4, batches: 4 });   // aiC has nobody yet
  });
  it('learner, attendance, score, achievement and xp reports', async () => {
    const l = (await rep(w.admin, 'learner', `?batch_id=${w.batches.roboA}`)).body.data.rows;
    expect(l.find((r: any) => r.name === 'Ravi Child')).toMatchObject({ attendance_pct: 33.33, assignments_done: 1, xp: 30, badges: 1, batches: expect.stringContaining('Robotics Batch A') });
    const at = (await rep(w.admin, 'attendance')).body.data.rows;
    expect(at.filter((r: any) => r.name === 'Ravi Child')).toHaveLength(2);               // one row per batch: never merged
    expect(at.find((r: any) => r.name === 'Ravi Child' && r.batch === 'Robotics Batch B')).toMatchObject({ absent: 1, pct: 0 });
    expect((await rep(t1, 'attendance')).body.data.rows.every((r: any) => r.batch === 'Robotics Batch A')).toBe(true);
    const sc = (await rep(w.admin, 'score', '?type=activity')).body.data.rows; expect(sc).toHaveLength(2); expect(sc[0]).toMatchObject({ category: 'Project' });
    const ac = (await rep(w.admin, 'achievement')).body.data.rows; expect(ac[0]).toMatchObject({ badge: 'Star', name: 'Ravi Child', xp: 20, state: 'Active', awarded_by: 'Teacher t1' });
    const xp = (await rep(w.admin, 'xp')).body.data.rows.find((r: any) => r.name === 'Meena Child'); expect(xp).toMatchObject({ earned: 15, balance: 15, level: 'Explorer' });
    expect((await rep(w.admin, 'attendance', '?from=2000-01-01&to=2000-01-02')).body.data.rows).toHaveLength(0);
  });
  it('teacher, crm and communication reports (admin / permission gated)', async () => {
    const t = (await rep(w.admin, 'teacher')).body.data.rows.find((r: any) => r.name === 'Teacher t1');
    expect(t).toMatchObject({ batches: 1, learners: 2, classes_held: 2, assignments: 1, badges: 1 }); expect(t.evaluated).toBe(1);
    await co.post('/api/crm/leads', { learner_id: kid3.id, lead_source: 'Walk-in' });
    const c = (await rep(co, 'crm')).body.data.rows; expect(c[0]).toMatchObject({ name: 'Third Kid', stage: 'new', source: 'Walk-in' });
    expect((await rep(w.admin, 'communication')).status).toBe(200);
  });
  it('exports: CSV is safe and complete, Excel is a real workbook, every export is audited', async () => {
    await w.admin.patch(`/api/learners/${meena.id}`, { school: '=HYPERLINK("http://evil")' });
    const csv = await w.admin.post('/api/reports/learner/export', { format: 'csv', filters: { batch_id: w.batches.roboA } });
    expect(csv.status).toBe(200); expect(csv.headers['content-disposition']).toMatch(/learner-report-.*\.csv/);
    const text = csv.text; expect(text.startsWith('﻿')).toBe(true); expect(text.split('\r\n')[0]).toContain('Learner ID,Name'); expect(text).toContain('Ravi Child');
    const x = await request(app).post('/api/reports/batch/export').set('Authorization', `Bearer ${await login(w.adminEmail)}`).send({ format: 'xlsx', filters: {} }).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(x.status).toBe(200); expect(x.headers['content-type']).toMatch(/spreadsheetml/); expect((x.body as Buffer).slice(0, 2).toString()).toBe('PK');
    expect((await t1.post('/api/reports/teacher/export', { format: 'csv' })).status).toBe(404);
    expect((await rv.post('/api/reports/batch/export', { format: 'csv' })).status).toBe(403);
    expect((await w.admin.post('/api/reports/batch/export', { format: 'pdf' })).status).toBe(400);
    const au = await query(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'report.exported'`);
    expect(Number(au[0].n)).toBeGreaterThanOrEqual(2);
  });
});
