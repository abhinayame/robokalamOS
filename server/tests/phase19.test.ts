import { beforeAll, describe, expect, it } from 'vitest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { runLmsReminders } from '../src/modules/lms/auto.js';
import { buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World; let ravi: any; let t1: ReturnType<typeof client>, rv: ReturnType<typeof client>; let acct: ReturnType<typeof client>; let acctId = '';

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  ravi = await newLearner(w, { full_name: 'Ravi Kumar', email: `ravi-${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD });
  t1 = client(await login(w.teachers.t1.email)); rv = client(await login(ravi.email));
  const email = `acct-${uniq()}@test.dev`; acctId = (await w.admin.post('/api/users', { full_name: 'Staff Sam', email, password: PASSWORD, roles: [{ role: 'accountant' }] })).body.data.id; acct = client(await login(email));
});
const mk = async (b: object = {}) => (await w.admin.post('/api/lms/courses', { title: `Course ${uniq()}`, audience: 'staff', ...b })).body.data.id as string;
const les = async (c: string, b: object = {}) => (await w.admin.post(`/api/lms/courses/${c}/lessons`, { title: 'Lesson one', kind: 'text', body: 'Read this.', ...b })).body.data.id as string;
const live = async (b: object = {}) => { const c = await mk(b); await les(c); expect((await w.admin.post(`/api/lms/courses/${c}/publish`)).status).toBe(200); return c; };
const enrolled = async (c: string) => (await query(`SELECT user_id, learner_id, source, due_at FROM lms_enrollments WHERE course_id = $1 AND status <> 'removed'`, [c]));

describe('choosing staff and taking a course yourself', () => {
  it('lists staff for the picker (owners only) and assigns by role, by person, or to everyone', async () => {
    expect((await t1.get('/api/lms/people')).status).toBe(403);
    const all = await w.admin.get('/api/lms/people'); expect(all.body.data.map((p: any) => p.full_name)).toContain('Staff Sam'); expect(all.body.meta.role_counts.teacher).toBeGreaterThanOrEqual(2);
    expect((await w.admin.get('/api/lms/people?role=accountant')).body.data.map((p: any) => p.id)).toEqual([acctId]); expect((await w.admin.get('/api/lms/people?q=sam')).body.data.length).toBe(1);
    expect((await other.admin.get('/api/lms/people?q=sam')).body.data.length).toBe(0);
    const c = await live();
    const dry = await w.admin.post(`/api/lms/courses/${c}/assign`, { roles: ['teacher'], dry_run: true }); expect(dry.body.data.staff).toMatchObject({ to_assign: 2 });          // both teachers, nobody else
    expect((await w.admin.post(`/api/lms/courses/${c}/assign`, { roles: ['teacher'], confirm: true })).status).toBe(201);
    expect((await enrolled(c)).map((e) => e.user_id).sort()).toEqual([w.teachers.t1.id, w.teachers.t2.id].sort());
    const again = await w.admin.post(`/api/lms/courses/${c}/assign`, { roles: ['teacher'], user_ids: [acctId], confirm: true }); expect(again.body.data.staff).toMatchObject({ to_assign: 1, already: 2 });
    expect((await enrolled(c)).length).toBe(3);
    const c2 = await live(); const everyone = await w.admin.post(`/api/lms/courses/${c2}/assign`, { all_staff: true, confirm: true }); expect(everyone.body.data.staff.to_assign).toBeGreaterThanOrEqual(4);   // admin, two teachers, accountant
    expect((await t1.get('/api/learn/my')).body.data.map((x: any) => x.course_id)).toContain(c2);
    const learnersOnly = await live({ audience: 'learners' }); expect((await w.admin.post(`/api/lms/courses/${learnersOnly}/assign`, { roles: ['teacher'], confirm: true })).status).toBe(400);
  });
  it('lets an owner enrol themselves, once, in a published course for staff', async () => {
    const c = await live(); const r = await w.admin.post(`/api/lms/courses/${c}/enrol-me`); expect(r.status).toBe(201);
    expect((await w.admin.post(`/api/lms/courses/${c}/enrol-me`)).body.data.already).toBe(true);
    expect((await enrolled(c))[0]).toMatchObject({ source: 'self' }); expect((await w.admin.get('/api/learn/my')).body.data.map((x: any) => x.course_id)).toContain(c);
    const draft = await mk(); expect((await w.admin.post(`/api/lms/courses/${draft}/enrol-me`)).status).toBe(409);
    const kids = await live({ audience: 'learners' }); expect((await w.admin.post(`/api/lms/courses/${kids}/enrol-me`)).status).toBe(400);
    expect((await t1.post(`/api/lms/courses/${c}/enrol-me`)).status).toBe(403); expect((await other.admin.post(`/api/lms/courses/${c}/enrol-me`)).status).toBe(404);
  });
});

describe('chapters with sections', () => {
  it('nests sections inside chapters, one level deep, and keeps the reading order', async () => {
    const c = await mk({ audience: 'both' }); const mod = async (title: string, parent_id?: string) => (await w.admin.post(`/api/lms/courses/${c}/modules`, { title, parent_id })).body.data.id as string;
    const A = await mod('Chapter A'), B = await mod('Chapter B'), A1 = await mod('Section A1', A), A2 = await mod('Section A2', A);
    expect((await w.admin.post(`/api/lms/courses/${c}/modules`, { title: 'Too deep', parent_id: A1 })).status).toBe(400);
    expect((await w.admin.post(`/api/lms/courses/${c}/modules`, { title: 'Wrong course', parent_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    const put = async (title: string, m: string) => { const id = await les(c, { title }); await w.admin.put(`/api/lms/lessons/${id}/module`, { module_id: m }); return id; };
    await put('B one', B); await put('A2 one', A2); await put('A one', A); await put('A1 one', A1);
    const order = async () => (await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data.lessons.map((l: any) => l.title);
    expect(await order()).toEqual(['A one', 'A1 one', 'A2 one', 'B one']);                  // chapter A's own lessons, then its sections, then chapter B
    expect((await w.admin.post(`/api/lms/courses/${c}/modules/reorder`, { ids: [A2, A1], parent_id: A })).status).toBe(200); expect(await order()).toEqual(['A one', 'A2 one', 'A1 one', 'B one']);
    expect((await w.admin.post(`/api/lms/courses/${c}/modules/reorder`, { ids: [B, A] })).status).toBe(200); expect(await order()).toEqual(['B one', 'A one', 'A2 one', 'A1 one']);
    expect((await w.admin.post(`/api/lms/courses/${c}/modules/reorder`, { ids: [A1] })).status).toBe(409);                  // a stale list
    expect((await w.admin.patch(`/api/lms/modules/${A}`, { title: 'Chapter A', parent_id: B })).status).toBe(400);           // a chapter that has sections cannot move inside another
    expect((await w.admin.patch(`/api/lms/modules/${A1}`, { title: 'Section A1', parent_id: B })).status).toBe(200);        // a section can move to another chapter
    expect((await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data.modules.find((m: any) => m.id === A1).parent_id).toBe(B);
    const cp = (await w.admin.post(`/api/lms/courses/${c}/duplicate`)).body.data.id; const copy = (await w.admin.get(`/api/lms/courses/${cp}/studio`)).body.data;
    const parentOf = Object.fromEntries(copy.modules.map((m: any) => [m.title, copy.modules.find((p: any) => p.id === m.parent_id)?.title ?? null])); expect(parentOf).toEqual({ 'Chapter A': null, 'Chapter B': null, 'Section A1': 'Chapter B', 'Section A2': 'Chapter A' });
    expect((await w.admin.del(`/api/lms/modules/${B}`)).status).toBe(200);
    const after = (await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data; expect(after.modules.map((m: any) => m.title).sort()).toEqual(['Chapter A', 'Section A2']); expect(after.lessons.length).toBe(4); expect(after.lessons.filter((l: any) => !l.module_id).map((l: any) => l.title).sort()).toEqual(['A1 one', 'B one']);
  });
  it('shows learners the nested order', async () => {
    const c = await mk({ audience: 'learners' }); const A = (await w.admin.post(`/api/lms/courses/${c}/modules`, { title: 'Chapter A' })).body.data.id; const A1 = (await w.admin.post(`/api/lms/courses/${c}/modules`, { title: 'Section A1', parent_id: A })).body.data.id;
    const l1 = await les(c, { title: 'In section' }), l2 = await les(c, { title: 'In chapter' }); await w.admin.put(`/api/lms/lessons/${l1}/module`, { module_id: A1 }); await w.admin.put(`/api/lms/lessons/${l2}/module`, { module_id: A });
    await w.admin.post(`/api/lms/courses/${c}/publish`); await w.admin.post(`/api/lms/courses/${c}/assign`, { selector: { learner_ids: [ravi.id] }, confirm: true });
    const v = (await rv.get(`/api/learn/courses/${c}`)).body.data; expect(v.lessons.map((l: any) => l.title)).toEqual(['In chapter', 'In section']); expect(v.modules.find((m: any) => m.id === A1).parent_id).toBe(A);
  });
});

describe('automatic assignment', () => {
  it('gives new teachers the onboarding course by themselves, and can catch up the people already there', async () => {
    const c = await live({ audience: 'staff', title: 'Welcome to the team' });
    expect((await t1.post(`/api/lms/courses/${c}/auto-rules`, { kind: 'role', ref: 'teacher' })).status).toBe(403);
    expect((await w.admin.post(`/api/lms/courses/${c}/auto-rules`, { kind: 'role', ref: 'wizard' })).status).toBe(400);
    expect((await w.admin.post(`/api/lms/courses/${c}/auto-rules`, { kind: 'role', ref: 'teacher', due_days: 14 })).status).toBe(201);
    expect((await w.admin.post(`/api/lms/courses/${c}/auto-rules`, { kind: 'role', ref: 'teacher' })).status).toBe(409);
    expect((await w.admin.post(`/api/lms/courses/${c}/auto-rules`, { kind: 'batch', ref: w.batches.roboA })).status).toBe(400);   // a staff course cannot go to a batch
    expect((await w.admin.get(`/api/lms/courses/${c}/auto-rules`)).body.data).toMatchObject([{ kind: 'role', ref: 'teacher', due_days: 14 }]);
    expect((await w.admin.post(`/api/lms/courses/${c}/auto-rules/apply`)).body.data).toMatchObject({ users: 2, rules: 1 });
    expect((await enrolled(c)).every((e) => e.source === 'auto' && e.due_at)).toBe(true);
    const mail = `new-${uniq()}@test.dev`; const nu = (await w.admin.post('/api/users', { full_name: 'New Hire', email: mail, password: PASSWORD, roles: [{ role: 'teacher' }] })).body.data.id;
    expect((await enrolled(c)).map((e) => e.user_id)).toContain(nu);
    expect(await queryOne(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'lms.assigned'`, [nu])).toBeTruthy();
    const mail2 = `co-${uniq()}@test.dev`; const co = (await w.admin.post('/api/users', { full_name: 'Counsellor C', email: mail2, password: PASSWORD, roles: [{ role: 'counsellor' }] })).body.data.id;
    expect((await enrolled(c)).map((e) => e.user_id)).not.toContain(co);                                                // a role without a rule gets nothing
    expect((await w.admin.put(`/api/users/${co}/roles`, { roles: [{ role: 'teacher' }] })).status).toBe(200); expect((await enrolled(c)).map((e) => e.user_id)).toContain(co);   // a promotion counts too
    const rid = (await w.admin.get(`/api/lms/courses/${c}/auto-rules`)).body.data[0].id; expect((await w.admin.del(`/api/lms/auto-rules/${rid}`)).status).toBe(200);
    expect((await other.admin.del(`/api/lms/auto-rules/${rid}`)).status).toBe(404);
  });
  it('starts a course for everyone who joins a batch, and ignores unpublished courses', async () => {
    const c = await live({ audience: 'learners', title: 'Robotics basics' }); const draft = await mk({ audience: 'learners' }); await les(draft);
    await w.admin.post(`/api/lms/courses/${c}/auto-rules`, { kind: 'batch', ref: w.batches.roboB, due_days: 30 }); await w.admin.post(`/api/lms/courses/${draft}/auto-rules`, { kind: 'batch', ref: w.batches.roboB });
    expect((await other.admin.post(`/api/lms/courses/${c}/auto-rules`, { kind: 'batch', ref: w.batches.roboB })).status).toBe(404);
    const kid = await newLearner(w, { full_name: 'Batch Joiner', batch_ids: [w.batches.roboB] });
    expect((await enrolled(c)).map((e) => e.learner_id)).toEqual([kid.id]); expect((await enrolled(draft)).length).toBe(0);
    expect((await enrolled(c))[0]).toMatchObject({ source: 'auto' });
    expect((await w.admin.post(`/api/lms/courses/${draft}/auto-rules/apply`)).status).toBe(409);
  });
});

