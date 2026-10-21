import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { setEmailProvider, type EmailMessage, type EmailProvider, type EmailResult } from '../src/modules/email/provider.js';
import { runEmailWorkerOnce } from '../src/modules/email/outbox.js';
import request from 'supertest';

class FakeMail implements EmailProvider { sent: EmailMessage[] = []; async send(m: EmailMessage): Promise<EmailResult> { this.sent.push(m); return { ok: true, id: 'm' }; } }
const mail = new FakeMail();
const drain = async () => { for (let i = 0; i < 4; i++) if (!(await runEmailWorkerOnce({ provider: mail, limit: 200 })).claimed) break; };
const month = new Date().toISOString().slice(0, 7);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

let w: World, other: World; let ravi: any, meena: any, nodata: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, parent: ReturnType<typeof client>, co: ReturnType<typeof client>;
const room = () => `/api/classrooms/${w.batches.roboA}`;
let parentEmail = '';

beforeAll(async () => {
  setEmailProvider(mail);
  w = await buildWorld(); other = await buildWorld();
  parentEmail = `pr-${uniq()}@fam.test`;
  ravi = await newLearner(w, { full_name: 'Ravi Report', email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Ravi Parent', mobile: '9870000011', email: parentEmail }, batch_ids: [w.batches.roboA] });
  meena = await newLearner(w, { full_name: 'Meena Report', email: `meena-${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
  nodata = await newLearner(w, { full_name: 'Quiet Learner', parent: { full_name: 'Quiet Parent', mobile: '9870000012', email: `q-${uniq()}@fam.test` }, batch_ids: [w.batches.pyB] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD }); await w.admin.post(`/api/learners/${meena.id}/login`, { password: PASSWORD });
  t1 = client(await login(w.teachers.t1.email)); t2 = client(await login(w.teachers.t2.email)); rv = client(await login(ravi.email)); mn = client(await login(meena.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
  const cu = `co-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Counsellor', email: cu, password: PASSWORD, roles: [{ role: 'counsellor' }] }); co = client(await login(cu));
  // this month's data: two classes (one present, one late for Ravi; absent for Meena), a score, XP and a badge
  for (const [i, st] of ['present', 'late'].entries()) {
    const sid = (await w.admin.post(`${room()}/sessions`, { title: `Class ${i}`, starts_at: new Date(Date.now() + (50 + i) * 86400_000).toISOString(), ends_at: new Date(Date.now() + (50 + i) * 86400_000 + 3600_000).toISOString() })).body.data.id;
    const day = new Date(); day.setUTCDate(2 + i); day.setUTCHours(6, 0, 0, 0);
    await exec(`UPDATE class_sessions SET starts_at = $2, ends_at = DATE_ADD($2, INTERVAL 60 MINUTE), status = 'completed' WHERE id = $1`, [sid, day]);
    for (const [lid, s] of [[ravi.id, st], [meena.id, 'absent']] as const) await exec(`INSERT INTO attendance (id, org_id, session_id, batch_id, learner_id, status, marked_by) VALUES (UUID(), $1, $2, $3, $4, $5, $6)`, [w.orgId, sid, w.batches.roboA, lid, s, w.teachers.t1.id]);
  }
  const act = (await t1.post(`${room()}/activities`, { name: 'Line follower', category: 'Project', max_score: 100 })).body.data.id;
  await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: ravi.id, score: 80, feedback: 'Good' }] });
  await t1.post('/api/gamification/xp', { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: 30, reason: 'Participation' });
});
afterAll(() => setEmailProvider(null));

