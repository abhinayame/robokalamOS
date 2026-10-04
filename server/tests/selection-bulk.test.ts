import { beforeAll, describe, expect, it } from 'vitest';
import { queryOne } from '../src/db/pool.js';
import { buildWorld, client, enroll, login, newLearner, uniq, type World } from './helpers.js';

let w: World;
let rahul: any, aisha: any, kiran: any, solo: any;

beforeAll(async () => {
  w = await buildWorld();
  rahul = await newLearner(w, { full_name: 'Rahul Sel' });     // in roboA + roboB  (the classic duplicate)
  aisha = await newLearner(w, { full_name: 'Aisha Sel' });     // roboA only
  kiran = await newLearner(w, { full_name: 'Kiran Sel' });     // pyB only
  solo = await newLearner(w, { full_name: 'Solo Sel' });       // no batch
  await enroll(w, rahul.id, w.batches.roboA); await enroll(w, rahul.id, w.batches.roboB);
  await enroll(w, aisha.id, w.batches.roboA);
  await enroll(w, kiran.id, w.batches.pyB);
});

const resolve = (body: object) => w.admin.post('/api/selection/resolve', body);

describe('batch selection engine & deduplication', () => {
  it('counts batches, memberships, UNIQUE learners and duplicates removed', async () => {
    const r = await resolve({ batch_ids: [w.batches.roboA, w.batches.roboB] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ selected_batches: 2, batch_memberships: 3, unique_learners: 2, duplicates_removed: 1 });
    expect(r.body.data.sample.map((s: any) => s.full_name)).toEqual(['Aisha Sel', 'Rahul Sel']);
  });

  it('a learner in both selected batches appears exactly once in the recipient set', async () => {
    const r = await w.admin.post('/api/bulk/learners/export', { selection: { batch_ids: [w.batches.roboA, w.batches.roboB] }, columns: ['full_name'] });
    const lines = r.text.replace('﻿', '').split('\r\n');
    expect(lines).toEqual(['Name', 'Aisha Sel', 'Rahul Sel']);
  });

  it('empty selection resolves to NOBODY; "all learners" must be explicit', async () => {
    expect((await resolve({})).body.data).toMatchObject({ selected_batches: 0, batch_memberships: 0, unique_learners: 0, duplicates_removed: 0 });
    expect((await resolve({ batch_ids: [] })).body.data.unique_learners).toBe(0);
    const all = await resolve({ all_learners: true });
    expect(all.body.data.unique_learners).toBeGreaterThanOrEqual(4);
  });

  it('combines batches, courses and individual learners without double counting', async () => {
    const r = await resolve({ batch_ids: [w.batches.roboA], course_ids: [w.courseRobotics], learner_ids: [rahul.id, solo.id] });
    // roboA ∪ roboB memberships = 3 (rahul×2, aisha) + 2 explicit ids = 5 raw → 3 unique (rahul, aisha, solo)
    expect(r.body.data.unique_learners).toBe(3);
    expect(r.body.data.duplicates_removed).toBe(r.body.data.batch_memberships + 2 - 3);
  });

  it('filters narrow the audience (AND) and report the unique match count', async () => {
    const r = await resolve({ course_ids: [w.courseRobotics], filters: { q: 'Rahul' } });
    expect(r.body.data.unique_learners).toBe(1);
    const only = await resolve({ filters: { course_id: [w.courseRobotics], batch_id: [w.batches.roboA, w.batches.roboB], status: ['active'] } });
    expect(only.body.data.unique_learners).toBe(2);
  });

  it('ignores archived/inactive learners and other statuses of membership by default', async () => {
    const gone = await newLearner(w, { full_name: 'Gone Sel', batch_ids: [w.batches.roboA] });
    const before = (await resolve({ batch_ids: [w.batches.roboA] })).body.data.unique_learners;
    await w.admin.patch(`/api/learners/${gone.id}`, { status: 'inactive' });
    expect((await resolve({ batch_ids: [w.batches.roboA] })).body.data.unique_learners).toBe(before - 1);
    expect((await resolve({ batch_ids: [w.batches.roboA], learner_statuses: ['active', 'inactive'] })).body.data.unique_learners).toBe(before);
    await w.admin.del(`/api/learners/${aisha.id}/batches/${w.batches.roboA}`);
    expect((await resolve({ batch_ids: [w.batches.roboA] })).body.data.unique_learners).toBe(1);   // only rahul
    await enroll(w, aisha.id, w.batches.roboA);
  });

  it('does not leak other organizations', async () => {
    const other = await buildWorld();
    const x = await newLearner(other, { full_name: 'Other Org', batch_ids: [other.batches.roboA] });
    const r = await resolve({ batch_ids: [other.batches.roboA], learner_ids: [x.id] });
    expect(r.body.data.unique_learners).toBe(0);
  });

  it('teachers only resolve audiences inside their own batches', async () => {
    await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
    const t1 = client(await login(w.teachers.t1.email));
    const mine = await t1.post('/api/selection/resolve', { batch_ids: [w.batches.roboA] });
    expect(mine.body.data.unique_learners).toBeGreaterThanOrEqual(2);
    const notMine = await t1.post('/api/selection/resolve', { batch_ids: [w.batches.pyB] });
    expect(notMine.body.data).toMatchObject({ selected_batches: 0, unique_learners: 0 });
    const everyone = await t1.post('/api/selection/resolve', { all_learners: true });
    expect(everyone.body.data.unique_learners).toBe(mine.body.data.unique_learners);   // scope applies even to "all"
  });
});

