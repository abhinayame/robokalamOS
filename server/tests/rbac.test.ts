import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { exec, newId, query } from '../src/db/pool.js';
import { app, buildWorld, client, enroll, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World;
let ravi: any, meena: any, stranger: any;

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  ravi = await newLearner(w, { full_name: 'Ravi Child', email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Parent P', mobile: '9811111111', email: `pp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA, w.batches.pyB] });
  meena = await newLearner(w, { full_name: 'Meena Child', email: `meena-${uniq()}@kids.test`, parent: { full_name: 'Parent P', mobile: '9811111111' }, batch_ids: [w.batches.roboA] });
  stranger = await newLearner(w, { full_name: 'Stranger Kid', email: `s-${uniq()}@kids.test`, batch_ids: [w.batches.aiC] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
});

describe('tenant isolation', () => {
  it('another organization cannot read or change this org’s data (404, never 403)', async () => {
    const o = other.admin;
    expect((await o.get(`/api/learners/${ravi.id}`)).status).toBe(404);
    expect((await o.patch(`/api/learners/${ravi.id}`, { school: 'Hacked' })).status).toBe(404);
    expect((await o.get(`/api/batches/${w.batches.roboA}`)).status).toBe(404);
    expect((await o.post(`/api/batches/${w.batches.roboA}/learners`, { learner_ids: [ravi.id] })).status).toBe(404);
    expect((await o.get(`/api/learners?q=Ravi`)).body.data).toHaveLength(0);
    expect((await o.get('/api/audit')).body.data.every((a: any) => a.entity_id !== ravi.id)).toBe(true);
  });

  it('cannot enrol a foreign learner into own batch or reference a foreign batch', async () => {
    const mine = await other.admin.post(`/api/batches/${other.batches.roboA}/learners`, { learner_ids: [ravi.id] });
    expect(mine.body.data.joined).toBe(0);            // silently skipped: not visible in this tenant
    expect(mine.body.data.skipped).toBe(1);
    const foreignBatch = await other.admin.post('/api/learners', { full_name: 'Cross Tenant', batch_ids: [w.batches.roboA] });
    expect(foreignBatch.status).toBe(404);
  });

  it('database composite foreign keys reject cross-tenant memberships even if the app is bypassed', async () => {
    await expect(exec(`INSERT INTO learner_batch_memberships (id, org_id, learner_id, batch_id) VALUES ($1,$2,$3,$4)`, [newId(), other.orgId, ravi.id, other.batches.roboA])).rejects.toThrow();
  });

  it('super admin must pick an organization; org users cannot override it with X-Org-Id', async () => {
    const sa = client(w.superToken);
    expect((await sa.get('/api/learners')).status).toBe(400);
    expect((await client(w.superToken, w.orgId).get('/api/learners?q=Ravi')).body.data).toHaveLength(1);
    const spoof = await request(app).get('/api/learners?q=Ravi').set('Authorization', `Bearer ${await login(other.adminEmail)}`).set('X-Org-Id', w.orgId);
    expect(spoof.body.data).toHaveLength(0);
    expect((await w.admin.get('/api/organizations')).status).toBe(403);
    expect((await w.admin.post('/api/organizations', { name: 'x', slug: 'xx', admin: { full_name: 'a b', email: 'a@b.co' } })).status).toBe(403);
  });
});

describe('role based access', () => {
  it('teacher: sees only assigned batches/learners, cannot create or enrol', async () => {
    const t1 = client(await login(w.teachers.t1.email));
    const list = await t1.get('/api/learners');
    expect(list.body.data.map((l: any) => l.id).sort()).toEqual([meena.id, ravi.id].sort());
    expect((await t1.get(`/api/learners/${stranger.id}`)).status).toBe(404);
    expect((await t1.get('/api/batches')).body.data.map((b: any) => b.id)).toEqual([w.batches.roboA]);
    expect((await t1.post('/api/learners', { full_name: 'Nope Nope' })).status).toBe(403);
    expect((await t1.post(`/api/batches/${w.batches.roboA}/learners`, { learner_ids: [stranger.id] })).status).toBe(403);
    expect((await t1.patch(`/api/learners/${ravi.id}`, { school: 'x' })).status).toBe(403);
    expect((await t1.post('/api/batches', { name: 'x y', program_id: w.program, course_id: w.courseRobotics, academic_year: '2026' })).status).toBe(403);
    expect((await t1.get('/api/audit')).status).toBe(403);
    expect((await t1.post('/api/teachers', { full_name: 'x y', email: 'x@y.co' })).status).toBe(403);
  });

  it('learner: can open only own profile; no lists, no other learner', async () => {
    await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD });
    await w.admin.post(`/api/learners/${stranger.id}/login`, { password: PASSWORD });
    const me = client(await login(ravi.email));
    expect((await me.get(`/api/learners/${ravi.id}`)).status).toBe(200);
    expect((await me.get(`/api/learners/${meena.id}`)).status).toBe(404);
    expect((await me.get(`/api/learners/${stranger.id}`)).status).toBe(404);
    expect((await me.get(`/api/learners/${meena.id}/timeline`)).status).toBe(404);
    expect((await me.get('/api/learners')).status).toBe(403);
    expect((await me.get('/api/parents')).status).toBe(403);
    expect((await me.patch(`/api/learners/${ravi.id}`, { school: 'x' })).status).toBe(403);
    expect((await me.post('/api/selection/resolve', { all_learners: true })).status).toBe(403);
    const batches = await me.get('/api/batches');
    expect(batches.body.data.map((b: any) => b.id).sort()).toEqual([w.batches.roboA, w.batches.pyB].sort());
    expect((await me.get(`/api/batches/${w.batches.aiC}`)).status).toBe(404);
    expect((await me.get(`/api/batches/${w.batches.roboA}/learners`)).status).toBe(403);   // classmates' list is staff-only
  });

  it('parent with multiple children sees all of them (and their batches) but nobody else', async () => {
    const created = await w.admin.get(`/api/learners/${ravi.id}`);
    const parentId = created.body.data.parents[0].id;
    const loginRes = await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD });
    expect(loginRes.status).toBe(201);
    const p = client(await login(loginRes.body.data.email));
    const dash = await p.get('/api/dashboard');
    expect(dash.body.data.view).toBe('parent');
    expect(dash.body.data.children.map((c: any) => c.full_name).sort()).toEqual(['Meena Child', 'Ravi Child']);
    const raviCard = dash.body.data.children.find((c: any) => c.full_name === 'Ravi Child');
    expect(raviCard.batches).toHaveLength(2);                       // child in multiple batches → all shown
    expect((await p.get(`/api/learners/${ravi.id}`)).status).toBe(200);
    expect((await p.get(`/api/learners/${meena.id}`)).status).toBe(200);
    expect((await p.get(`/api/learners/${stranger.id}`)).status).toBe(404);   // unrelated learner
    expect((await p.get('/api/learners')).status).toBe(403);
    expect((await p.patch(`/api/learners/${ravi.id}`, { school: 'x' })).status).toBe(403);
  });

  it('branch admin is limited to their branch', async () => {
    const e = `ba-${uniq()}@test.dev`;
    const created = await w.admin.post('/api/users', { full_name: 'Branch Admin', email: e, password: PASSWORD, roles: [{ role: 'branch_admin', branch_id: w.branchA }] });
    expect(created.status).toBe(201);
    const ba = client(await login(e));
    const own = await newLearner(w, { full_name: 'In Branch A', branch_id: w.branchA }, ba);
    expect(own.branch.id).toBe(w.branchA);
    expect((await ba.post('/api/learners', { full_name: 'Wrong Branch', branch_id: w.branchB })).status).toBe(403);
    expect((await ba.get(`/api/learners/${stranger.id}`)).status).toBe(404);          // only in a branch-B batch
    expect((await ba.get(`/api/learners/${ravi.id}`)).status).toBe(200);              // active in a branch-A batch
    expect((await ba.get('/api/batches')).body.data.every((b: any) => b.branch_id === w.branchA)).toBe(true);
    expect((await ba.post(`/api/batches/${w.batches.pyB}/learners`, { learner_ids: [own.id] })).status).toBe(404);   // out-of-scope batch is invisible
    expect((await ba.post('/api/users', { full_name: 'Sneaky', email: `sn-${uniq()}@t.dev`, roles: [{ role: 'org_admin' }] })).status).toBe(403);
    expect((await ba.post('/api/organizations', {})).status).toBe(403);
  });

  it('counsellor can create learners and enrol but not manage users or archive', async () => {
    const e = `co-${uniq()}@test.dev`;
    await w.admin.post('/api/users', { full_name: 'Counsellor C', email: e, password: PASSWORD, roles: [{ role: 'counsellor' }] });
    const co = client(await login(e));
    expect((await co.post('/api/learners', { full_name: 'Lead Learner' })).status).toBe(201);
    expect((await co.post('/api/users', { full_name: 'x y', email: 'z@z.co', roles: [{ role: 'teacher' }] })).status).toBe(403);
    expect((await co.del(`/api/learners/${ravi.id}`)).status).toBe(403);
  });

  it('role changes are audited and cannot be self-granted', async () => {
    const e = `rc-${uniq()}@test.dev`;
    const u = await w.admin.post('/api/users', { full_name: 'Role Change', email: e, password: PASSWORD, roles: [{ role: 'teacher' }] });
    const r = await w.admin.put(`/api/users/${u.body.data.id}/roles`, { roles: [{ role: 'accountant' }] });
    expect(r.status).toBe(200);
    const row = await query(`SELECT previous_data, new_data FROM audit_logs WHERE action = 'permission.changed' AND entity_id = $1`, [u.body.data.id]);
    expect(row).toHaveLength(1);
    const me = (await w.admin.get('/api/auth/me')).body.data;
    expect((await w.admin.put(`/api/users/${me.id}/roles`, { roles: [{ role: 'teacher' }] })).status).toBe(400);
  });

  it('invalid ids and bodies are rejected with consistent error JSON', async () => {
    const r = await w.admin.get('/api/learners/not-a-uuid');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    const bad = await w.admin.post('/api/learners', { full_name: '' });
    expect(bad.body.error.details[0]).toMatchObject({ field: 'full_name' });
    expect((await w.admin.get('/api/nope')).status).toBe(404);
  });
});

describe('dashboards', () => {
  it('admin dashboard reports real aggregated numbers', async () => {
    const d = (await w.admin.get('/api/dashboard')).body.data;
    expect(d.view).toBe('admin');
    expect(d.learners.total).toBeGreaterThanOrEqual(3);
    expect(d.learners.multi_batch).toBeGreaterThanOrEqual(1);
    expect(d.batches.active).toBe(4);
    expect(d.teachers).toBe(2);
    expect(d.top_batches.length).toBeGreaterThan(0);
    expect(d.recent_activity.length).toBeGreaterThan(0);
    expect(d.upcoming_classes.length).toBeGreaterThan(0);
  });

  it('teacher dashboard counts UNIQUE learners across their batches', async () => {
    await w.admin.post(`/api/batches/${w.batches.pyB}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
    const t1 = client(await login(w.teachers.t1.email));
    const d = (await t1.get('/api/dashboard')).body.data;
    expect(d.view).toBe('teacher');
    expect(d.my_batches).toHaveLength(2);
    expect(d.batch_memberships).toBeGreaterThan(d.unique_learners - 1);
    expect(d.today_classes.length).toBe(2);
    expect((await t1.get('/api/dashboard?view=admin')).status).toBe(400);
  });
});