describe('monthly progress report', () => {
  it('is computed from the real records, with attendance, score, XP and notes', async () => {
    expect((await t1.put('/api/progress/notes', { learner_id: ravi.id, batch_id: w.batches.roboA, month, body: 'Ravi built a great robot and helps others.' })).status).toBe(200);
    const r = (await rv.get(`/api/progress/learners/${ravi.id}/report?month=${month}`)).body.data;
    expect(r.attendance).toMatchObject({ overall_pct: 100, classes_marked: 2 }); expect(r.attendance.batches[0]).toMatchObject({ present: 1, late: 1, absent: 0 });
    expect(r.scores).toMatchObject({ average_pct: 80, previous_average_pct: null, change: null }); expect(r.xp_earned).toBe(30); expect(r.notes[0].body).toContain('great robot'); expect(r.has_data).toBe(true);
    const m = (await mn.get(`/api/progress/learners/${meena.id}/report?month=${month}`)).body.data; expect(m.attendance.overall_pct).toBe(0); expect(m.notes).toHaveLength(0);
    expect((await w.admin.get(`/api/progress/learners/${nodata.id}/report?month=${month}`)).body.data.has_data).toBe(false);
  });
  it('is private: family sees their own, nobody sees across learners or schools', async () => {
    expect((await parent.get(`/api/progress/learners/${ravi.id}/report?month=${month}`)).status).toBe(200);
    expect((await mn.get(`/api/progress/learners/${ravi.id}/report?month=${month}`)).status).toBe(404);
    expect((await t2.get(`/api/progress/learners/${ravi.id}/report?month=${month}`)).status).toBe(404);          // a teacher of another batch
    expect((await other.admin.get(`/api/progress/learners/${ravi.id}/report?month=${month}`)).status).toBe(404);
    expect((await rv.get(`/api/progress/learners/${ravi.id}/report?month=2026-13`)).status).toBe(400);
    expect((await parent.get('/api/progress/me')).body.data.map((x: any) => x.full_name)).toEqual(['Ravi Report']);
  });
  it('downloads as a PDF', async () => {
    const pdf = await rv.get(`/api/progress/learners/${ravi.id}/report.pdf?month=${month}`).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toContain('application/pdf'); expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await mn.get(`/api/progress/learners/${ravi.id}/report.pdf?month=${month}`)).status).toBe(404);
  });
  it('teacher notes: only the batch\'s teachers, only members, deletable, never for the future', async () => {
    const body = { learner_id: meena.id, batch_id: w.batches.roboA, month, body: 'Meena needs to join more often.' };
    expect((await t2.put('/api/progress/notes', body)).status).toBe(404);
    expect((await rv.put('/api/progress/notes', body)).status).toBe(403);
    expect((await t1.put('/api/progress/notes', { ...body, learner_id: nodata.id })).status).toBe(404);          // not in this batch
    const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 2); expect((await t1.put('/api/progress/notes', { ...body, month: next.toISOString().slice(0, 7) })).status).toBe(400);
    expect((await t1.put('/api/progress/notes', body)).status).toBe(200);
    const sheet = (await t1.get(`/api/progress/batches/${w.batches.roboA}/notes?month=${month}`)).body.data; expect(sheet.learners.find((l: any) => l.learner_id === meena.id).my_note).toContain('join more often');
    expect((await t1.put('/api/progress/notes', { ...body, body: '' })).status).toBe(200);
    expect((await t1.get(`/api/progress/batches/${w.batches.roboA}/notes?month=${month}`)).body.data.learners.find((l: any) => l.learner_id === meena.id).my_note).toBeNull();
  });
  it('sends reports to parents once, skipping learners with nothing to report or no e-mail', async () => {
    const body = { month, selector: { batch_ids: [w.batches.roboA, w.batches.pyB] } };
    expect((await rv.post('/api/progress/send', { ...body, dry_run: true })).status).toBe(403);
    expect((await t1.post('/api/progress/send', { ...body, dry_run: true })).status).toBe(200);
    const dry = await w.admin.post('/api/progress/send', { ...body, dry_run: true }); expect(dry.body.data, JSON.stringify(dry.body)).toMatchObject({ selected: 3, to_send: 2, no_activity: 1, no_email: 0 });
    expect((await w.admin.post('/api/progress/send', body)).status).toBe(400);                                  // needs confirmation
    const go = await w.admin.post('/api/progress/send', { ...body, confirm: true }); expect(go.status).toBe(201); expect(go.body.data).toMatchObject({ sent: 2, no_activity: 1 });
    await drain(); const got = mail.sent.filter((m) => m.to === parentEmail); expect(got).toHaveLength(1); expect(got[0]!.subject).toContain("Ravi's progress report"); expect(got[0]!.text).toContain('Attendance 100%');
    const again = await w.admin.post('/api/progress/send', { ...body, confirm: true }); expect(again.body.data).toMatchObject({ sent: 0, already_sent: 2 });
    await drain(); expect(mail.sent.filter((m) => m.to === parentEmail)).toHaveLength(1);
    expect((await other.admin.post('/api/progress/send', body)).status).toBe(400);                              // another school's batches select nobody
  });
});