describe('team training matrix and reminders', () => {
  it('shows who has done what, filters by role, and exports', async () => {
    const c = await live({ title: 'Safety basics' }); await w.admin.post(`/api/lms/courses/${c}/assign`, { roles: ['accountant', 'teacher'], confirm: true });
    const lid = (await query(`SELECT id FROM lms_lessons WHERE course_id = $1`, [c]))[0]!.id; const e = await queryOne(`SELECT id FROM lms_enrollments WHERE course_id = $1 AND user_id = $2`, [c, acctId]);
    expect((await acct.post(`/api/learn/courses/${c}/lessons/${lid}/complete`, {})).body.data.course_completed).toBe(true); void e;
    await exec(`UPDATE lms_enrollments SET due_at = DATE_SUB(NOW(3), INTERVAL 2 DAY) WHERE course_id = $1 AND user_id = $2`, [c, w.teachers.t1.id]);
    expect((await t1.get('/api/lms/team')).status).toBe(403);
    const m = (await w.admin.get('/api/lms/team')).body.data; const col = m.courses.find((x: any) => x.id === c)!.id;
    expect(m.rows.find((r: any) => r.user_id === acctId).cells[col]).toMatchObject({ status: 'done', percent: 100 }); expect(m.rows.find((r: any) => r.user_id === w.teachers.t1.id).cells[col]).toMatchObject({ status: 'assigned', overdue: true });
    expect(m.rows.find((r: any) => r.user_id === w.admin.userId ?? '')?.cells?.[col] ?? null).toBeNull(); expect(m.summary.overdue).toBeGreaterThanOrEqual(1);
    expect((await w.admin.get('/api/lms/team?role=accountant')).body.data.rows.map((r: any) => r.user_id)).toEqual([acctId]);
    expect((await other.admin.get('/api/lms/team')).body.data.rows.some((r: any) => r.user_id === acctId)).toBe(false);
    const csv = await w.admin.get('/api/lms/team.csv'); expect(csv.status).toBe(200); expect(csv.text).toContain('Staff Sam'); expect(csv.text).toContain('done'); expect(csv.text).toContain('(overdue)');
  });
  it('reminds people before a deadline and after it, without repeating itself', async () => {
    const c = await live({ audience: 'both', title: 'Compliance training' }); await w.admin.post(`/api/lms/courses/${c}/assign`, { user_ids: [acctId], selector: { learner_ids: [ravi.id] }, due_at: new Date(Date.now() + 5 * 86400_000).toISOString(), confirm: true });
    await exec(`UPDATE lms_enrollments SET due_at = DATE_ADD(NOW(3), INTERVAL 1 DAY) WHERE course_id = $1`, [c]);
    const a = await runLmsReminders(); expect(a.due_soon).toBeGreaterThanOrEqual(2);
    expect(await queryOne(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'lms.due_soon' AND link = $2`, [acctId, `/learn/${c}`])).toBeTruthy(); expect(await queryOne(`SELECT 1 FROM notifications WHERE learner_id = $1 AND kind = 'lms.due_soon'`, [ravi.id])).toBeTruthy();
    expect((await runLmsReminders()).due_soon).toBe(0);                                                          // not twice
    await exec(`UPDATE lms_enrollments SET due_at = DATE_SUB(NOW(3), INTERVAL 3 DAY) WHERE course_id = $1`, [c]);
    expect((await runLmsReminders()).overdue).toBeGreaterThanOrEqual(2); expect((await runLmsReminders()).overdue).toBe(0);
    await exec(`UPDATE lms_enrollments SET status = 'completed', completed_at = NOW(3) WHERE course_id = $1`, [c]); await exec(`DELETE FROM notifications WHERE link = $1`, [`/learn/${c}`]);
    const done = await runLmsReminders(); expect(done.overdue + done.due_soon).toBe(0);                          // finished people are left alone
  });
});
