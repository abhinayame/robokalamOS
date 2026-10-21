import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

const png = (b: Buffer) => ({ ok: b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
const bin = (res: any, cb: any) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); };
const H = 3600_000;
let w: World, other: World; let ravi: any, meena: any, outsider: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, parent: ReturnType<typeof client>, acct: ReturnType<typeof client>;
let design = ''; let staffEmail = ''; let staffC: ReturnType<typeof client>;

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  ravi = await newLearner(w, { full_name: 'Ravi Kumar', email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Ravi Parent', mobile: '9870000021', email: `rp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA] });
  meena = await newLearner(w, { full_name: 'Meena Rao', email: `meena-${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
  outsider = await newLearner(w, { full_name: 'Out Sider', email: `out-${uniq()}@kids.test`, batch_ids: [w.batches.pyB] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD }); await w.admin.post(`/api/learners/${meena.id}/login`, { password: PASSWORD });
  t1 = client(await login(w.teachers.t1.email)); t2 = client(await login(w.teachers.t2.email)); rv = client(await login(ravi.email)); mn = client(await login(meena.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id; parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
  staffEmail = `acct-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Staff Sam', email: staffEmail, password: PASSWORD, roles: [{ role: 'accountant' }] }); staffC = client(await login(staffEmail)); acct = staffC;
  design = (await w.admin.post('/api/certificates/designs', { name: 'Std', title_text: 'Certificate of Completion', body_text: 'has completed {course_name} ({batch_name}) on {date}.', signatory_name: 'Dr. Rao', signatory_title: 'Director' })).body.data.id;
});

describe('certificate templates and automatic issue', () => {
  it('has five looks, each a valid PDF; the choice is validated and previewable', async () => {
    for (const t of ['classic', 'modern', 'playful', 'minimal', 'midnight']) {
      const r = await w.admin.get(`/api/certificates/designs/${design}/preview.pdf?template=${t}&accent=%237a1f3d`).buffer(true).parse(bin);
      expect(r.status, t).toBe(200); expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-'); expect((r.body as Buffer).length).toBeGreaterThan(2000);
    }
    expect((await w.admin.get(`/api/certificates/designs/${design}/preview.pdf?template=neon`)).status).toBe(400);
    expect((await w.admin.post('/api/certificates/designs', { name: 'Bad', body_text: 'has completed {course_name}.', template: 'neon' })).status).toBe(400);
    expect((await w.admin.post('/api/certificates/designs', { name: 'Bad2', body_text: 'has completed {course_name}.', accent: 'red' })).status).toBe(400);
    expect((await other.admin.get(`/api/certificates/designs/${design}/preview.pdf`)).status).toBe(404);
  });
  it('freezes the template at issue time', async () => {
    const d2 = (await w.admin.post('/api/certificates/designs', { name: 'Midnight gold', title_text: 'Achievement', body_text: 'has completed {course_name}.', template: 'midnight', accent: '#d9b25e' })).body.data.id;
    const go = await w.admin.post('/api/certificates/issue', { design_id: d2, selector: { learner_ids: [ravi.id] }, confirm: true }); expect(go.status).toBe(201);
    const row = await queryOne(`SELECT template, accent FROM certificates WHERE learner_id = $1 AND design_id = $2`, [ravi.id, d2]); expect(row).toMatchObject({ template: 'midnight', accent: '#d9b25e' });
    await w.admin.put(`/api/certificates/designs/${d2}`, { name: 'Midnight gold', title_text: 'Achievement', body_text: 'has completed {course_name}.', template: 'playful', status: 'active' });
    expect((await queryOne(`SELECT template FROM certificates WHERE learner_id = $1 AND design_id = $2`, [ravi.id, d2]))!.template).toBe('midnight');
  });
  it('a batch with a chosen certificate hands it out by itself when it is completed, once', async () => {
    const batch = (await w.admin.post('/api/batches', { name: `Auto ${uniq()}`, program_id: w.program, course_id: w.courseRobotics, academic_year: '2026-27', status: 'active', capacity: 10 })).body.data.id;
    const a = await newLearner(w, { full_name: 'Auto One', batch_ids: [batch] }); const b2 = await newLearner(w, { full_name: 'Auto Two', batch_ids: [batch] });
    expect((await t2.put(`/api/certificates/automation/${batch}`, { design_id: design })).status).toBe(403);
    expect((await w.admin.put(`/api/certificates/automation/${batch}`, { design_id: design })).status).toBe(200);
    expect((await other.admin.put(`/api/certificates/automation/${batch}`, { design_id: design })).status).toBe(404);
    expect((await w.admin.get('/api/certificates/automation')).body.data.find((x: any) => x.id === batch)).toMatchObject({ design_id: design });
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM certificates WHERE batch_id = $1`, [batch]))!.n)).toBe(0);
    expect((await w.admin.patch(`/api/batches/${batch}`, { status: 'completed' })).status).toBe(200);
    const certs = await query(`SELECT recipient_name, body, batch_name FROM certificates WHERE batch_id = $1 ORDER BY recipient_name`, [batch]);
    expect(certs.map((c) => c.recipient_name)).toEqual(['Auto One', 'Auto Two']); expect(certs[0]!.body).toContain('Robotics'); expect(certs[0]!.body).not.toContain('()');
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'certificate.auto_issued' AND entity_id = $1`, [batch])).toBeTruthy();
    await w.admin.patch(`/api/batches/${batch}`, { status: 'active' }); await w.admin.patch(`/api/batches/${batch}`, { status: 'completed' });
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM certificates WHERE batch_id = $1`, [batch]))!.n)).toBe(2);       // completing again gives nobody a second one
    void a; void b2;
  });
});

describe('LMS: courses, assignment, learning, tracking', () => {
  let course = ''; let quiz = ''; let l1 = ''; let l2 = ''; let l3 = '';
  const lesson = (body: object) => w.admin.post(`/api/lms/courses/${course}/lessons`, body);
  it('only admins author; lessons are validated; a course needs a required lesson to publish', async () => {
    expect((await t1.post('/api/lms/courses', { title: 'Nope' })).status).toBe(403); expect((await rv.get('/api/lms/courses')).status).toBe(403);
    const c = await w.admin.post('/api/lms/courses', { title: 'Robotics basics', summary: 'Start here', audience: 'both', certificate_design_id: design }); expect(c.status).toBe(201); course = c.body.data.id;
    expect((await w.admin.post('/api/lms/courses', { title: 'X', certificate_design_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await w.admin.patch(`/api/lms/courses/${course}`, { status: 'published' })).status).toBe(400);
    expect((await lesson({ title: 'Video', kind: 'video' })).status).toBe(400); expect((await lesson({ title: 'Video', kind: 'video', url: 'http://insecure.example/v' })).status).toBe(400);
    expect((await lesson({ title: 'Quiz', kind: 'quiz', questions: [] })).status).toBe(400); expect((await lesson({ title: 'Quiz', kind: 'quiz', questions: [{ q: 'Pick one', options: ['a', 'b'], answer: 5 }] })).status).toBe(400);
    l1 = (await lesson({ title: 'What is a robot?', kind: 'text', body: 'A robot senses, thinks and acts.', minutes: 5 })).body.data.id;
    l2 = (await lesson({ title: 'Watch: sensors', kind: 'video', url: 'https://youtu.be/abc', minutes: 8 })).body.data.id;
    quiz = (await lesson({ title: 'Check yourself', kind: 'quiz', pass_percent: 60, questions: [{ q: 'What does a sensor do?', options: ['Moves', 'Senses', 'Sleeps'], answer: 1 }, { q: 'A motor...', options: ['Senses light', 'Makes things move'], answer: 1 }, { q: 'Two plus two', options: ['3', '4', '5'], answer: 1 }] })).body.data.id;
    l3 = (await lesson({ title: 'Optional reading', kind: 'link', url: 'https://example.com/read', required: false })).body.data.id;
    expect((await w.admin.post(`/api/lms/courses/${course}/lessons/reorder`, { ids: [l2, l1, quiz, l3] })).status).toBe(200);
    expect((await w.admin.post(`/api/lms/courses/${course}/lessons/reorder`, { ids: [l1] })).status).toBe(409);
    expect((await w.admin.patch(`/api/lms/courses/${course}`, { status: 'published' })).status).toBe(200);
    const detail = (await w.admin.get(`/api/lms/courses/${course}`)).body.data; expect(detail.lessons.map((l: any) => l.id)).toEqual([l2, l1, quiz, l3]); expect(detail.lessons[2].questions[0].answer).toBe(1);   // managers see the answers
  });
  it('assigns to learners and staff with a preview, never twice, respecting audience', async () => {
    const sel = { learner_ids: [ravi.id, meena.id] };
    expect((await w.admin.post(`/api/lms/courses/${course}/assign`, { selector: sel })).status).toBe(400);              // no confirmation
    expect((await w.admin.post(`/api/lms/courses/${course}/assign`, {})).status).toBe(400);
    const staffId = (await queryOne(`SELECT id FROM users WHERE email = $1`, [staffEmail]))!.id;
    const dry = await w.admin.post(`/api/lms/courses/${course}/assign`, { selector: sel, user_ids: [staffId], dry_run: true }); expect(dry.body.data, JSON.stringify(dry.body)).toMatchObject({ learners: { to_assign: 2 }, staff: { to_assign: 1 } });
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM lms_enrollments WHERE course_id = $1`, [course]))!.n)).toBe(0);
    const go = await w.admin.post(`/api/lms/courses/${course}/assign`, { selector: sel, user_ids: [staffId], confirm: true, due_at: new Date(Date.now() + 7 * 24 * H).toISOString() }); expect(go.status).toBe(201);
    expect((await w.admin.post(`/api/lms/courses/${course}/assign`, { selector: sel, user_ids: [staffId], confirm: true })).body.data).toMatchObject({ learners: { to_assign: 0, already: 2 }, staff: { to_assign: 0, already: 1 } });
    expect((await w.admin.post(`/api/lms/courses/${course}/assign`, { selector: sel, confirm: true, due_at: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect(await queryOne(`SELECT 1 FROM notifications WHERE kind = 'lms.assigned' AND user_id = $1`, [staffId])).toBeTruthy();
    const d = (await w.admin.post('/api/lms/courses', { title: 'Draft only' })).body.data.id; expect((await w.admin.post(`/api/lms/courses/${d}/assign`, { selector: sel, confirm: true })).status).toBe(409);
    const learnersOnly = (await w.admin.post('/api/lms/courses', { title: 'Kids only', audience: 'learners' })).body.data.id; await w.admin.post(`/api/lms/courses/${learnersOnly}/lessons`, { title: 'Lesson one', kind: 'text', body: 'text' }); await w.admin.patch(`/api/lms/courses/${learnersOnly}`, { status: 'published' });
    expect((await w.admin.post(`/api/lms/courses/${learnersOnly}/assign`, { all_staff: true, confirm: true })).status).toBe(400);
    expect((await other.admin.post(`/api/lms/courses/${course}/assign`, { selector: sel, confirm: true })).status).toBe(404);
  });
  it('a learner sees only their own courses, never the quiz answers, and finishing earns the certificate', async () => {
    const my = (await rv.get('/api/learn/my')).body.data; expect(my).toHaveLength(1); expect(my[0]).toMatchObject({ title: 'Robotics basics', percent: 0, gives_certificate: true });
    const view = (await rv.get(`/api/learn/courses/${course}`)).body.data; expect(JSON.stringify(view)).not.toContain('"answer"'); expect(view.lessons).toHaveLength(4);
    expect((await parent.get('/api/learn/my')).body.data).toHaveLength(0);                                              // a parent does not take the course
    expect((await rv.get(`/api/learn/courses/${(await w.admin.post('/api/lms/courses', { title: 'Unassigned' })).body.data.id}`)).status).toBe(404);
    expect((await rv.post(`/api/learn/courses/${course}/lessons/${l1}/complete`, {})).body.data).toMatchObject({ passed: true, percent: 33, course_completed: false });
    expect((await rv.post(`/api/learn/courses/${course}/lessons/${quiz}/complete`, {})).status).toBe(400);               // quiz needs answers
    const fail = (await rv.post(`/api/learn/courses/${course}/lessons/${quiz}/complete`, { answers: [0, 0, 0] })).body.data; expect(fail).toMatchObject({ passed: false, score: 0, percent: 33 });
    expect((await rv.post(`/api/learn/courses/${course}/lessons/${l2}/complete`, {})).body.data.percent).toBe(67);
    const win = (await rv.post(`/api/learn/courses/${course}/lessons/${quiz}/complete`, { answers: [1, 1, 0] })).body.data; expect(win).toMatchObject({ passed: true, score: 67, course_completed: true, just_completed: true }); expect(win.certificate_code).toMatch(/^RKC-/);
    const again = (await rv.post(`/api/learn/courses/${course}/lessons/${quiz}/complete`, { answers: [1, 1, 1] })).body.data; expect(again.just_completed).toBe(false); expect(again.certificate_code).toBeNull();
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM certificates WHERE learner_id = $1 AND course_name = 'Robotics basics'`, [ravi.id]))!.n)).toBe(1);
    const cert = await queryOne(`SELECT body FROM certificates WHERE learner_id = $1 AND course_name = 'Robotics basics'`, [ravi.id]); expect(cert!.body).toContain('Robotics basics'); expect(cert!.body).not.toContain('()');
    expect((await mn.get('/api/learn/my')).body.data[0].percent).toBe(0);                                                // classmates are independent
    expect((await rv.post(`/api/learn/courses/${course}/lessons/${l1}/complete`, {})).status).toBe(200);                // re-doing a finished lesson is harmless
  });
  it('staff can onboard through the same course, without a certificate', async () => {
    const my = (await staffC.get('/api/learn/my')).body.data; expect(my[0]).toMatchObject({ title: 'Robotics basics', gives_certificate: false });
    for (const lid of [l1, l2]) await staffC.post(`/api/learn/courses/${course}/lessons/${lid}/complete`, {});
    const done = (await staffC.post(`/api/learn/courses/${course}/lessons/${quiz}/complete`, { answers: [1, 1, 1] })).body.data; expect(done).toMatchObject({ course_completed: true, certificate_code: null });
    expect((await t1.get('/api/learn/my')).body.data).toHaveLength(0);                                                  // someone not enrolled sees nothing
  });
  it('managers track everyone: completion, overdue, export; others cannot', async () => {
    const pr = (await w.admin.get(`/api/lms/courses/${course}/progress`)).body.data;
    expect(pr.summary).toMatchObject({ enrolled: 3, completed: 2, not_started: 1 }); expect(pr.rows.find((r: any) => r.name === 'Ravi Kumar')).toMatchObject({ percent: 100, status: 'completed', kind: 'learner' }); expect(pr.rows.find((r: any) => r.kind === 'staff')).toMatchObject({ percent: 100 });
    expect(pr.rows.find((r: any) => r.name === 'Meena Rao')).toMatchObject({ percent: 0, done: 0 });
    await exec(`UPDATE lms_enrollments SET due_at = DATE_SUB(NOW(3), INTERVAL 2 DAY) WHERE course_id = $1 AND learner_id = $2`, [course, meena.id]);
    expect((await w.admin.get(`/api/lms/courses/${course}/progress`)).body.data.summary.overdue).toBe(1); expect((await mn.get('/api/learn/my')).body.data[0].overdue).toBe(true);
    const csv = await w.admin.get(`/api/lms/courses/${course}/progress.csv`); expect(csv.status).toBe(200); expect(csv.text).toContain('Ravi Kumar'); expect(csv.headers['content-type']).toContain('text/csv');
    expect((await t1.get(`/api/lms/courses/${course}/progress`)).status).toBe(403); expect((await other.admin.get(`/api/lms/courses/${course}/progress`)).status).toBe(404);
    const list = (await w.admin.get('/api/lms/courses')).body.data.find((c: any) => c.id === course); expect(list).toMatchObject({ lessons: 4 }); expect(Number(list.enrolled)).toBe(3);
  });
  it('removing an enrollment takes the course away; deleting a lesson keeps history', async () => {
    const enr = (await w.admin.get(`/api/lms/courses/${course}/progress`)).body.data.rows.find((r: any) => r.name === 'Meena Rao').id;
    expect((await t1.del(`/api/lms/enrollments/${enr}`)).status).toBe(403); expect((await w.admin.del(`/api/lms/enrollments/${enr}`)).status).toBe(200);
    expect((await mn.get('/api/learn/my')).body.data).toHaveLength(0); expect((await mn.get(`/api/learn/courses/${course}`)).status).toBe(404);
    expect((await w.admin.del(`/api/lms/lessons/${l3}`)).status).toBe(200); expect((await w.admin.get(`/api/lms/courses/${course}`)).body.data.lessons).toHaveLength(3);
    expect((await w.admin.post(`/api/lms/courses/${course}/assign`, { selector: { learner_ids: [meena.id] }, confirm: true })).body.data.learners.to_assign).toBe(1);   // can be assigned again
  });
});

describe('share cards', () => {
  let badgeId = ''; let certId = ''; let itemId = '';
  beforeAll(async () => {
    const b = (await w.admin.post('/api/gamification/badges', { name: 'Sensor Star', icon: '⭐', xp_reward: 10 })).body.data.id;
    await t1.post(`/api/gamification/badges/${b}/award`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], reason: 'Great job' });
    badgeId = (await rv.get('/api/gamification/achievements')).body.data[0].id;
    await t1.post('/api/gamification/xp', { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: 120, reason: 'Participation' });
    certId = (await w.admin.get(`/api/certificates?learner_id=${ravi.id}`)).body.data[0].id;
    const up = await request(app).post('/api/files?name=robot.png').set('Authorization', `Bearer ${await login(ravi.email)}`).set('Content-Type', 'application/octet-stream').send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
    itemId = (await rv.post('/api/portfolio', { title: 'My robot', file_ids: [up.body.data.id] })).body.data.id;
  });
  const card = (c: ReturnType<typeof client>, path: string) => c.get(path).buffer(true).parse(bin);
  it('draws a PNG for a badge, XP, a certificate and a project, in both formats', async () => {
    for (const [path, h] of [[`/api/share/cards/badge/${badgeId}.png`, 1920], [`/api/share/cards/badge/${badgeId}.png?format=square`, 1080], [`/api/share/cards/xp/${ravi.id}.png`, 1920], [`/api/share/cards/certificate/${certId}.png?format=square&name=short`, 1080]] as const) {
      const r = await card(rv, path); expect(r.status, path).toBe(200); expect(r.headers['content-type']).toBe('image/png'); const d = png(r.body as Buffer); expect(d).toMatchObject({ ok: true, w: 1080, h }); expect((r.body as Buffer).length).toBeGreaterThan(20_000);
    }
    expect((await card(parent, `/api/share/cards/xp/${ravi.id}.png`)).status).toBe(200);                                 // a parent can share their child's
    expect((await card(w.admin, `/api/share/cards/badge/${badgeId}.png`)).status).toBe(200);
  });
  it('is private and honest', async () => {
    expect((await card(mn, `/api/share/cards/xp/${ravi.id}.png`)).status).toBe(404);                                   // not someone else's child
    expect((await card(mn, `/api/share/cards/badge/${badgeId}.png`)).status).toBe(404);
    expect((await card(other.admin, `/api/share/cards/certificate/${certId}.png`)).status).toBe(404);
    expect((await rv.get(`/api/share/cards/xp/${ravi.id}.png?format=banner`)).status).toBe(400); expect((await rv.get(`/api/share/cards/xp/${ravi.id}.png?name=full`)).status).toBe(400); expect((await rv.get(`/api/share/cards/poster/${ravi.id}.png`)).status).toBe(400);
    expect((await request(app).get(`/api/share/cards/xp/${ravi.id}.png`)).status).toBe(401);
    expect((await rv.get(`/api/share/cards/project/${itemId}.png`)).status).toBe(409);                                  // still waiting for a teacher
    await t1.post(`/api/portfolio/${itemId}/review`, { decision: 'approve' });
    expect((await card(rv, `/api/share/cards/project/${itemId}.png`)).status).toBe(200);
    await w.admin.post(`/api/certificates/${certId}/revoke`, { reason: 'Issued in error' }); expect((await rv.get(`/api/share/cards/certificate/${certId}.png`)).status).toBe(409);
  });
});

describe('timetable', () => {
  it('shows the week to whoever may see it and nobody else', async () => {
    const mk = async (batch: string, title: string, hours: number) => { const id = (await w.admin.post(`/api/classrooms/${batch}/sessions`, { title, starts_at: new Date(Date.now() + 500 * 24 * H + hours * 100_000).toISOString(), ends_at: new Date(Date.now() + 500 * 24 * H + hours * 100_000 + H).toISOString() })).body.data.id; await exec(`UPDATE class_sessions SET starts_at = DATE_ADD(NOW(3), INTERVAL ${hours} HOUR), ends_at = DATE_ADD(NOW(3), INTERVAL ${hours + 1} HOUR) WHERE id = $1`, [id]); return id; };
    await mk(w.batches.roboA, 'Robotics today', 1); await mk(w.batches.pyB, 'Python today', 2);
    const wk = (c: ReturnType<typeof client>) => c.get('/api/timetable/week');
    const mine = (await wk(rv)).body.data; expect(mine.sessions.map((s: any) => s.title)).toEqual(expect.arrayContaining(['Robotics today'])); expect(mine.sessions.map((s: any) => s.title)).not.toContain('Python today'); expect(mine).toMatchObject({ timezone: 'Asia/Kolkata' });
    expect((await wk(parent)).body.data.sessions.map((s: any) => s.title)).toContain('Robotics today');
    expect((await wk(t1)).body.data.sessions.map((s: any) => s.title)).toEqual(['Robotics today']);
    expect((await wk(w.admin)).body.data.sessions.map((s: any) => s.title)).toEqual(expect.arrayContaining(['Robotics today', 'Python today']));
    expect((await wk(other.admin)).body.data.sessions).toHaveLength(0);
    expect((await w.admin.get('/api/timetable/week?start=2020-03-04')).body.data).toMatchObject({ start: '2020-03-02', end: '2020-03-08', sessions: [] }); expect((await w.admin.get('/api/timetable/week?start=bad')).status).toBe(400);
    void outsider; void acct;
  });
});
