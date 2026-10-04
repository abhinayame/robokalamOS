import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { buildWorld, client, enroll, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World;
let ravi: any, meena: any, noBatch: any, stranger: any;
let t1: ReturnType<typeof client>, c1: ReturnType<typeof client>, c2: ReturnType<typeof client>, rv: ReturnType<typeof client>, parent: ReturnType<typeof client>;
let c1id = '', c2id = '';
const future = (h = 48) => new Date(Date.now() + h * 3600e3).toISOString();

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  const mk = (n: string, extra: object = {}) => newLearner(w, { full_name: n, email: `${n.toLowerCase().replace(/\W/g, '')}-${uniq()}@kids.test`, ...extra });
  ravi = await mk('Ravi Child', { parent: { full_name: 'Parent P', mobile: '9866666666', email: `pp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA, w.batches.pyB] });
  meena = await mk('Meena Child', { batch_ids: [w.batches.roboA] });
  noBatch = await mk('Lead Kid');
  stranger = await mk('Stranger Kid', { batch_ids: [w.batches.aiC] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD });
  const mkC = async (n: string) => { const e = `${n.replace(/\s+/g, "").toLowerCase()}-${uniq()}@test.dev`; const r = await w.admin.post('/api/users', { full_name: n, email: e, password: PASSWORD, roles: [{ role: 'counsellor' }] }); if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return { id: (r.body.data.id ?? r.body.data.user?.id) as string, email: e }; };
  const a = await mkC('Counsellor One'); const b = await mkC('Counsellor Two'); c1id = a.id; c2id = b.id;
  t1 = client(await login(w.teachers.t1.email)); c1 = client(await login(a.email)); c2 = client(await login(b.email)); rv = client(await login(ravi.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
});

describe('access', () => {
  it('only CRM staff reach the CRM; teachers, learners and parents are refused', async () => {
    for (const c of [t1, rv, parent]) { expect((await c.get('/api/crm/leads')).status).toBe(403); expect((await c.post('/api/crm/leads', { learner_id: ravi.id })).status).toBe(403); }
    expect((await c1.get('/api/crm/leads')).status).toBe(200);
    expect((await other.admin.get(`/api/crm/learners/${ravi.id}`)).status).toBe(404);
    expect((await other.admin.post('/api/crm/leads', { learner_id: ravi.id })).status).toBe(404);
  });
});

describe('tags', () => {
  let hp = '', na = '';
  it('admins/counsellors manage tags; teachers can apply but not manage; learners never see tags', async () => {
    expect((await t1.post('/api/tags', { name: 'x' })).status).toBe(403);
    const a = await c1.post('/api/tags', { name: 'High Performer', color: 'green' }); expect(a.status).toBe(201); hp = a.body.data.id;
    na = (await c1.post('/api/tags', { name: 'Needs Attention', color: 'red' })).body.data.id;
    expect((await c1.post('/api/tags', { name: 'High Performer' })).status).toBe(409);
    expect((await rv.get('/api/tags')).status).toBe(403); expect((await parent.get('/api/tags')).status).toBe(403);
    expect((await t1.get('/api/tags')).body.data.map((x: any) => x.name)).toContain('High Performer');
    const r = await t1.post('/api/tags/apply', { learner_ids: [ravi.id, ravi.id, meena.id], add: [hp] });
    expect(r.body.data).toEqual({ added: 2, removed: 0 });
    expect((await t1.post('/api/tags/apply', { learner_ids: [ravi.id], add: [hp] })).body.data.added).toBe(0);   // idempotent
    expect((await t1.post('/api/tags/apply', { learner_ids: [stranger.id], add: [hp] })).status).toBe(404);       // outside the teacher's batches
    expect((await t1.post('/api/tags/apply', { learner_ids: [ravi.id], add: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(404);
    expect((await other.admin.post('/api/tags/apply', { learner_ids: [ravi.id], add: [hp] })).status).toBe(404);
    expect((await w.admin.get(`/api/learners/${ravi.id}`)).body.data.tags.map((t: any) => t.name)).toEqual(['High Performer']);
    expect((await rv.get(`/api/learners/${ravi.id}`)).body.data.tags).toBeUndefined();
    expect((await parent.get(`/api/learners/${ravi.id}`)).body.data.tags).toBeUndefined();
  });
  it('the learner filter engine and selection engine filter by tag', async () => {
    expect((await c1.get(`/api/learners?tag_id=${hp}`)).body.data.map((l: any) => l.full_name).sort()).toEqual(['Meena Child', 'Ravi Child']);
    expect((await c1.get(`/api/learners?tag_id=${na}`)).body.data).toHaveLength(0);
    expect((await c1.get(`/api/learners?tag_id=${hp}`)).body.data[0].tags[0].name).toBe('High Performer');
    const sum = await c1.post('/api/selection/resolve', { filters: { tag_id: [hp] } });
    expect(sum.body.data.unique_learners).toBe(2);
  });
  it('removing and deleting tags', async () => {
    expect((await t1.post('/api/tags/apply', { learner_ids: [meena.id], remove: [hp] })).body.data).toEqual({ added: 0, removed: 1 });
    const del = await c1.del(`/api/tags/${na}`); expect(del.body.data.deleted).toBe(true);
    expect((await t1.del(`/api/tags/${hp}`)).status).toBe(403);
  });
});

describe('leads and the pipeline', () => {
  it('creates a lead on an existing learner (one record only), validates, and notifies the counsellor', async () => {
    expect((await c1.post('/api/crm/leads', { learner_id: noBatch.id, lead_source: 'Instagram', temperature: 'hot', counsellor_user_id: w.teachers.t1.id })).status).toBe(400);   // a teacher cannot be assigned
    expect((await c1.post('/api/crm/leads', { learner_id: noBatch.id, interested_course_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    const r = await c1.post('/api/crm/leads', { learner_id: noBatch.id, lead_source: 'Instagram', temperature: 'hot', counsellor_user_id: c2id, interested_course_id: w.courseRobotics });
    expect(r.status).toBe(201);
    expect((await c1.post('/api/crm/leads', { learner_id: noBatch.id })).status).toBe(400);   // already a lead
    expect((await c2.get('/api/notifications')).body.data.some((n: any) => n.kind === 'lead.assigned')).toBe(true);
    const list = (await c1.get('/api/crm/leads')).body;
    expect(list.data[0]).toMatchObject({ full_name: 'Lead Kid', lead_status: 'new', lead_source: 'Instagram', counsellor_name: 'Counsellor Two', interested_course: 'Robotics' });
    expect(list.meta.status_counts.new).toBe(1);
    expect(await query(`SELECT COUNT(*) AS n FROM learners WHERE id = $1`, [noBatch.id]).then((x) => Number(x[0].n))).toBe(1);   // no copy was made
  });
  it('status changes are logged; lost needs a reason; closing the pipeline cancels follow-ups', async () => {
    const id = noBatch.id;
    expect((await c1.patch(`/api/crm/leads/${id}`, { lead_status: 'lost' })).status).toBe(400);
    expect((await c1.patch(`/api/crm/leads/${id}`, { lead_status: 'contacted', temperature: 'warm' })).status).toBe(200);
    const fu = await c1.post(`/api/crm/learners/${id}/follow-ups`, { due_at: future(24), note: 'Call back', assigned_to: c2id });
    expect(fu.status).toBe(201);
    expect((await c1.get(`/api/crm/leads`)).body.data[0].next_follow_up_at).toBeTruthy();
    expect((await c1.patch(`/api/crm/leads/${id}`, { lead_status: 'lost', lost_reason: 'Joined elsewhere' })).status).toBe(200);
    const v = (await c1.get(`/api/crm/learners/${id}`)).body.data;
    expect(v.lead.lead_status).toBe('lost'); expect(v.lead.next_follow_up_at).toBeNull();
    expect(v.follow_ups.find((f: any) => f.id === fu.body.data.id).status).toBe('cancelled');
    expect(v.activities.map((a: any) => a.type)).toContain('status_changed');
    expect((await c1.patch(`/api/crm/leads/${id}`, { lead_status: 'interested' })).status).toBe(200);   // a lost lead can be reopened
  });
  it('activities, follow-ups and their effect on the lead', async () => {
    const id = noBatch.id;
    expect((await c1.post(`/api/crm/learners/${id}/activities`, { type: 'note' })).status).toBe(400);
    expect((await c1.post(`/api/crm/learners/${id}/activities`, { type: 'called_parent', next_follow_up_at: new Date(Date.now() - 86400e3).toISOString() })).status).toBe(400);
    const a = await c1.post(`/api/crm/learners/${id}/activities`, { type: 'called_parent', description: 'Parent wants a demo', lead_status: 'demo_scheduled', next_follow_up_at: future(72), assigned_to: c2id });
    expect(a.status).toBe(201); expect(a.body.data.follow_up_id).toBeTruthy();
    expect((await c2.get('/api/notifications')).body.data.some((n: any) => n.kind === 'followup.assigned')).toBe(true);
    const mine = (await c2.get('/api/crm/follow-ups?who=mine&bucket=upcoming')).body.data;
    expect(mine.map((f: any) => f.id)).toContain(a.body.data.follow_up_id);
    expect((await c1.get('/api/crm/follow-ups?who=mine&bucket=upcoming')).body.data.map((f: any) => f.id)).not.toContain(a.body.data.follow_up_id);
    // overdue bucket
    await query(`UPDATE follow_ups SET due_at = DATE_SUB(NOW(3), INTERVAL 2 HOUR) WHERE id = $1`, [a.body.data.follow_up_id]);
    expect((await c2.get('/api/crm/follow-ups?who=mine&bucket=overdue')).body.data[0]).toMatchObject({ overdue: true, full_name: 'Lead Kid' });
    expect((await c1.get('/api/crm/leads?follow_up=overdue')).body.data).toHaveLength(0);          // lead.next_follow_up_at was synced at creation, not by the raw SQL above
    await query(`UPDATE crm_leads SET next_follow_up_at = DATE_SUB(NOW(3), INTERVAL 2 HOUR) WHERE learner_id = $1`, [id]);
    expect((await c1.get('/api/crm/leads?follow_up=overdue')).body.data[0].overdue).toBe(true);
    // complete → logs an activity, schedules the next one, lead follows
    const done = await c2.post(`/api/crm/follow-ups/${a.body.data.follow_up_id}/complete`, { outcome: 'Demo booked', next_follow_up_at: future(120) });
    expect(done.status).toBe(200); expect(done.body.data.next_follow_up_id).toBeTruthy();
    expect((await c2.post(`/api/crm/follow-ups/${a.body.data.follow_up_id}/complete`, {})).status).toBe(400);   // already closed
    const v = (await c1.get(`/api/crm/learners/${id}`)).body.data;
    expect(new Date(v.lead.next_follow_up_at).getTime()).toBeGreaterThan(Date.now());
    expect(v.activities[0]).toMatchObject({ type: 'follow_up', description: 'Demo booked', staff_name: 'Counsellor Two' });
    expect((await c1.post(`/api/crm/follow-ups/${done.body.data.next_follow_up_id}/cancel`)).status).toBe(200);
    expect((await c1.get(`/api/crm/learners/${id}`)).body.data.lead.next_follow_up_at).toBeNull();
  });
  it('an activity can be logged for any learner, with or without a lead; status change needs a lead', async () => {
    expect((await c1.post(`/api/crm/learners/${meena.id}/activities`, { type: 'whatsapp_sent', description: 'Sent brochure' })).status).toBe(201);
    expect((await c1.post(`/api/crm/learners/${meena.id}/activities`, { type: 'note', description: 'x', lead_status: 'contacted' })).status).toBe(400);
    expect((await c1.get(`/api/crm/learners/${meena.id}`)).body.data.lead).toBeNull();
  });
  it('enrolling a lead into a batch converts it, with the same profile, and cancels open follow-ups', async () => {
    await c1.post(`/api/crm/learners/${noBatch.id}/follow-ups`, { due_at: future(10) });
    await enroll(w, noBatch.id, w.batches.roboB);
    const v = (await c1.get(`/api/crm/learners/${noBatch.id}`)).body.data;
    expect(v.lead.lead_status).toBe('converted'); expect(v.lead.converted_at).toBeTruthy(); expect(v.lead.next_follow_up_at).toBeNull();
    expect(v.activities[0].type).toBe('batch_assigned');
    expect(v.follow_ups.every((f: any) => f.status !== 'open')).toBe(true);
    expect((await c1.get('/api/crm/summary')).body.data).toMatchObject({ total: 1, converted: 1, conversion_rate: 100 });
  });
  it('CRM notes never reach the learner timeline the family can read', async () => {
    const tl = (await rv.get(`/api/learners/${ravi.id}/timeline`)).body.data;
    expect(JSON.stringify(tl)).not.toMatch(/Parent wants a demo|whatsapp_sent|lead/i);
  });
});

describe('bulk CRM actions use the selection engine', () => {
  const sel = () => ({ batch_ids: [w.batches.roboA, w.batches.pyB] });
  it('add tag: previews, needs confirmation, dedupes learners across batches', async () => {
    const tag = (await c1.post('/api/tags', { name: 'Competition Student' })).body.data.id;
    const dry = await c1.post('/api/bulk/learners', { action: 'add_tag', tag_id: tag, selection: sel(), dry_run: true });
    expect(dry.body.data).toMatchObject({ unique_learners: 2, batch_memberships: 3 });
    expect((await c1.post('/api/bulk/learners', { action: 'add_tag', tag_id: tag, selection: sel() })).status).toBe(400);
    const done = await c1.post('/api/bulk/learners', { action: 'add_tag', tag_id: tag, selection: sel(), confirm: true });
    expect(done.body.data).toMatchObject({ added: 2, already: 0 });
    expect((await c1.post('/api/bulk/learners', { action: 'add_tag', tag_id: tag, selection: sel(), confirm: true })).body.data).toMatchObject({ added: 0, already: 2 });
    expect((await c1.post('/api/bulk/learners', { action: 'remove_tag', tag_id: tag, selection: sel(), confirm: true })).body.data.removed).toBe(2);
  });
  it('assign counsellor creates leads where missing; follow-ups are created once per learner with ONE notification', async () => {
    const r = await c1.post('/api/bulk/learners', { action: 'assign_counsellor', counsellor_id: c2id, selection: sel(), confirm: true });
    expect(r.body.data).toMatchObject({ assigned: 2, leads_created: 2 });
    expect((await c1.post('/api/bulk/learners', { action: 'assign_counsellor', counsellor_id: c2id, selection: sel(), confirm: true })).body.data).toMatchObject({ assigned: 0, unchanged: 2 });
    const before = (await c2.get('/api/notifications')).body.meta.total;
    const f = await c1.post('/api/bulk/learners', { action: 'create_follow_up', assigned_to: c2id, due_at: future(30), note: 'Term renewal', selection: sel(), confirm: true });
    expect(f.body.data.created).toBe(2);
    expect((await c2.get('/api/notifications')).body.meta.total).toBe(before + 1);
    const act = await c1.post('/api/bulk/learners', { action: 'create_crm_activity', type: 'whatsapp_sent', description: 'Renewal reminder', selection: sel(), confirm: true });
    expect(act.body.data.logged).toBe(2);
    expect((await c1.get(`/api/crm/leads?counsellor_id=${c2id}`)).body.meta.total).toBeGreaterThanOrEqual(2);
    expect((await c1.get(`/api/learners?counsellor_id=${c2id}&lead_status=new`)).body.meta.total).toBe(2);
  });
  it('teachers, learners and parents cannot run CRM bulk actions; scope is enforced for staff', async () => {
    for (const c of [t1, rv, parent]) expect((await c.post('/api/bulk/learners', { action: 'assign_counsellor', counsellor_id: c2id, selection: sel(), confirm: true })).status).toBe(403);
    expect((await other.admin.post('/api/bulk/learners', { action: 'create_crm_activity', type: 'note', description: 'x', selection: { learner_ids: [ravi.id] }, confirm: true })).status).toBe(400);   // no learners match in that org
  });
});
