import request from 'supertest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { exec, newId, pool, queryOne } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/security.js';

export const app = createApp();
export const PASSWORD = 'Test-Pass-12345';

let migrated = false;
export async function ensureMigrated() {
  if (migrated) return;
  await migrate(() => {});
  migrated = true;
}

export async function createSuperAdmin(email = 'owner@robokalam.test') {
  await ensureMigrated();
  const existing = await queryOne(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing) return;
  const id = newId();
  await exec(`INSERT INTO users (id, org_id, email, password_hash, full_name) VALUES ($1,NULL,$2,$3,'Owner')`, [id, email, await hashPassword(PASSWORD)]);
  await exec(`INSERT INTO user_roles (id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE code = 'super_admin'`, [newId(), id]);
}

export async function login(email: string, password = PASSWORD) {
  const r = await request(app).post('/api/auth/login').send({ email, password });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.access_token as string;
}

/** Tiny authenticated client. */
export function client(token: string, orgId?: string) {
  const h = (r: request.Test) => { r.set('Authorization', `Bearer ${token}`); if (orgId) r.set('X-Org-Id', orgId); return r; };
  return {
    get: (u: string) => h(request(app).get(u)),
    post: (u: string, b?: object) => h(request(app).post(u)).send(b ?? {}),
    patch: (u: string, b?: object) => h(request(app).patch(u)).send(b ?? {}),
    put: (u: string, b?: object) => h(request(app).put(u)).send(b ?? {}),
    del: (u: string, b?: object) => h(request(app).delete(u)).send(b ?? {}),
  };
}

let seq = 0;
export const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
export const mobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

export interface World {
  superToken: string;
  orgId: string;
  admin: ReturnType<typeof client>;
  adminEmail: string;
  branchA: string; branchB: string;
  program: string; courseRobotics: string; coursePython: string;
  batches: { roboA: string; roboB: string; pyB: string; aiC: string };
  teachers: { t1: { id: string; email: string }; t2: { id: string; email: string } };
}

/** One organization with branches, catalog, batches and two teachers. */
export async function buildWorld(slug = `org-${uniq()}`.toLowerCase()): Promise<World> {
  await createSuperAdmin();
  const superToken = await login('owner@robokalam.test');
  const sa = client(superToken);
  const adminEmail = `admin-${slug}@test.dev`;
  const o = await sa.post('/api/organizations', { name: `Org ${slug}`, slug, admin: { full_name: 'Org Admin', email: adminEmail, password: PASSWORD } });
  if (o.status !== 201) throw new Error(JSON.stringify(o.body));
  const orgId = o.body.data.organization.id;
  const admin = client(await login(adminEmail));
  const mk = async (url: string, body: object) => {
    const r = await admin.post(url, body);
    if (r.status !== 201) throw new Error(`${url}: ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  const branchA = (await mk('/api/branches', { name: 'Chennai', code: 'CHN' })).id;
  const branchB = (await mk('/api/branches', { name: 'Bengaluru', code: 'BLR' })).id;
  const program = (await mk('/api/programs', { name: 'STEM', code: 'STEM' })).id;
  const courseRobotics = (await mk('/api/courses', { program_id: program, name: 'Robotics', code: 'ROBO' })).id;
  const coursePython = (await mk('/api/courses', { program_id: program, name: 'Python', code: 'PY' })).id;
  const batch = async (name: string, course: string, branch: string, extra: object = {}) =>
    (await mk('/api/batches', { name, program_id: program, course_id: course, branch_id: branch, academic_year: '2026-27', status: 'active',
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], start: '17:00', end: '18:30', mode: 'online' }, ...extra })).id as string;
  const batches = {
    roboA: await batch('Robotics Batch A', courseRobotics, branchA),
    roboB: await batch('Robotics Batch B', courseRobotics, branchA),
    pyB: await batch('Python Batch B', coursePython, branchB),
    aiC: await batch('AI Batch C', coursePython, branchB),
  };
  const teacher = async (n: string) => {
    const t = await mk('/api/teachers', { full_name: `Teacher ${n}`, email: `${n}-${slug}@test.dev`, password: PASSWORD });
    return { id: t.id as string, email: t.email as string };
  };
  const teachers = { t1: await teacher('t1'), t2: await teacher('t2') };
  return { superToken, orgId, admin, adminEmail, branchA, branchB, program, courseRobotics, coursePython, batches, teachers };
}

export async function newLearner(w: World, extra: Record<string, unknown> = {}, who = w.admin) {
  const r = await who.post('/api/learners', { full_name: `Learner ${uniq()}`, mobile: mobile(), ...extra });
  if (r.status !== 201) throw new Error(`create learner: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
}

export async function enroll(w: World, learnerId: string, batchId: string) {
  const r = await w.admin.post(`/api/learners/${learnerId}/batches`, { batch_id: batchId });
  if (r.status !== 201 && r.status !== 200) throw new Error(`enroll: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

export async function closePool() { await pool.end(); }
