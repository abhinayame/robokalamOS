import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World; let ravi: any, meena: any, outsider: any;
let t1: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, out: ReturnType<typeof client>, parent: ReturnType<typeof client>, acct: ReturnType<typeof client>;
let design = ''; let raviToken = '';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const upload = (token: string, name: string, b: Buffer) => request(app).post(`/api/files?name=${name}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').send(b);

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  ravi = await newLearner(w, { full_name: 'Ravi Kumar', email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Ravi Parent', mobile: '9870000041', email: `rp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA] });
  meena = await newLearner(w, { full_name: 'Meena Rao', email: `meena-${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
  outsider = await newLearner(w, { full_name: 'Out Sider', email: `out-${uniq()}@kids.test`, batch_ids: [w.batches.pyB] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  for (const l of [ravi, meena, outsider]) await w.admin.post(`/api/learners/${l.id}/login`, { password: PASSWORD });
  raviToken = await login(ravi.email);
  t1 = client(await login(w.teachers.t1.email)); rv = client(raviToken); mn = client(await login(meena.email)); out = client(await login(outsider.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id; parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
  const staffEmail = `acct-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Staff Sam', email: staffEmail, password: PASSWORD, roles: [{ role: 'accountant' }] }); acct = client(await login(staffEmail));
  design = (await w.admin.post('/api/certificates/designs', { name: 'Std', title_text: 'Certificate of Completion', body_text: 'has completed {course_name}.', signatory_name: 'Dr. Rao', signatory_title: 'Director' })).body.data.id;
});