describe('bulk action engine', () => {
  it('previews with dry_run, refuses to execute without confirmation', async () => {
    const sel = { batch_ids: [w.batches.roboA, w.batches.roboB] };
    const dry = await w.admin.post('/api/bulk/learners', { action: 'assign_batch', batch_id: w.batches.aiC, selection: sel, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dry_run: true, unique_learners: 2, duplicates_removed: 1 });
    const noConfirm = await w.admin.post('/api/bulk/learners', { action: 'assign_batch', batch_id: w.batches.aiC, selection: sel });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE batch_id = $1`, [w.batches.aiC]))!.n).toBe(0);
  });

  it('assigns a batch to unique learners only, once each, with timeline entries', async () => {
    const target = (await w.admin.post('/api/batches', { name: `Bulk Target ${uniq()}`, program_id: w.program, course_id: w.coursePython, academic_year: '2026-27' })).body.data.id;
    const r = await w.admin.post('/api/bulk/learners', { action: 'assign_batch', batch_id: target, confirm: true, selection: { batch_ids: [w.batches.roboA, w.batches.roboB] } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ unique_learners: 2, joined: 2, affected: 2 });
    expect((await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE batch_id = $1`, [target]))!.n).toBe(2);
    const again = await w.admin.post('/api/bulk/learners', { action: 'assign_batch', batch_id: target, confirm: true, selection: { batch_ids: [w.batches.roboA] } });
    expect(again.body.data).toMatchObject({ joined: 0, already_member: 2 });
    const tl = (await w.admin.get(`/api/learners/${rahul.id}/timeline`)).body.data.filter((e: any) => e.batch_id === target);
    expect(tl).toHaveLength(1);
    const audit = await queryOne(`SELECT new_data FROM audit_logs WHERE action = 'learner.bulk_assign_batch' AND org_id = $1 ORDER BY id DESC LIMIT 1`, [w.orgId]);
    expect(audit!.new_data.unique_learners).toBe(2);
  });

  it('bulk assignment is all-or-nothing when capacity would be exceeded', async () => {
    const tiny = (await w.admin.post('/api/batches', { name: `Tiny ${uniq()}`, program_id: w.program, course_id: w.courseRobotics, academic_year: '2026-27', capacity: 1 })).body.data.id;
    const r = await w.admin.post('/api/bulk/learners', { action: 'assign_batch', batch_id: tiny, confirm: true, selection: { batch_ids: [w.batches.roboA] } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CAPACITY_EXCEEDED');
    expect((await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE batch_id = $1`, [tiny]))!.n).toBe(0);
  });

  it('removes from a batch and changes status in bulk', async () => {
    const b = (await w.admin.post('/api/batches', { name: `Rm ${uniq()}`, program_id: w.program, course_id: w.courseRobotics, academic_year: '2026-27' })).body.data.id;
    await w.admin.post('/api/bulk/learners', { action: 'assign_batch', batch_id: b, confirm: true, selection: { learner_ids: [rahul.id, aisha.id, kiran.id] } });
    const rm = await w.admin.post('/api/bulk/learners', { action: 'remove_batch', batch_id: b, confirm: true, selection: { learner_ids: [rahul.id, kiran.id, kiran.id] } });
    expect(rm.body.data).toMatchObject({ unique_learners: 2, removed: 2 });
    expect((await w.admin.get(`/api/learners/${rahul.id}`)).body.data.stats.active_batches).toBeGreaterThanOrEqual(2);   // still in robotics A/B
    const st = await w.admin.post('/api/bulk/learners', { action: 'change_status', status: 'inactive', confirm: true, selection: { learner_ids: [solo.id] } });
    expect(st.body.data).toMatchObject({ changed: 1 });
    expect((await w.admin.get(`/api/learners/${solo.id}`)).body.data.status).toBe('inactive');
  });

  it('exports respect permissions and neutralise spreadsheet formulas', async () => {
    const evil = await newLearner(w, { full_name: '=HYPERLINK("http://evil","x")', school: '+cmd|calc' });
    const r = await w.admin.post('/api/bulk/learners/export', { selection: { learner_ids: [evil.id] }, columns: ['full_name', 'school'] });
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(r.text).toContain("'+cmd|calc");
    const t1 = client(await login(w.teachers.t1.email));
    expect((await t1.post('/api/bulk/learners/export', { selection: { all_learners: true } })).status).toBe(403);
    expect((await t1.post('/api/bulk/learners', { action: 'change_status', status: 'inactive', confirm: true, selection: { all_learners: true } })).status).toBe(403);
  });
});
