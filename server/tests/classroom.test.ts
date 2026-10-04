import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World;
let ravi: any, meena: any, stranger: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, st: ReturnType<typeof client>, parent: ReturnType<typeof client>;
let assignmentId: string;
let t1tok = '';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const upload = (token: string, name: string, buf: Buffer) =>
  request(app).post(`/api/files?name=${encodeURIComponent(name)}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').send(buf);

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  const mk = (n: string, extra: object = {}) => newLearner(w, { full_name: n, email: `${n.toLowerCase().replace(/\W/g, '')}-${uniq()}@kids.test`, ...extra });
  ravi = await mk('Ravi Child', { parent: { full_name: 'Parent P', mobile: '9822222222', email: `pp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA] });
  meena = await mk('Meena Child', { batch_ids: [w.batches.roboA] });
  stranger = await mk('Stranger Kid', { batch_ids: [w.batches.aiC] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  for (const l of [ravi, meena, stranger]) await w.admin.post(`/api/learners/${l.id}/login`, { password: PASSWORD });
  t1tok = await login(w.teachers.t1.email);
  t1 = client(t1tok); t2 = client(await login(w.teachers.t2.email));
  rv = client(await login(ravi.email)); mn = client(await login(meena.email)); st = client(await login(stranger.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  const lp = await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD });
  if (lp.status !== 201) throw new Error(JSON.stringify(lp.body));
  parent = client(await login(lp.body.data.email));
});

const room = () => `/api/classrooms/${w.batches.roboA}`;

describe('classroom access', () => {
  it('lists only the classrooms each role belongs to', async () => {
    expect((await t1.get('/api/classrooms')).body.data.map((b: any) => b.id)).toEqual([w.batches.roboA]);
    expect((await t2.get('/api/classrooms')).body.data).toHaveLength(0);
    expect((await rv.get('/api/classrooms')).body.data.map((b: any) => b.id)).toEqual([w.batches.roboA]);
    expect((await st.get('/api/classrooms')).body.data.map((b: any) => b.id)).toEqual([w.batches.aiC]);
    expect((await w.admin.get('/api/classrooms')).body.data.length).toBeGreaterThanOrEqual(4);
  });
  it('out-of-scope classrooms are 404, not 403', async () => {
    for (const c of [t2, st, other.admin]) {
      expect((await c.get(room())).status).toBe(404);
      expect((await c.get(`${room()}/stream`)).status).toBe(404);
      expect((await c.get(`${room()}/classwork`)).status).toBe(404);
    }
  });
  it('people: learners see classmates by name only', async () => {
    const r = await rv.get(`${room()}/people`);
    expect(r.status).toBe(200);
    expect(r.body.data.learners.map((l: any) => l.full_name).sort()).toEqual(['Meena Child', 'Ravi Child']);
    expect(JSON.stringify(r.body.data)).not.toMatch(/mobile|email|learner_code/);
    expect((await t1.get(`${room()}/people`)).body.data.learners[0].learner_code).toBeTruthy();
  });
});

describe('stream', () => {
  it('teacher posts; learners and parents cannot post; archived is read-only', async () => {
    expect((await t1.post(`${room()}/posts`, { kind: 'announcement', body: 'Bring your kits' })).status).toBe(201);
    expect((await rv.post(`${room()}/posts`, { kind: 'announcement', body: 'hi' })).status).toBe(403);
    expect((await parent.post(`${room()}/posts`, { kind: 'announcement', body: 'hi' })).status).toBe(403);
    expect((await t2.post(`${room()}/posts`, { kind: 'announcement', body: 'hi' })).status).toBe(404);
    expect((await t1.post(`${room()}/posts`, { kind: 'announcement' })).status).toBe(400);
    expect((await t1.post(`${room()}/posts`, { kind: 'link', url: 'javascript:alert(1)' })).status).toBe(400);
    const s = await rv.get(`${room()}/stream`);
    expect(s.body.data[0].body).toBe('Bring your kits');
    expect(s.body.data[0].author.is_staff).toBe(true);
  });
  it('comments: learners comment, parents cannot, owners can delete theirs', async () => {
    const post = (await rv.get(`${room()}/stream`)).body.data[0];
    const c = await rv.post(`${room()}/posts/${post.id}/comments`, { body: 'Will do' });
    expect(c.status).toBe(201);
    expect((await parent.post(`${room()}/posts/${post.id}/comments`, { body: 'x' })).status).toBe(400);
    expect((await mn.del(`${room()}/comments/${c.body.data.id}`)).status).toBe(404);
    expect((await rv.get(`${room()}/posts/${post.id}/comments`)).body.data).toHaveLength(1);
    expect((await rv.del(`${room()}/comments/${c.body.data.id}`)).status).toBe(200);
    expect((await t1.patch(`${room()}/posts/${post.id}`, { comments_enabled: false })).status).toBe(200);
    expect((await rv.post(`${room()}/posts/${post.id}/comments`, { body: 'again' })).status).toBe(400);
  });
});

