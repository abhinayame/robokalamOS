import { beforeAll, describe, expect, it } from 'vitest';
import { exec, newId, queryOne } from '../src/db/pool.js';
import { buildWorld, client, enroll, login, mobile, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World;
beforeAll(async () => { w = await buildWorld(); });

describe('master learner profile (ONE learner = ONE record)', () => {
  it('creates a learner with a sequential human readable id, parent and initial batch', async () => {
    const l = await newLearner(w, {
      full_name: 'Rahul Kumar', mobile: '98765 43210', email: 'Rahul@Example.com', school: 'DAV', location: 'Chennai',
      parent: { full_name: 'Sunil Kumar', mobile: '+91 90000 11111', relationship: 'father' }, batch_ids: [w.batches.roboA],
    });
    expect(l.learner_code).toMatch(/^RK-LRN-\d{6}$/);
    expect(l.mobile).toBe('+919876543210');
    expect(l.email).toBe('rahul@example.com');
    expect(l.parents[0]).toMatchObject({ full_name: 'Sunil Kumar', is_primary: true, mobile: '+919000011111' });
    expect(l.stats.active_batches).toBe(1);
    const tl = await w.admin.get(`/api/learners/${l.id}/timeline`);
    expect(tl.body.data.map((e: any) => e.type)).toEqual(expect.arrayContaining(['learner.created', 'parent.linked', 'batch.joined']));
  });

  it('rejects duplicate mobile and email with a helpful conflict, and invalid phone/email', async () => {
    const m = mobile();
    const a = await newLearner(w, { mobile: m, email: `dup-${uniq()}@x.com` });
    const dupMobile = await w.admin.post('/api/learners', { full_name: 'Someone Else', mobile: m });
    expect(dupMobile.status).toBe(409);
    expect(dupMobile.body.error.code).toBe('DUPLICATE_LEARNER');
    expect(dupMobile.body.error.details.existing.id).toBe(a.id);
    const dupEmail = await w.admin.post('/api/learners', { full_name: 'Someone Else', email: a.email.toUpperCase() });
    expect(dupEmail.status).toBe(409);
    expect((await w.admin.post('/api/learners', { full_name: 'Bad Phone', mobile: '12345' })).status).toBe(400);
    expect((await w.admin.post('/api/learners', { full_name: 'Bad Mail', email: 'nope' })).status).toBe(400);
    expect((await w.admin.post('/api/learners', { full_name: 'A' })).status).toBe(400);
  });

  it('siblings share a single parent record (deduplicated by parent mobile)', async () => {
    const pm = mobile();
    const a = await newLearner(w, { parent: { full_name: 'Mrs Shared', mobile: pm } });
    const b = await newLearner(w, { parent: { full_name: 'Mrs Shared Again', mobile: pm } });
    expect(a.parents[0].id).toBe(b.parents[0].id);
    const parents = await w.admin.get(`/api/parents?q=${pm.slice(-6)}`);
    expect(parents.body.data).toHaveLength(1);
    expect(parents.body.data[0].children).toHaveLength(2);
  });

  it('same learner in two batches stays ONE learner row with two memberships', async () => {
    const l = await newLearner(w, { full_name: 'Aisha Multi' });
    await enroll(w, l.id, w.batches.roboA);
    const after = await enroll(w, l.id, w.batches.pyB);
    expect(after.learner.stats.active_batches).toBe(2);
    const n = await queryOne(`SELECT count(*) AS n FROM learners WHERE org_id = $1 AND full_name = 'Aisha Multi'`, [w.orgId]);
    expect(n!.n).toBe(1);
    const m = await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE learner_id = $1`, [l.id]);
    expect(m!.n).toBe(2);
  });

  it('enrolling twice is idempotent (unique learner_id + batch_id)', async () => {
    const l = await newLearner(w);
    await enroll(w, l.id, w.batches.roboA);
    const again = await w.admin.post(`/api/learners/${l.id}/batches`, { batch_id: w.batches.roboA });
    expect(again.status).toBe(200);
    expect(again.body.data.already_member).toBe(1);
    expect((await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE learner_id = $1`, [l.id]))!.n).toBe(1);
    // the database itself forbids duplicates
    await expect(exec(`INSERT INTO learner_batch_memberships (id, org_id, learner_id, batch_id) VALUES ($1,$2,$3,$4)`, [newId(), w.orgId, l.id, w.batches.roboA])).rejects.toThrow();
  });

  it('a learner can be in 10 batches', async () => {
    const l = await newLearner(w, { full_name: 'Ten Batches' });
    for (let i = 0; i < 10; i++) {
      const b = await w.admin.post('/api/batches', { name: `Extra ${uniq()}`, program_id: w.program, course_id: w.courseRobotics, academic_year: '2026-27' });
      await enroll(w, l.id, b.body.data.id);
    }
    const full = await w.admin.get(`/api/learners/${l.id}`);
    expect(full.body.data.stats.active_batches).toBe(10);
    const list = await w.admin.get(`/api/learners?q=Ten Batches`);
    expect(list.body.data[0].batches).toHaveLength(10);
  });

  it('leaving one batch keeps the other; re-joining reactivates the same membership row', async () => {
    const l = await newLearner(w);
    await enroll(w, l.id, w.batches.roboA);
    await enroll(w, l.id, w.batches.pyB);
    const left = await w.admin.del(`/api/learners/${l.id}/batches/${w.batches.roboA}`, { reason: 'Moved city' });
    expect(left.status).toBe(200);
    expect(left.body.data.learner.stats.active_batches).toBe(1);
    const mem = left.body.data.learner.memberships;
    expect(mem.find((m: any) => m.batch_id === w.batches.roboA)).toMatchObject({ membership_status: 'left', left_reason: 'Moved city' });
    const rejoin = await enroll(w, l.id, w.batches.roboA);
    expect(rejoin.rejoined).toBe(1);
    expect((await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE learner_id = $1`, [l.id]))!.n).toBe(2);
  });

  it('transfer moves a learner between batches atomically and records the timeline', async () => {
    const l = await newLearner(w, { batch_ids: [w.batches.roboA] });
    const t = await w.admin.post(`/api/learners/${l.id}/transfer`, { from_batch_id: w.batches.roboA, to_batch_id: w.batches.roboB });
    expect(t.status).toBe(200);
    const active = t.body.data.memberships.filter((m: any) => m.membership_status === 'active');
    expect(active.map((m: any) => m.batch_id)).toEqual([w.batches.roboB]);
    const tl = (await w.admin.get(`/api/learners/${l.id}/timeline`)).body.data.map((e: any) => e.type);
    expect(tl).toEqual(expect.arrayContaining(['batch.transferred_out', 'batch.transferred_in']));
    // not a member of the "from" batch → conflict, nothing changes
    const bad = await w.admin.post(`/api/learners/${l.id}/transfer`, { from_batch_id: w.batches.pyB, to_batch_id: w.batches.aiC });
    expect(bad.status).toBe(409);
    expect((await w.admin.get(`/api/learners/${l.id}`)).body.data.stats.active_batches).toBe(1);
  });

  it('a failed transfer rolls back completely (target batch full)', async () => {
    const small = (await w.admin.post('/api/batches', { name: 'Tiny', program_id: w.program, course_id: w.courseRobotics, academic_year: '2026-27', capacity: 1 })).body.data.id;
    const a = await newLearner(w); const b = await newLearner(w, { batch_ids: [w.batches.roboA] });
    await enroll(w, a.id, small);
    const t = await w.admin.post(`/api/learners/${b.id}/transfer`, { from_batch_id: w.batches.roboA, to_batch_id: small });
    expect(t.status).toBe(409);
    expect(t.body.error.code).toBe('CAPACITY_EXCEEDED');
    const still = (await w.admin.get(`/api/learners/${b.id}`)).body.data.memberships.find((m: any) => m.batch_id === w.batches.roboA);
    expect(still.membership_status).toBe('active');
  });

  it('enforces capacity and refuses archived batches', async () => {
    const cap = (await w.admin.post('/api/batches', { name: 'Cap2', program_id: w.program, course_id: w.courseRobotics, academic_year: '2026-27', capacity: 2 })).body.data.id;
    const [a, b, c] = [await newLearner(w), await newLearner(w), await newLearner(w)];
    await enroll(w, a.id, cap); await enroll(w, b.id, cap);
    const full = await w.admin.post(`/api/learners/${c.id}/batches`, { batch_id: cap });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('CAPACITY_EXCEEDED');
    expect((await w.admin.patch(`/api/batches/${cap}`, { capacity: 1 })).status).toBe(409);
    await w.admin.patch(`/api/batches/${cap}`, { status: 'archived' });
    const closed = await w.admin.post(`/api/learners/${c.id}/batches`, { batch_id: cap });
    expect(closed.body.error.code).toBe('BATCH_CLOSED');
  });

  it('archive keeps the record, ends memberships and can be restored', async () => {
    const l = await newLearner(w, { batch_ids: [w.batches.roboA, w.batches.pyB] });
    expect((await w.admin.del(`/api/learners/${l.id}`)).status).toBe(200);
    const g = await w.admin.get(`/api/learners/${l.id}`);
    expect(g.body.data.status).toBe('archived');
    expect(g.body.data.stats.active_batches).toBe(0);
    expect(g.body.data.stats.total_batches).toBe(2);          // history preserved
    const def = await w.admin.get(`/api/learners?q=${encodeURIComponent(l.full_name)}`);
    expect(def.body.data).toHaveLength(0);                    // hidden from default list…
    const arch = await w.admin.get(`/api/learners?q=${encodeURIComponent(l.full_name)}&status=archived`);
    expect(arch.body.data).toHaveLength(1);                   // …but never lost
    expect((await w.admin.post(`/api/learners/${l.id}/restore`)).body.data.status).toBe('active');
    const reEnroll = await w.admin.post(`/api/learners/${l.id}/batches`, { batch_id: w.batches.roboA });
    expect(reEnroll.status).toBe(201);
  });

  it('updates a learner, audits previous/new values and blocks duplicates on update', async () => {
    const a = await newLearner(w, { school: 'Old School' });
    const b = await newLearner(w);
    const up = await w.admin.patch(`/api/learners/${a.id}`, { school: 'New School', status: 'inactive' });
    expect(up.status).toBe(200);
    expect(up.body.data.school).toBe('New School');
    const log = await queryOne(`SELECT previous_data, new_data FROM audit_logs WHERE entity_id = $1 AND action = 'learner.updated' ORDER BY id DESC LIMIT 1`, [a.id]);
    expect(log!.previous_data.school).toBe('Old School');
    expect(log!.new_data.school).toBe('New School');
    const dup = await w.admin.patch(`/api/learners/${b.id}`, { mobile: a.mobile });
    expect(dup.status).toBe(409);
    expect(a.learner_code).toBe((await w.admin.get(`/api/learners/${a.id}`)).body.data.learner_code);
  });

  it('list supports server-side pagination, sorting and search', async () => {
    for (let i = 0; i < 7; i++) await newLearner(w, { full_name: `Pagetest ${String.fromCharCode(65 + i)}` });
    const p1 = await w.admin.get('/api/learners?q=Pagetest&page=1&page_size=3&sort=name&order=asc');
    expect(p1.body.meta).toMatchObject({ page: 1, page_size: 3, total: 7, total_pages: 3 });
    expect(p1.body.data.map((x: any) => x.full_name)).toEqual(['Pagetest A', 'Pagetest B', 'Pagetest C']);
    const p3 = await w.admin.get('/api/learners?q=Pagetest&page=3&page_size=3&sort=name&order=desc');
    expect(p3.body.data.map((x: any) => x.full_name)).toEqual(['Pagetest A']);
    expect((await w.admin.get('/api/learners?page_size=1000')).status).toBe(400);
    expect((await w.admin.get('/api/learners?sort=password_hash')).status).toBe(400);   // sort whitelist
    const sqli = await w.admin.get(`/api/learners?q=${encodeURIComponent("x'; DROP TABLE learners;--")}`);
    expect(sqli.status).toBe(200);
    expect((await w.admin.get('/api/learners?page_size=1')).status).toBe(200);
  });

  it('combined filters AND together and apply to the same membership', async () => {
    const robo = await newLearner(w, { full_name: 'FilterRobo' });
    const py = await newLearner(w, { full_name: 'FilterPy' });
    await enroll(w, robo.id, w.batches.roboA); await enroll(w, py.id, w.batches.pyB);
    const f1 = await w.admin.get(`/api/learners?q=Filter&course_id=${w.courseRobotics}`);
    expect(f1.body.data.map((x: any) => x.full_name)).toEqual(['FilterRobo']);
    const f2 = await w.admin.get(`/api/learners?q=Filter&course_id=${w.courseRobotics}&batch_id=${w.batches.pyB}`);
    expect(f2.body.data).toHaveLength(0);           // Python batch is not a Robotics membership
    const f3 = await w.admin.get(`/api/learners?q=Filter&batch_id=${w.batches.roboA},${w.batches.pyB}`);
    expect(f3.body.meta.total).toBe(2);
    const f4 = await w.admin.get(`/api/learners?q=Filter&no_batch=true`);
    expect(f4.body.meta.total).toBe(0);
  });

  it('teacher change: lead is replaced, removed teacher loses access to the batch learners', async () => {
    const l = await newLearner(w, { batch_ids: [w.batches.roboA] });
    await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
    const t1 = client(await login(w.teachers.t1.email));
    expect((await t1.get(`/api/learners/${l.id}`)).status).toBe(200);
    await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t2.id, role: 'lead' });
    const b = (await w.admin.get(`/api/batches/${w.batches.roboA}`)).body.data;
    expect(b.teachers).toEqual(expect.arrayContaining([expect.objectContaining({ id: w.teachers.t2.id, role: 'lead' }), expect.objectContaining({ id: w.teachers.t1.id, role: 'co' })]));
    await w.admin.del(`/api/batches/${w.batches.roboA}/teachers/${w.teachers.t1.id}`);
    expect((await t1.get(`/api/learners/${l.id}`)).status).toBe(404);
    expect((await t1.get(`/api/batches/${w.batches.roboA}`)).status).toBe(404);
  });
});
