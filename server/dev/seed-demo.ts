/**
 * DEVELOPMENT ONLY. Creates a demo organization through the real HTTP API (so every rule is exercised):
 *   org admin  admin@demo.robokalam.test   teacher  teacher1@demo.robokalam.test
 *   learner    aarav@demo.robokalam.test   parent   parent@demo.robokalam.test      password: Demo-Pass-12345
 */
import request from 'supertest';
import { createApp } from '../src/app.js';
import { isProd } from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { pool, queryOne, query } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/security.js';

if (isProd) { console.error('Refusing to seed demo data in production.'); process.exit(1); }
const PW = 'Demo-Pass-12345';
const app = createApp();

const FIRST = ['Aarav', 'Aisha', 'Rahul', 'Ananya', 'Vihaan', 'Diya', 'Arjun', 'Meera', 'Kabir', 'Ishita', 'Rohan', 'Saanvi', 'Aditya', 'Kavya', 'Reyansh', 'Myra', 'Ayaan', 'Navya', 'Dhruv', 'Tara'];
const LAST = ['Kumar', 'Sharma', 'Iyer', 'Reddy', 'Nair', 'Khan', 'Patel', 'Singh', 'Menon', 'Das', 'Gupta', 'Rao'];
const SCHOOLS = ['DAV Gopalapuram', 'PSBB KK Nagar', 'National Public School', 'Chettinad Vidyashram', 'Greenwood High'];
const CITIES = ['Chennai', 'Bengaluru', 'Coimbatore', 'Hyderabad'];