const mk = async (b: object = {}) => (await w.admin.post('/api/lms/courses', { title: `Course ${uniq()}`, audience: 'learners', ...b })).body.data.id as string;
const les = async (c: string, b: object) => { const r = await w.admin.post(`/api/lms/courses/${c}/lessons`, { title: 'Lesson one', kind: 'text', body: 'Read this.', ...b }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.data.id as string; };
const publish = async (c: string) => expect((await w.admin.post(`/api/lms/courses/${c}/publish`)).status).toBe(200);
const give = async (c: string, ids: string[]) => expect((await w.admin.post(`/api/lms/courses/${c}/assign`, { selector: { learner_ids: ids }, confirm: true })).status).toBe(201);
const done = (c: string, l: string, b: object = {}) => rv.post(`/api/learn/courses/${c}/lessons/${l}/complete`, b);

describe('publishing', () => {
  it('shows what is missing, publishes with one call, and can be taken back to draft', async () => {
    const c = await mk();
    const cl = (await w.admin.get(`/api/lms/courses/${c}/checklist`)).body.data; expect(cl.ready).toBe(false); expect(cl.items.find((i: any) => i.id === 'lessons')).toMatchObject({ ok: false, blocking: true });
    const no = await w.admin.post(`/api/lms/courses/${c}/publish`); expect(no.status).toBe(400); expect(no.body.error.message).toContain('has lessons');
    expect((await t1.post(`/api/lms/courses/${c}/publish`)).status).toBe(403);
    await les(c, {});
    const cl2 = (await w.admin.get(`/api/lms/courses/${c}/checklist`)).body.data; expect(cl2.ready).toBe(true); expect(cl2.items.find((i: any) => i.id === 'certificate').ok).toBe(false);   // advice only, never blocking
    expect((await w.admin.post(`/api/lms/courses/${c}/publish`)).status).toBe(200);
    expect((await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data.course).toMatchObject({ status: 'published' });
    expect((await queryOne(`SELECT published_at FROM lms_courses WHERE id = $1`, [c]))!.published_at).toBeTruthy();
    expect((await w.admin.post(`/api/lms/courses/${c}/unpublish`)).status).toBe(200); expect((await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data.course.status).toBe('draft');
    expect((await other.admin.post(`/api/lms/courses/${c}/publish`)).status).toBe(404);
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'lms.course_published' AND entity_id = $1`, [c])).toBeTruthy();
  });
  it('holds file lessons and empty quizzes back until they are complete', async () => {
    const c = await mk(); const f = await les(c, { title: 'Worksheet', kind: 'file', body: null });
    const r = await w.admin.post(`/api/lms/courses/${c}/publish`); expect(r.status).toBe(400); expect(r.body.error.message).toContain('file');
    const up = await upload(await login(w.adminEmail), 'sheet.pdf', PDF); expect(up.status).toBe(201);
    expect((await w.admin.put(`/api/lms/lessons/${f}/files`, { file_ids: [up.body.data.id] })).status).toBe(200);
    expect((await w.admin.post(`/api/lms/courses/${c}/publish`)).status).toBe(200);
  });
});

describe('course details, modules and preview', () => {
  it('stores landing-page details with validation and returns them in the studio', async () => {
    const c = await mk();
    expect((await t1.patch(`/api/lms/courses/${c}/details`, { category: 'Robotics' })).status).toBe(403);
    expect((await w.admin.patch(`/api/lms/courses/${c}/details`, { level: 'expert' })).status).toBe(400); expect((await w.admin.patch(`/api/lms/courses/${c}/details`, { min_grade: 0 })).status).toBe(400); expect((await w.admin.patch(`/api/lms/courses/${c}/details`, { outcomes: Array(11).fill('Learn it') })).status).toBe(400);
    const p = await w.admin.patch(`/api/lms/courses/${c}/details`, { category: 'Robotics', level: 'beginner', description: 'A friendly start.', outcomes: ['Build a robot', 'Read sensors'], requirements: 'None', instructor_name: 'Ms. Rao', icon: '🤖', enrollment_mode: 'open', sequential: true, min_grade: 60, xp_reward: 50 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const s = (await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data; expect(s.course).toMatchObject({ category: 'Robotics', level: 'beginner', outcomes: ['Build a robot', 'Read sensors'], sequential: true, min_grade: 60, xp_reward: 50, enrollment_mode: 'open' });
    expect((await other.admin.get(`/api/lms/courses/${c}/studio`)).status).toBe(404);
  });
  it('groups lessons into modules, keeps their order, and ungroups on delete', async () => {
    const c = await mk(); const a = await les(c, { title: 'Lesson A' }), b = await les(c, { title: 'Lesson B' }), d = await les(c, { title: 'Lesson C' });
    const m1 = (await w.admin.post(`/api/lms/courses/${c}/modules`, { title: 'Getting started' })).body.data.id, m2 = (await w.admin.post(`/api/lms/courses/${c}/modules`, { title: 'Going further' })).body.data.id;
    expect((await w.admin.post(`/api/lms/courses/${c}/modules`, { title: 'x' })).status).toBe(400); expect((await t1.post(`/api/lms/courses/${c}/modules`, { title: 'Nope nope' })).status).toBe(403);
    await w.admin.put(`/api/lms/lessons/${d}/module`, { module_id: m1 }); await w.admin.put(`/api/lms/lessons/${a}/module`, { module_id: m2 }); await w.admin.put(`/api/lms/lessons/${b}/module`, { module_id: m1 });
    expect((await w.admin.put(`/api/lms/lessons/${a}/module`, { module_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    let s = (await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data; expect(s.lessons.map((l: any) => l.title)).toEqual(['Lesson C', 'Lesson B', 'Lesson A']);       // module one (C, B), then module two (A)
    expect((await w.admin.post(`/api/lms/courses/${c}/modules/reorder`, { ids: [m2, m1] })).status).toBe(200);
    s = (await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data; expect(s.lessons.map((l: any) => l.title)).toEqual(['Lesson A', 'Lesson C', 'Lesson B']);
    expect((await w.admin.post(`/api/lms/courses/${c}/modules/reorder`, { ids: [m2] })).status).toBe(409);
    expect((await w.admin.del(`/api/lms/modules/${m2}`)).status).toBe(200);
    s = (await w.admin.get(`/api/lms/courses/${c}/studio`)).body.data; expect(s.modules.length).toBe(1); expect(s.lessons.find((l: any) => l.title === 'Lesson A').module_id).toBeNull(); expect(s.lessons.length).toBe(3);
  });
  it('lets an author preview a course as a learner sees it, without answers', async () => {
    const c = await mk({}); await les(c, { title: 'Quiz', kind: 'quiz', questions: [{ q: 'One?', options: ['a', 'b'], answer: 1, explanation: 'Because b.' }] });
    const v = (await w.admin.get(`/api/lms/courses/${c}/preview`)).body.data; expect(v.preview).toBe(true); expect(v.lessons[0].questions).toEqual([{ q: 'One?', options: ['a', 'b'] }]); expect(JSON.stringify(v)).not.toContain('Because b.');
    expect((await rv.get(`/api/lms/courses/${c}/preview`)).status).toBe(403);
  });
});

describe('open enrolment, catalog and landing page', () => {
  it('lets people join open courses themselves, but only ones meant for them', async () => {
    const open = await mk({ audience: 'both', title: 'Open robotics' }); await les(c0(open), {}); await w.admin.patch(`/api/lms/courses/${open}/details`, { enrollment_mode: 'open', category: 'Robotics', level: 'beginner' }); await publish(open);
    const staffOnly = await mk({ audience: 'staff', title: 'Staff safety' }); await les(staffOnly, {}); await w.admin.patch(`/api/lms/courses/${staffOnly}/details`, { enrollment_mode: 'open' }); await publish(staffOnly);
    const assigned = await mk({ title: 'Assigned only' }); await les(assigned, {}); await publish(assigned);
    const draft = await mk({ title: 'Secret draft' }); await les(draft, {}); await w.admin.patch(`/api/lms/courses/${draft}/details`, { enrollment_mode: 'open' });
    const cat = await rv.get('/api/learn/catalog'); expect(cat.body.data.map((c: any) => c.title)).toEqual(['Open robotics']); expect(cat.body.meta.categories).toContain('Robotics');
    expect((await acct.get('/api/learn/catalog')).body.data.map((c: any) => c.title).sort()).toEqual(['Open robotics', 'Staff safety']);
    expect((await rv.get('/api/learn/catalog?q=robot')).body.data.length).toBe(1); expect((await rv.get('/api/learn/catalog?q=zzz')).body.data.length).toBe(0);
    expect((await parent.get('/api/learn/catalog')).status).toBe(403);
    expect((await rv.post(`/api/learn/catalog/${assigned}/enrol`)).status).toBe(409); expect((await rv.post(`/api/learn/catalog/${staffOnly}/enrol`)).status).toBe(404); expect((await rv.post(`/api/learn/catalog/${draft}/enrol`)).status).toBe(409);
    expect((await other.admin.get(`/api/learn/catalog/${open}`)).status).toBe(404);
    const land = (await rv.get(`/api/learn/catalog/${open}`)).body.data; expect(land.can_enrol).toBe(true); expect(land.lessons[0]).not.toHaveProperty('body'); expect(land.enrollment).toBeNull();
    expect((await rv.post(`/api/learn/catalog/${open}/enrol`)).status).toBe(201); expect((await rv.post(`/api/learn/catalog/${open}/enrol`)).body.data.already).toBe(true);
    expect((await acct.post(`/api/learn/catalog/${open}/enrol`)).status).toBe(201);
    expect((await rv.get('/api/learn/catalog')).body.data[0].enrolled).toBe(true); expect((await rv.get('/api/learn/my')).body.data.map((c: any) => c.title)).toContain('Open robotics');
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_enrollments WHERE course_id = $1 AND status <> 'removed'`, [open]))!.n)).toBe(2);
    expect((await rv.get(`/api/learn/catalog/${assigned}`)).status).toBe(404);                  // an assigned course is invisible to people who do not have it
  });
});
const c0 = (x: string) => x;