describe('project portfolio', () => {
  let fileId = ''; let itemId = '';
  const upload = (c: string, name: string, b: Buffer) => request(app).post(`/api/files?name=${name}`).set('Authorization', `Bearer ${c}`).set('Content-Type', 'application/octet-stream').send(b);
  let rvTok = ''; let t1Tok = '';
  beforeAll(async () => { rvTok = await login(ravi.email); t1Tok = await login(w.teachers.t1.email); });
  it('a learner adds a project; it waits for a teacher and is hidden from the family', async () => {
    const up = await upload(rvTok, 'robot.png', png); expect(up.status).toBe(201); fileId = up.body.data.id;
    expect((await rv.post('/api/portfolio', { title: 'No proof' })).status).toBe(400);                           // needs a photo or a video
    expect((await rv.post('/api/portfolio', { title: 'Bad link', video_url: 'http://insecure.example/v' })).status).toBe(400);
    expect((await parent.post('/api/portfolio', { title: 'By parent', video_url: 'https://youtu.be/abc' })).status).toBe(403);
    const add = await rv.post('/api/portfolio', { title: 'Line-follower robot', description: 'Follows a black line', batch_id: w.batches.roboA, file_ids: [fileId], video_url: 'https://youtu.be/abc' }); expect(add.status, JSON.stringify(add.body)).toBe(201); expect(add.body.data.status).toBe('pending'); itemId = add.body.data.id;
    expect((await rv.get(`/api/portfolio/learners/${ravi.id}`)).body.data).toHaveLength(1);                      // the learner sees it
    expect((await parent.get(`/api/portfolio/learners/${ravi.id}`)).body.data).toHaveLength(0);                  // the parent does not, yet
    expect((await parent.get(`/api/files/${fileId}?inline=1`)).status).toBe(404);                                 // nor the picture
    expect((await rv.get(`/api/files/${fileId}?inline=1`)).status).toBe(200);
  });
  it('only reviewers in scope approve or reject, with a reason for rejection', async () => {
    expect((await rv.post(`/api/portfolio/${itemId}/review`, { decision: 'approve' })).status).toBe(403);
    expect((await t2.post(`/api/portfolio/${itemId}/review`, { decision: 'approve' })).status).toBe(404);
    expect((await t1.get('/api/portfolio/review')).body.data.map((i: any) => i.id)).toContain(itemId);
    expect((await t2.get('/api/portfolio/review')).body.data.map((i: any) => i.id)).not.toContain(itemId);
    const second = await rv.post('/api/portfolio', { title: 'Needs work', video_url: 'https://youtu.be/xyz' }); const id2 = second.body.data.id;
    expect((await t1.post(`/api/portfolio/${id2}/review`, { decision: 'reject' })).status).toBe(400);
    expect((await t1.post(`/api/portfolio/${id2}/review`, { decision: 'reject', reason: 'Please add a clearer photo' })).status).toBe(200);
    expect((await rv.get(`/api/portfolio/learners/${ravi.id}`)).body.data.find((i: any) => i.id === id2)).toMatchObject({ status: 'rejected', reject_reason: 'Please add a clearer photo' });
    expect((await t1.post(`/api/portfolio/${itemId}/review`, { decision: 'approve' })).status).toBe(200);
    expect((await t1.post(`/api/portfolio/${itemId}/review`, { decision: 'approve' })).status).toBe(409);       // already reviewed
  });
  it('once published the family sees it and its picture, and is told; feedback reaches the learner', async () => {
    const list = (await parent.get(`/api/portfolio/learners/${ravi.id}`)).body.data; expect(list).toHaveLength(1); expect(list[0].files).toHaveLength(1);
    expect((await parent.get(`/api/files/${fileId}?inline=1`)).status).toBe(200);
    expect((await mn.get(`/api/files/${fileId}?inline=1`)).status).toBe(404);                                       // a classmate's family cannot open it
    expect(await queryOne(`SELECT 1 FROM notifications WHERE kind = 'portfolio.published' AND org_id = $1`, [w.orgId])).toBeTruthy();
    expect((await t1.put(`/api/portfolio/${itemId}/feedback`, { feedback: 'Great sensor placement!' })).status).toBe(200);
    expect((await rv.get(`/api/portfolio/learners/${ravi.id}`)).body.data.find((i: any) => i.id === itemId).feedback).toBe('Great sensor placement!');
    expect((await mn.get(`/api/portfolio/learners/${ravi.id}`)).status).toBe(404);
  });
  it('teachers add projects directly; removal is for the learner or a reviewer; files must be pictures', async () => {
    const tf = await upload(t1Tok, 'cert.png', png); const added = await t1.post('/api/portfolio', { learner_id: meena.id, title: 'Science fair', file_ids: [tf.body.data.id] }); expect(added.status).toBe(201); expect(added.body.data.status).toBe('published');
    expect((await mn.del(`/api/portfolio/${itemId}`)).status).toBe(404);
    const txt = await upload(t1Tok, 'notes.txt', Buffer.from('hello')); expect((await t1.post('/api/portfolio', { learner_id: meena.id, title: 'Doc', file_ids: [txt.body.data.id] })).status).toBe(400);
    expect((await parent.del(`/api/portfolio/${itemId}`)).status).toBe(403);
    expect((await other.admin.get(`/api/portfolio/learners/${ravi.id}`)).status).toBe(404);
    expect((await rv.del(`/api/portfolio/${itemId}`)).status).toBe(200);
    expect((await parent.get(`/api/portfolio/learners/${ravi.id}`)).body.data).toHaveLength(0);
    expect((await parent.get(`/api/files/${fileId}?inline=1`)).status).toBe(404);                                   // the picture goes with it
    void crypto; void query;
  });
});