async function main() {
  await migrate(() => {});
  let sa = await queryOne(`SELECT id FROM users WHERE email = 'owner@robokalam.test'`);
  if (!sa) {
    const u = await queryOne(`INSERT INTO users (org_id, email, password_hash, full_name) VALUES (NULL,'owner@robokalam.test',$1,'Platform Owner') RETURNING id`, [await hashPassword(PW)]);
    await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'super_admin'`, [u!.id]);
  }
  if (await queryOne(`SELECT 1 FROM organizations WHERE slug = 'robokalam-demo'`)) { console.log('Demo organization already exists.'); return; }

  const tok = async (email: string) => (await request(app).post('/api/auth/login').send({ email, password: PW })).body.data.access_token as string;
  const call = (t: string) => (m: 'post' | 'get' | 'patch', url: string, body?: object) => request(app)[m](url).set('Authorization', `Bearer ${t}`).send(body);
  const owner = call(await tok('owner@robokalam.test'));
  const org = await owner('post', '/api/organizations', { name: 'Robokalam Demo', slug: 'robokalam-demo', code_prefix: 'RK', admin: { full_name: 'Demo Admin', email: 'admin@demo.robokalam.test', password: PW } });
  if (org.status !== 201) throw new Error(JSON.stringify(org.body));
  const A = call(await tok('admin@demo.robokalam.test'));
  const mk = async (url: string, body: object) => { const r = await A('post', url, body); if (r.status !== 201) throw new Error(`${url} ${JSON.stringify(r.body)}`); return r.body.data; };

  const chn = await mk('/api/branches', { name: 'Chennai HQ', code: 'CHN', city: 'Chennai' });
  const blr = await mk('/api/branches', { name: 'Bengaluru', code: 'BLR', city: 'Bengaluru' });
  const stem = await mk('/api/programs', { name: 'STEM Programs', code: 'STEM' });
  const camp = await mk('/api/programs', { name: 'Summer Camps', code: 'CAMP' });
  const courses = {
    robotics: await mk('/api/courses', { program_id: stem.id, name: 'Robotics', code: 'ROBO' }),
    python: await mk('/api/courses', { program_id: stem.id, name: 'Python', code: 'PY' }),
    ai: await mk('/api/courses', { program_id: stem.id, name: 'AI Foundations', code: 'AI' }),
    camp: await mk('/api/courses', { program_id: camp.id, name: 'Summer Camp 2026', code: 'SC26' }),
  };
  const teachers = [];
  for (const [i, n] of ['Priya Raman', 'Karthik Subramanian', 'Farah Ahmed'].entries()) {
    teachers.push(await mk('/api/teachers', { full_name: n, email: `teacher${i + 1}@demo.robokalam.test`, password: PW }));
  }
  const sched = (days: number[], start: string, end: string, mode = 'online') => ({ days, start, end, mode });
  const defs: [string, keyof typeof courses, any, number, string, any][] = [
    ['Robotics Beginner Batch A', 'robotics', chn, 0, 'active', sched([6], '10:00', '12:00', 'offline')],
    ['Robotics Beginner Batch B', 'robotics', chn, 0, 'active', sched([0], '10:00', '12:00', 'offline')],
    ['Python Weekend Batch B', 'python', blr, 1, 'active', sched([6, 0], '16:00', '17:30')],
    ['AI Advanced Batch C', 'ai', blr, 2, 'active', sched([3, 5], '18:00', '19:30')],
    ['Summer Camp 2026', 'camp', chn, 0, 'upcoming', sched([1, 2, 3, 4, 5], '09:30', '13:00', 'offline')],
    ['Robotics Batch 2025 (Completed)', 'robotics', chn, 1, 'completed', sched([6], '10:00', '12:00')],
  ];
  const batches: any[] = [];
  for (const [name, c, br, t, status, schedule] of defs) {
    batches.push(await mk('/api/batches', { name, program_id: courses[c].program_id, course_id: courses[c].id, branch_id: br.id, academic_year: '2026-27', status, schedule, capacity: 40, teacher_id: teachers[t].id, start_date: '2026-06-01', end_date: '2026-12-20' }));
  }

  let n = 0;
  const open = batches.filter((b) => b.status !== 'completed');
  for (let i = 0; i < 120; i++) {
    const fn = FIRST[i % FIRST.length], ln = LAST[(i * 7) % LAST.length];
    const parentMobile = `98${String(40000000 + Math.floor(i / 2) * 37).padStart(8, '0')}`;     // pairs of siblings share a parent
    const l = await mk('/api/learners', {
      full_name: `${fn} ${ln}`, mobile: `9${String(700000000 + i * 131).padStart(9, '0')}`, email: i < 6 ? `${fn.toLowerCase()}${i ? i : ''}@demo.robokalam.test` : undefined,
      school: SCHOOLS[i % SCHOOLS.length], location: CITIES[i % CITIES.length], branch_id: (i % 2 ? blr : chn).id, gender: i % 2 ? 'female' : 'male',
      parent: { full_name: `${LAST[(i * 7) % LAST.length]} Family`, mobile: parentMobile, relationship: i % 3 ? 'mother' : 'father', email: i === 0 ? 'parent@demo.robokalam.test' : undefined },
    });
    // 1–3 batches each; some learners in several programs (the multi-batch case)
    const picks = new Set<number>([i % open.length]);
    if (i % 3 === 0) picks.add((i + 2) % open.length);
    if (i % 11 === 0) picks.add((i + 3) % open.length);
    for (const p of picks) await A('post', `/api/learners/${l.id}/batches`, { batch_id: open[p].id });
    if (i % 17 === 0) await A('post', `/api/learners/${l.id}/batches`, { batch_id: batches[5].id });
    if (i % 29 === 0) await A('patch', `/api/learners/${l.id}`, { status: 'inactive' });
    n++;
    if (i === 0) {
      await A('post', `/api/learners/${l.id}/login`, { email: 'aarav@demo.robokalam.test', password: PW });
      const full = (await A('get', `/api/learners/${l.id}`)).body.data;
      await A('post', `/api/parents/${full.parents[0].id}/login`, { password: PW });
    }
  }
  console.log(`Demo ready: ${n} learners, ${batches.length} batches. Sign in as admin@demo.robokalam.test / ${PW}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