describe('learning rules: sequence, attempts, grade, XP', () => {
  it('unlocks lessons one after another and hides what is still locked', async () => {
    const c = await mk({}); await w.admin.patch(`/api/lms/courses/${c}/details`, { sequential: true });
    const l1 = await les(c, { title: 'First' }), l2 = await les(c, { title: 'Second', body: 'Secret second body' }), l3 = await les(c, { title: 'Third' });
    await publish(c); await give(c, [ravi.id]);
    let v = (await rv.get(`/api/learn/courses/${c}`)).body.data; expect(v.lessons.map((l: any) => l.locked)).toEqual([false, true, true]); expect(v.lessons[1].body).toBeUndefined();
    const early = await done(c, l2); expect(early.status).toBe(409); expect(early.body.error.code).toBe('LOCKED');
    expect((await done(c, l1)).status).toBe(200);
    v = (await rv.get(`/api/learn/courses/${c}`)).body.data; expect(v.lessons.map((l: any) => l.locked)).toEqual([false, false, true]); expect(v.lessons[1].body).toBe('Secret second body');
    await done(c, l2); expect((await done(c, l3)).body.data.course_completed).toBe(true);
  });
  it('limits quiz attempts and only shows the answers when passed or out of tries', async () => {
    const c = await mk({}); const q = await les(c, { title: 'Quiz', kind: 'quiz', max_attempts: 2, pass_percent: 100, questions: [{ q: 'Capital?', options: ['Delhi', 'Paris'], answer: 0, explanation: 'Delhi is the capital of India.' }] });
    await publish(c); await give(c, [ravi.id]);
    const a1 = await done(c, q, { answers: [1] }); expect(a1.body.data).toMatchObject({ passed: false, attempts_left: 1, review: null });
    const a2 = await done(c, q, { answers: [1] }); expect(a2.body.data).toMatchObject({ passed: false, attempts_left: 0 }); expect(a2.body.data.review).toEqual([{ correct: 0, explanation: 'Delhi is the capital of India.', yours: 1 }]);
    const a3 = await done(c, q, { answers: [0] }); expect(a3.status).toBe(409); expect(a3.body.error.code).toBe('NO_ATTEMPTS');
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_attempts a JOIN lms_enrollments e ON e.id = a.enrollment_id WHERE e.learner_id = $1 AND a.lesson_id = $2`, [ravi.id, q]))!.n)).toBe(2);
    const c2 = await mk({}); const q2 = await les(c2, { title: 'Quiz', kind: 'quiz', pass_percent: 100, questions: [{ q: 'Two plus two?', options: ['4', '5'], answer: 0, explanation: 'Basic sums.' }] }); await publish(c2); await give(c2, [ravi.id]);
    expect((await done(c2, q2, { answers: [0] })).body.data.review[0]).toMatchObject({ correct: 0, explanation: 'Basic sums.' });
    const cl = (await rv.get(`/api/learn/courses/${c2}`)).body.data; expect(JSON.stringify(cl)).not.toContain('Basic sums.');
  });
  it('needs the minimum grade to finish, and gives XP once when it does', async () => {
    const c = await mk({}); await w.admin.patch(`/api/lms/courses/${c}/details`, { min_grade: 90, xp_reward: 40 }); await w.admin.patch(`/api/lms/courses/${c}`, { certificate_design_id: design });
    const q = await les(c, { title: 'Quiz', kind: 'quiz', pass_percent: 50, questions: [{ q: 'A?', options: ['y', 'n'], answer: 0 }, { q: 'B?', options: ['y', 'n'], answer: 0 }] }); await publish(c); await give(c, [ravi.id]);
    const first = (await done(c, q, { answers: [0, 1] })).body.data; expect(first).toMatchObject({ passed: true, score: 50, course_completed: false, needs_grade: true, min_grade: 90 });
    const second = (await done(c, q, { answers: [0, 0] })).body.data; expect(second).toMatchObject({ score: 100, just_completed: true }); expect(second.certificate_code).toBeTruthy();
    const xp = await query(`SELECT points FROM xp_transactions WHERE learner_id = $1 AND source_type = 'lms' AND source_id = $2`, [ravi.id, c]); expect(xp.map((x) => Number(x.points))).toEqual([40]);
    await done(c, q, { answers: [0, 0] }); expect((await query(`SELECT 1 FROM xp_transactions WHERE learner_id = $1 AND source_type = 'lms' AND source_id = $2`, [ravi.id, c])).length).toBe(1);
    const rec = (await rv.get('/api/learn/record')).body.data; const mine = rec.courses.find((x: any) => x.course_id === c); expect(mine).toMatchObject({ grade: 100 }); expect(mine.certificate_code).toMatch(/^RKC-/);
  });
});

describe('assignments, files and notes', () => {
  it('has a reviewer accept or return handed-in work', async () => {
    const c = await mk({}); const a = await les(c, { title: 'Build it', kind: 'assignment', body: 'Build a line follower and describe it.', auto_accept: false }); await publish(c); await give(c, [ravi.id]);
    expect((await rv.post(`/api/learn/courses/${c}/lessons/${a}/submit`, {})).status).toBe(400); expect((await done(c, a)).status).toBe(400);
    const up = await upload(raviToken, 'photo.pdf', PDF); const sub = await rv.post(`/api/learn/courses/${c}/lessons/${a}/submit`, { body: 'It follows a black line.', file_ids: [up.body.data.id] }); expect(sub.status).toBe(201); expect(sub.body.data).toMatchObject({ status: 'submitted', course_completed: false });
    const q = (await w.admin.get('/api/lms/submissions')).body.data.find((x: any) => x.lesson === 'Build it'); expect(q).toMatchObject({ name: 'Ravi Kumar', status: 'submitted' }); expect(q.files.length).toBe(1);
    expect((await t1.post(`/api/lms/submissions/${q.id}/review`, { decision: 'accept' })).status).toBe(403);
    expect((await w.admin.post(`/api/lms/submissions/${q.id}/review`, { decision: 'return' })).status).toBe(400);
    expect((await w.admin.post(`/api/lms/submissions/${q.id}/review`, { decision: 'return', feedback: 'Please add a photo of the wheels.' })).status).toBe(200);
    expect((await rv.get(`/api/learn/courses/${c}`)).body.data.lessons[0].submission).toMatchObject({ status: 'returned', feedback: 'Please add a photo of the wheels.' });
    expect(await queryOne(`SELECT 1 FROM notifications WHERE learner_id = $1 AND kind = 'lms.review' AND title LIKE 'Please revise%'`, [ravi.id])).toBeTruthy();
    expect((await rv.post(`/api/learn/courses/${c}/lessons/${a}/submit`, { body: 'Now with a photo.' })).status).toBe(201);
    const q2 = (await w.admin.get('/api/lms/submissions')).body.data.find((x: any) => x.lesson === 'Build it');
    const acc = await w.admin.post(`/api/lms/submissions/${q2.id}/review`, { decision: 'accept', feedback: 'Great work!' }); expect(acc.body.data).toMatchObject({ decision: 'accept', course_completed: true });
    expect((await rv.post(`/api/learn/courses/${c}/lessons/${a}/submit`, { body: 'again' })).status).toBe(409);
    expect((await w.admin.get('/api/lms/submissions?status=accepted')).body.data.length).toBeGreaterThan(0);
  });
  it('accepts at once when the lesson says so, and guards lesson and submission files', async () => {
    const c = await mk({}); const a = await les(c, { title: 'Quick task', kind: 'assignment', body: 'Tell us one thing.', auto_accept: true }); const f = await les(c, { title: 'Worksheet', kind: 'file', body: null });
    const adm = await login(w.adminEmail); const fa = await upload(adm, 'sheet.pdf', PDF); await w.admin.put(`/api/lms/lessons/${f}/files`, { file_ids: [fa.body.data.id] }); await publish(c); await give(c, [ravi.id]);
    expect((await rv.get(`/api/files/${fa.body.data.id}`)).status).toBe(200);            // enrolled: can download
    expect((await out.get(`/api/files/${fa.body.data.id}`)).status).toBe(404);            // not enrolled: cannot
    const v = (await rv.get(`/api/learn/courses/${c}`)).body.data; expect(v.lessons.find((l: any) => l.id === f).files[0]).toMatchObject({ name: 'sheet.pdf' });
    expect((await done(c, f)).status).toBe(200);
    const up = await upload(raviToken, 'mine.pdf', PDF); const s = await rv.post(`/api/learn/courses/${c}/lessons/${a}/submit`, { body: 'Robots are fun.', file_ids: [up.body.data.id] }); expect(s.body.data).toMatchObject({ status: 'accepted', just_completed: true });
    expect((await w.admin.get(`/api/files/${up.body.data.id}`)).status).toBe(200);        // the reviewer sees the work
    expect((await mn.get(`/api/files/${up.body.data.id}`)).status).toBe(404);             // a classmate does not
  });
  it('keeps private notes per lesson', async () => {
    const c = await mk({}); const l = await les(c, {}); await publish(c); await give(c, [ravi.id, meena.id]);
    expect((await rv.put(`/api/learn/courses/${c}/lessons/${l}/notes`, { body: 'Remember the sensor wiring.' })).status).toBe(200);
    expect((await rv.get(`/api/learn/courses/${c}/notes`)).body.data).toMatchObject([{ lesson_id: l, body: 'Remember the sensor wiring.' }]); expect((await mn.get(`/api/learn/courses/${c}/notes`)).body.data).toEqual([]);
    await rv.put(`/api/learn/courses/${c}/lessons/${l}/notes`, { body: '  ' }); expect((await rv.get(`/api/learn/courses/${c}/notes`)).body.data).toEqual([]);
  });
});

describe('reviews, discussion, announcements, nudges', () => {
  let c = ''; let l1 = ''; let l2 = '';
  beforeAll(async () => { c = await mk({ audience: 'both', title: 'Social course' }); l1 = await les(c, { title: 'One' }); l2 = await les(c, { title: 'Two' }); await w.admin.patch(`/api/lms/courses/${c}/details`, { enrollment_mode: 'open' }); await publish(c); await give(c, [ravi.id, meena.id]); });
  it('lets people rate a course once they are half way, and hides rude reviews', async () => {
    expect((await rv.get(`/api/learn/courses/${c}/review`)).body.data.eligible).toBe(false); expect((await rv.put(`/api/learn/courses/${c}/review`, { rating: 5 })).status).toBe(409);
    await done(c, l1); expect((await rv.get(`/api/learn/courses/${c}/review`)).body.data.eligible).toBe(true);
    expect((await rv.put(`/api/learn/courses/${c}/review`, { rating: 6 })).status).toBe(400);
    expect((await rv.put(`/api/learn/courses/${c}/review`, { rating: 5, comment: 'Loved the robots!' })).status).toBe(200); await rv.put(`/api/learn/courses/${c}/review`, { rating: 4, comment: 'Loved the robots!' });
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_reviews WHERE course_id = $1`, [c]))!.n)).toBe(1);
    expect((await out.put(`/api/learn/courses/${c}/review`, { rating: 1 })).status).toBe(404);
    const land = (await rv.get(`/api/learn/catalog/${c}`)).body.data; expect(land.rating).toEqual({ avg: 4, count: 1 }); expect(land.reviews[0]).toMatchObject({ comment: 'Loved the robots!', name: 'Ravi' });   // a child shows by first name
    const list = (await w.admin.get(`/api/lms/courses/${c}/reviews`)).body.data; expect((await t1.post(`/api/lms/reviews/${list[0].id}/hide`)).status).toBe(403);
    expect((await w.admin.post(`/api/lms/reviews/${list[0].id}/hide`)).status).toBe(200); expect((await rv.get(`/api/learn/catalog/${c}`)).body.data.reviews).toEqual([]);
  });
  it('runs a course discussion with staff answers, notifications and moderation', async () => {
    expect((await out.get(`/api/learn/courses/${c}/discussions`)).status).toBe(404); expect((await rv.post(`/api/learn/courses/${c}/discussions`, { title: 'Hi', body: 'x' })).status).toBe(400);
    const d = (await rv.post(`/api/learn/courses/${c}/discussions`, { title: 'How do I wire the sensor?', body: 'I am stuck on lesson two.', lesson_id: l2 })).body.data.id;
    const list = (await mn.get(`/api/learn/courses/${c}/discussions`)).body.data; expect(list[0]).toMatchObject({ title: 'How do I wire the sensor?', name: 'Ravi', staff: false, replies: 0 });
    expect((await w.admin.post(`/api/learn/discussions/${d}/replies`, { body: 'Connect the signal pin to A0.' })).status).toBe(201);
    expect((await mn.post(`/api/learn/discussions/${d}/replies`, { body: 'Same here, thanks!' })).status).toBe(201);
    const det = (await rv.get(`/api/learn/discussions/${d}`)).body.data; expect(det.replies.map((r: any) => [r.staff, r.body])).toEqual([[true, 'Connect the signal pin to A0.'], [false, 'Same here, thanks!']]); expect(det.replies[1].name).toBe('Meena');
    expect(await queryOne(`SELECT 1 FROM notifications WHERE user_id = (SELECT user_id FROM learners WHERE id = $1) AND kind = 'lms.reply'`, [ravi.id])).toBeTruthy();
    expect((await rv.post(`/api/lms/discussions/${d}/resolve`)).status).toBe(403); expect((await w.admin.post(`/api/lms/discussions/${d}/resolve`)).status).toBe(200); expect((await w.admin.post(`/api/lms/discussions/${d}/pin`)).status).toBe(200);
    expect((await rv.get(`/api/learn/courses/${c}/discussions`)).body.data[0]).toMatchObject({ resolved: true, pinned: true, replies: 2 });
    const rid = det.replies[1].id; expect((await w.admin.post(`/api/lms/replies/${rid}/hide`)).status).toBe(200); expect((await rv.get(`/api/learn/discussions/${d}`)).body.data.replies.length).toBe(1);
    expect((await w.admin.post(`/api/lms/discussions/${d}/hide`)).status).toBe(200); expect((await mn.get(`/api/learn/discussions/${d}`)).status).toBe(404); expect((await mn.get(`/api/learn/courses/${c}/discussions`)).body.data.length).toBe(0);
    expect((await out.get(`/api/learn/discussions/${d}`)).status).toBe(404);
  });
  it('announces to everyone on the course, and nudges the people who have not started once a day', async () => {
    expect((await t1.post(`/api/lms/courses/${c}/announcements`, { title: 'Hello', body: 'Welcome' })).status).toBe(403);
    const a = await w.admin.post(`/api/lms/courses/${c}/announcements`, { title: 'New week', body: 'A new lesson is up.' }); expect(a.status).toBe(201); expect(a.body.data.notified).toBeGreaterThanOrEqual(2);
    expect(await queryOne(`SELECT 1 FROM notifications WHERE learner_id = $1 AND kind = 'lms.announcement'`, [meena.id])).toBeTruthy(); expect(await queryOne(`SELECT 1 FROM notifications WHERE learner_id = $1 AND kind = 'lms.announcement'`, [outsider.id])).toBeFalsy();
    expect((await mn.get(`/api/learn/courses/${c}/announcements`)).body.data[0]).toMatchObject({ title: 'New week' });
    const n1 = await w.admin.post(`/api/lms/courses/${c}/nudge`, { who: 'not_started' }); expect(n1.body.data.notified).toBe(1);        // Meena has not started; Ravi has
    expect(await queryOne(`SELECT 1 FROM notifications WHERE learner_id = $1 AND kind = 'lms.nudge'`, [meena.id])).toBeTruthy();
    expect((await w.admin.post(`/api/lms/courses/${c}/nudge`, { who: 'nobody' })).status).toBe(400);
  });
  it('shows where people drop off and which questions trip them up', async () => {
    const q = await mk({}); const a = await les(q, { title: 'Intro' }); const z = await les(q, { title: 'Test', kind: 'quiz', pass_percent: 50, questions: [{ q: 'Easy?', options: ['y', 'n'], answer: 0 }, { q: 'Hard?', options: ['y', 'n'], answer: 1 }] });
    await publish(q); await give(q, [ravi.id, meena.id]); await done(q, a); await done(q, z, { answers: [0, 0] });
    await client(await login(meena.email)).post(`/api/learn/courses/${q}/lessons/${a}/complete`, {});
    const an = (await w.admin.get(`/api/lms/courses/${q}/analytics`)).body.data; expect(an).toMatchObject({ enrolled: 2, started: 2, completed: 1 });
    expect(an.lessons[0]).toMatchObject({ title: 'Intro', completed: 2, percent: 100 }); expect(an.lessons[1]).toMatchObject({ title: 'Test', completed: 1, percent: 50, tries: 1 });
    expect(an.lessons[1].questions).toEqual([{ q: 'Easy?', answered: 1, percent_correct: 100 }, { q: 'Hard?', answered: 1, percent_correct: 0 }]);
    expect((await rv.get(`/api/lms/courses/${q}/analytics`)).status).toBe(403); expect((await other.admin.get(`/api/lms/courses/${q}/analytics`)).status).toBe(404);
  });
  it('copies a whole course into a new draft, files included', async () => {
    const src = await mk({ title: 'Original' }); await w.admin.patch(`/api/lms/courses/${src}/details`, { category: 'Robotics', outcomes: ['One thing'] });
    const m = (await w.admin.post(`/api/lms/courses/${src}/modules`, { title: 'Week 1' })).body.data.id; const f = await les(src, { title: 'Sheet', kind: 'file', body: null }); await w.admin.put(`/api/lms/lessons/${f}/module`, { module_id: m });
    const up = await upload(await login(w.adminEmail), 'copy.pdf', PDF); await w.admin.put(`/api/lms/lessons/${f}/files`, { file_ids: [up.body.data.id] }); await les(src, { title: 'Quiz', kind: 'quiz', questions: [{ q: 'Q?', options: ['a', 'b'], answer: 0 }] });
    expect((await t1.post(`/api/lms/courses/${src}/duplicate`)).status).toBe(403);
    const cp = (await w.admin.post(`/api/lms/courses/${src}/duplicate`)).body.data.id; const s = (await w.admin.get(`/api/lms/courses/${cp}/studio`)).body.data;
    expect(s.course).toMatchObject({ title: 'Copy of Original', status: 'draft', category: 'Robotics', outcomes: ['One thing'] }); expect(s.modules.map((x: any) => x.title)).toEqual(['Week 1']); expect(s.lessons.map((l: any) => l.title)).toEqual(['Quiz', 'Sheet']);
    const sheet = s.lessons.find((l: any) => l.title === 'Sheet'); expect(sheet.files.length).toBe(1); expect(sheet.files[0].id).not.toBe(up.body.data.id); expect(sheet.module_id).toBe(s.modules[0].id); expect(s.lessons.find((l: any) => l.title === 'Quiz').questions[0].q).toBe('Q?');
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_enrollments WHERE course_id = $1`, [cp]))!.n)).toBe(0);
  });
});
void exec;