describe('classwork', () => {
  it('topics, materials, reorder', async () => {
    const t = await t1.post(`${room()}/topics`, { title: 'Sensors' });
    expect(t.status).toBe(201);
    expect((await rv.post(`${room()}/topics`, { title: 'x' })).status).toBe(403);
    expect((await t1.post(`${room()}/materials`, { title: 'Nothing', kind: 'pdf' })).status).toBe(400);
    const m = await t1.post(`${room()}/materials`, { title: 'Intro video', kind: 'video', external_url: 'https://youtu.be/abc', topic_id: t.body.data.id });
    expect(m.status).toBe(201);
    expect((await t1.post(`${room()}/materials`, { title: 'Bad', kind: 'link', external_url: 'ftp://x' })).status).toBe(400);
    expect((await t1.post(`${room()}/materials`, { title: 'Foreign topic', kind: 'link', external_url: 'https://a.b', topic_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    const r = await t1.post(`${room()}/classwork/reorder`, { items: [{ type: 'material', id: m.body.data.id, topic_id: null, position: 5 }] });
    expect(r.status).toBe(200);
    const cw = (await mn.get(`${room()}/classwork`)).body.data;
    expect(cw.materials[0].topic_id).toBeNull();
    expect(cw.can_manage).toBe(false);
    expect((await t1.del(`${room()}/topics/${t.body.data.id}`)).status).toBe(200);
  });
  it('file upload validates content, size, and access', async () => {
    expect((await upload(w.superToken, 'x.pdf', PDF)).status).toBeGreaterThanOrEqual(400);
    const bad = await upload(t1Token(), 'evil.pdf', Buffer.from('<script>alert(1)</script>'));
    expect(bad.status).toBe(400);
    expect((await upload(t1Token(), 'run.exe', Buffer.from('MZ....'))).status).toBe(400);
    const ok = await upload(t1Token(), 'notes.pdf', PDF);
    expect(ok.status).toBe(201);
    const mat = await t1.post(`${room()}/materials`, { title: 'Notes', kind: 'pdf', file_ids: [ok.body.data.id] });
    expect(mat.status).toBe(201);
    const dl = await request(app).get(`/api/files/${ok.body.data.id}`).set('Authorization', `Bearer ${await login(ravi.email)}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect((await st.get(`/api/files/${ok.body.data.id}`)).status).toBe(404);
    expect((await other.admin.get(`/api/files/${ok.body.data.id}`)).status).toBe(404);
    expect((await t1.post(`${room()}/materials`, { title: 'Reuse', kind: 'pdf', file_ids: [ok.body.data.id] })).status).toBe(409);
  });
});
function t1Token() { return t1tok; }

describe('assignments & submissions', () => {
  it('teacher creates; learners see it with state; non-members cannot', async () => {
    const due = new Date(Date.now() + 10 * 86400000).toISOString();
    const a = await t1.post(`${room()}/assignments`, { title: 'Build a line follower', due_at: due, max_marks: 50, allow_resubmit: false });
    expect(a.status).toBe(201);
    assignmentId = a.body.data.id;
    expect((await rv.post(`${room()}/assignments`, { title: 'x' })).status).toBe(403);
    expect((await t1.post(`${room()}/assignments`, { title: 'x', max_marks: 0 })).status).toBe(400);
    const d = await rv.get(`/api/assignments/${assignmentId}`);
    expect(d.status).toBe(200);
    expect(d.body.data.state).toBe('upcoming');
    expect(d.body.data.can_submit).toBe(true);
    expect((await st.get(`/api/assignments/${assignmentId}`)).status).toBe(404);
    expect((await t2.get(`/api/assignments/${assignmentId}`)).status).toBe(404);
    expect((await t1.get(`/api/assignments/${assignmentId}`)).body.data.stats.members).toBe(2);
    expect((await parent.get(`/api/assignments/${assignmentId}`)).body.data.can_submit).toBe(false);
    const list = await rv.get('/api/assignments');
    expect(list.body.data.map((x: any) => x.id)).toContain(assignmentId);
  });
  it('draft → submit → no resubmit → review', async () => {
    const put = (c: any, b: object) => c.put(`/api/assignments/${assignmentId}/submission`, b);
    expect((await put(parent, { body: 'by parent', submit: true })).status).toBe(403);
    expect((await put(st, { body: 'x', submit: true })).status).toBe(404);
    expect((await put(rv, { submit: true })).status).toBe(400);
    expect((await put(rv, { body: 'draft only' })).body.data.status).toBe('draft');
    const png = await upload(await login(ravi.email), 'proof.png', PNG);
    expect(png.status).toBe(201);
    const s = await put(rv, { body: 'My robot works', link_url: 'https://drive.example/x', file_ids: [png.body.data.id], submit: true });
    expect(s.body.data.status).toBe('submitted');
    expect((await put(rv, { body: 'again', submit: true })).status).toBe(409);
    // teacher view
    const list = await t1.get(`/api/assignments/${assignmentId}/submissions`);
    expect(list.body.data.find((r: any) => r.full_name === 'Ravi Child').status).toBe('submitted');
    expect(list.body.data.find((r: any) => r.full_name === 'Meena Child').status).toBe('not_submitted');
    expect((await rv.get(`/api/assignments/${assignmentId}/submissions`)).status).toBe(403);
    // privacy: another learner cannot see the submission or its file
    const id = s.body.data.id;
    expect((await mn.get(`/api/submissions/${id}`)).status).toBe(404);
    expect((await mn.get(`/api/files/${png.body.data.id}`)).status).toBe(404);
    expect((await parent.get(`/api/submissions/${id}`)).status).toBe(200);
    expect((await t2.get(`/api/submissions/${id}`)).status).toBe(404);
    // review
    expect((await rv.post(`/api/submissions/${id}/review`, { action: 'evaluate', score: 10 })).status).toBe(404);
    expect((await t1.post(`/api/submissions/${id}/review`, { action: 'return' })).status).toBe(400);
    expect((await t1.post(`/api/submissions/${id}/review`, { action: 'return', feedback: 'Add wiring photo' })).body.data.status).toBe('returned');
    expect((await rv.get(`/api/assignments/${assignmentId}`)).body.data.can_submit).toBe(true);
    expect((await put(rv, { body: 'fixed', submit: true })).body.data.status).toBe('submitted');
    expect((await t1.post(`/api/submissions/${id}/review`, { action: 'evaluate', feedback: 'Great', score: 40 })).body.data.status).toBe('evaluated');
    expect((await put(rv, { body: 'too late', submit: true })).status).toBe(409);
    const sub = (await rv.get(`/api/submissions/${id}`)).body.data;
    expect(sub.version).toBe(2); expect(sub.feedback).toBe('Great');
  });
  it('late submissions are flagged; closed batches reject work', async () => {
    const a = await t1.post(`${room()}/assignments`, { title: 'Overdue', due_at: new Date(Date.now() - 86400000).toISOString() });
    const s = await mn.put(`/api/assignments/${a.body.data.id}/submission`, { body: 'sorry', submit: true });
    expect(s.body.data.status).toBe('late');
    const tl = await w.admin.get(`/api/learners/${meena.id}`);
    expect(tl.status).toBe(200);
    await w.admin.patch(`/api/batches/${w.batches.roboA}`, { status: 'completed' });
    const b = await t1.post(`${room()}/assignments`, { title: 'After close' });
    expect(b.status).toBe(409);
    const open = await rv.get(`/api/assignments/${assignmentId}`);
    expect(open.body.data.can_submit).toBe(false);
    expect((await t1.post(`/api/submissions/${s.body.data.id}/review`, { action: 'evaluate', score: 10 })).status).toBe(200);   // reviewing stays possible
    await w.admin.patch(`/api/batches/${w.batches.roboA}`, { status: 'active' });
  });
  it('deleting an assignment hides it everywhere', async () => {
    const a = await t1.post(`${room()}/assignments`, { title: 'Temp' });
    expect((await t1.del(`${room()}/assignments/${a.body.data.id}`)).status).toBe(200);
    expect((await rv.get(`/api/assignments/${a.body.data.id}`)).status).toBe(404);
    expect((await rv.get(`${room()}/stream`)).body.data.every((p: any) => p.title !== 'Temp')).toBe(true);
  });
});
