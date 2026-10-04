import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { randomUUID } from 'node:crypto';

let w: World, other: World;
let ravi: any, meena: any, stranger: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, parent: ReturnType<typeof client>;
const G = '/api/gamification';
const room = () => `/api/classrooms/${w.batches.roboA}`;

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  const mk = (n: string, extra: object = {}) => newLearner(w, { full_name: n, email: `${n.toLowerCase().replace(/\W/g, '')}-${uniq()}@kids.test`, ...extra });
  ravi = await mk('Ravi Child', { parent: { full_name: 'Parent P', mobile: '9844444444', email: `pp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA] });
  meena = await mk('Meena Child', { batch_ids: [w.batches.roboA] });
  stranger = await mk('Stranger Kid', { batch_ids: [w.batches.aiC] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  for (const l of [ravi, meena, stranger]) await w.admin.post(`/api/learners/${l.id}/login`, { password: PASSWORD });
  t1 = client(await login(w.teachers.t1.email)); t2 = client(await login(w.teachers.t2.email));
  rv = client(await login(ravi.email)); mn = client(await login(meena.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
});

describe('XP ledger', () => {
  it('teacher awards XP inside their batch only; bad input is rejected', async () => {
    const ok = await t1.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [ravi.id, meena.id, ravi.id], points: 20, reason: 'Class participation' });
    expect(ok.status).toBe(201); expect(ok.body.data).toMatchObject({ awarded: 2, learners: 2 });   // duplicate learner merged
    expect((await t2.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: 5, reason: 'not allowed' })).status).toBe(404);
    expect((await t1.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [stranger.id], points: 5, reason: 'not allowed' })).status).toBe(400);   // not in batch
    expect((await t1.post(`${G}/xp`, { learner_ids: [ravi.id], points: 5, reason: 'no batch' })).status).toBe(400);
    expect((await t1.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: -5, reason: 'deduct' })).status).toBe(400);
    expect((await t1.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: 5000, reason: 'too much' })).status).toBe(400);
    expect((await t1.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: 0, reason: 'zero' })).status).toBe(400);
    expect((await rv.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: 50, reason: 'self award' })).status).toBe(403);
    expect((await parent.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: 50, reason: 'ok then' })).status).toBe(403);
    expect((await other.admin.post(`${G}/xp`, { learner_ids: [ravi.id], points: 5, reason: 'ok then' })).status).toBe(404);
  });
  it('is idempotent with a request id; balance is the sum of the ledger; admins can correct with negatives', async () => {
    const request_id = randomUUID();
    const body = { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: 30, reason: 'Great project', request_id };
    expect((await t1.post(`${G}/xp`, body)).body.data.awarded).toBe(1);
    expect((await t1.post(`${G}/xp`, body)).body.data).toMatchObject({ awarded: 0, duplicate: 1 });
    expect((await rv.get(`${G}/overview`)).body.data.xp).toBe(50);
    expect((await w.admin.post(`${G}/xp`, { batch_id: w.batches.roboA, learner_ids: [ravi.id], points: -10, reason: 'Correction' })).status).toBe(201);
    const o = (await rv.get(`${G}/overview`)).body.data;
    expect(o.xp).toBe(40);
    expect(o.level.name).toBe('Explorer'); expect(o.next.name).toBe('Learner'); expect(o.xp_to_next).toBe(61);
    const sum = (await query(`SELECT SUM(points) AS n FROM xp_transactions WHERE learner_id = $1`, [ravi.id]))[0].n;
    expect(Number(sum)).toBe(40);
    const ledger = await rv.get(`${G}/xp`);
    expect(ledger.body.data).toHaveLength(3); expect(ledger.body.meta.balance).toBe(40);
  });
  it('privacy: only own/child/scoped learners', async () => {
    expect((await mn.get(`${G}/overview?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await parent.get(`${G}/overview`)).body.data.xp).toBe(40);
    expect((await t2.get(`${G}/overview?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await other.admin.get(`${G}/xp?learner_id=${ravi.id}`)).status).toBe(404);
  });
  it('a ledger row can never be changed or removed through the API, and bonus XP on scores is net-idempotent', async () => {
    const act = (await t1.post(`${room()}/activities`, { name: 'Project', max_score: 100 })).body.data.id;
    const save = (bonus: number) => t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: meena.id, score: 80, bonus_xp: bonus }] });
    await save(50); await save(50);
    expect((await mn.get(`${G}/overview`)).body.data.xp).toBe(20 + 50);
    await save(30);
    expect((await mn.get(`${G}/overview`)).body.data.xp).toBe(20 + 30);
    await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: meena.id, score: null }] });   // clearing the score reverses its bonus
    expect((await mn.get(`${G}/overview`)).body.data.xp).toBe(20);
    const net = (await mn.get(`${G}/xp`)).body.data.filter((x: any) => x.source_type === 'score');
    expect(net.length).toBeGreaterThanOrEqual(3);   // award, adjustment, reversal: nothing was edited or deleted
    expect(net.reduce((a: number, x: any) => a + x.points, 0)).toBe(0);
  });
});

describe('badges + achievement wall', () => {
  let badgeId: string;
  it('only admins define badges; duplicates are refused', async () => {
    expect((await t1.post(`${G}/badges`, { name: 'Star Learner' })).status).toBe(403);
    const b = await w.admin.post(`${G}/badges`, { name: 'Innovation Champion', icon: '💡', category: 'Innovation', xp_reward: 50, description: 'Outstanding idea' });
    expect(b.status).toBe(201); badgeId = b.body.data.id;
    expect((await w.admin.post(`${G}/badges`, { name: 'Innovation Champion' })).status).toBe(409);
    expect((await t1.get(`${G}/badges`)).body.data.map((x: any) => x.name)).toContain('Innovation Champion');
  });
  it('teacher awards (XP reward credited once); re-award is skipped; scope enforced', async () => {
    const a = await t1.post(`${G}/badges/${badgeId}/award`, { batch_id: w.batches.roboA, learner_ids: [ravi.id, ravi.id], reason: 'Robotics project' });
    expect(a.status).toBe(201); expect(a.body.data).toMatchObject({ awarded: 1, xp_granted: 50 });
    expect((await t1.post(`${G}/badges/${badgeId}/award`, { batch_id: w.batches.roboA, learner_ids: [ravi.id] })).body.data).toMatchObject({ awarded: 0, already_has: 1 });
    expect((await rv.get(`${G}/overview`)).body.data.xp).toBe(90);
    expect((await t2.post(`${G}/badges/${badgeId}/award`, { batch_id: w.batches.roboA, learner_ids: [ravi.id] })).status).toBe(404);
    expect((await rv.post(`${G}/badges/${badgeId}/award`, { batch_id: w.batches.roboA, learner_ids: [ravi.id] })).status).toBe(403);
  });
  it('achievement wall shows badge, teacher, reason and XP; others cannot see it', async () => {
    const wall = (await rv.get(`${G}/achievements`)).body.data;
    expect(wall).toHaveLength(1);
    expect(wall[0]).toMatchObject({ name: 'Innovation Champion', icon: '💡', awarded_by: 'Teacher t1', reason: 'Robotics project', xp_awarded: 50 });
    expect((await parent.get(`${G}/achievements`)).body.data).toHaveLength(1);
    expect((await mn.get(`${G}/achievements?learner_id=${ravi.id}`)).status).toBe(404);
  });
  it('inactive badges cannot be awarded; revoking reverses XP and keeps the trail', async () => {
    const wall = (await rv.get(`${G}/achievements`)).body.data[0];
    expect((await mn.post(`${G}/learner-badges/${wall.id}/revoke`, { reason: 'ok then' })).status).toBe(403);
    expect((await t2.post(`${G}/learner-badges/${wall.id}/revoke`, { reason: 'mistake' })).status).toBe(404);
    expect((await t1.post(`${G}/learner-badges/${wall.id}/revoke`, { reason: 'Awarded by mistake' })).status).toBe(200);
    expect((await rv.get(`${G}/achievements`)).body.data).toHaveLength(0);
    expect((await rv.get(`${G}/overview`)).body.data.xp).toBe(40);
    const rows = await query(`SELECT points FROM xp_transactions WHERE source_type = 'badge' AND learner_id = $1 ORDER BY id`, [ravi.id]);
    expect(rows.map((r) => r.points)).toEqual([50, -50]);
    expect((await t1.post(`${G}/badges/${badgeId}/award`, { batch_id: w.batches.roboA, learner_ids: [ravi.id] })).body.data.awarded).toBe(1);   // slot freed
    await w.admin.patch(`${G}/badges/${badgeId}`, { status: 'inactive' });
    expect((await t1.post(`${G}/badges/${badgeId}/award`, { batch_id: w.batches.roboA, learner_ids: [meena.id] })).status).toBe(400);
  });
});

describe('levels', () => {
  it('defaults, admin customisation with validation, reset', async () => {
    expect((await rv.get(`${G}/levels`)).body.data).toHaveLength(6);
    expect((await t1.put(`${G}/levels`, { reset: true })).status).toBe(403);
    expect((await w.admin.put(`${G}/levels`, { levels: [{ name: 'A', min_xp: 5 }] })).status).toBe(400);
    expect((await w.admin.put(`${G}/levels`, { levels: [{ name: 'A', min_xp: 0 }, { name: 'B', min_xp: 0 }] })).status).toBe(400);
    expect((await w.admin.put(`${G}/levels`, { levels: [{ name: 'Cadet', min_xp: 0 }, { name: 'Pilot', min_xp: 30 }, { name: 'Ace', min_xp: 500 }] })).status).toBe(200);
    expect((await rv.get(`${G}/overview`)).body.data.level.name).toBe('Pilot');
    expect((await other.admin.get(`${G}/levels`)).body.data).toHaveLength(6);   // other orgs unaffected
    expect((await w.admin.put(`${G}/levels`, { reset: true })).body.meta.custom).toBe(false);
  });
});

describe('leaderboard', () => {
  const lb = (c: any, q = '') => c.get(`${G}/leaderboard?scope=batch&id=${w.batches.roboA}${q}`);
  it('is off by default and only admins can switch it', async () => {
    expect((await lb(rv)).status).toBe(403);
    expect((await lb(rv)).body.error.code).toBe('LEADERBOARD_DISABLED');
    expect((await t1.put(`${G}/settings`, { leaderboard_enabled: true })).status).toBe(403);
    expect((await w.admin.put(`${G}/settings`, { leaderboard_enabled: true })).status).toBe(200);
  });
  it('ranks by batch XP with ties; scope and privacy are enforced', async () => {
    const r = await lb(rv);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => [x.full_name, x.xp, x.rank])).toEqual([['Ravi Child', 90, 1], ['Meena Child', 20, 2]]);
    expect(r.body.data[0].is_me).toBe(true);
    expect(JSON.stringify(r.body.data)).not.toMatch(/learner_code|email|mobile/);
    expect((await lb(t2)).status).toBe(404);
    expect((await lb(client(await login(stranger.email)))).status).toBe(404);
    expect([403, 404]).toContain((await lb(other.admin)).status);   // other org: disabled there, and never leaks this org's batch
    expect((await rv.get(`${G}/leaderboard?scope=all`)).status).toBe(403);
    expect((await w.admin.get(`${G}/leaderboard?scope=all`)).body.data.length).toBeGreaterThan(0);
    expect((await lb(rv, '&period=week')).body.data).toHaveLength(2);
    await query(`UPDATE xp_transactions SET created_at = DATE_SUB(NOW(3), INTERVAL 40 DAY) WHERE learner_id = $1`, [meena.id]);
    expect((await lb(rv, '&period=month')).body.data.map((x: any) => x.full_name)).toEqual(['Ravi Child']);
    expect((await lb(rv, '&period=all')).body.data).toHaveLength(2);
  });
  it('shows the caller their own rank outside the top N', async () => {
    const r = await mn.get(`${G}/leaderboard?scope=batch&id=${w.batches.roboA}&limit=1`);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.meta.me[0]).toMatchObject({ rank: 2, xp: 20 });
  });
  it('can be switched off again', async () => {
    await w.admin.put(`${G}/settings`, { leaderboard_enabled: false });
    expect((await lb(rv)).status).toBe(403);
  });
});

describe('bulk award via the selection engine', () => {
  it('previews, requires confirmation, de-duplicates learners across batches, and respects scope', async () => {
    await w.admin.post(`/api/learners/${ravi.id}/batches`, { batch_id: w.batches.roboB });
    const selection = { batch_ids: [w.batches.roboA, w.batches.roboB] };
    const action = { action: 'award_xp', points: 10, reason: 'Hackathon', selection };
    const dry = await w.admin.post('/api/bulk/learners', { ...action, dry_run: true });
    expect(dry.body.data.unique_learners).toBe(2); expect(dry.body.data.batch_memberships).toBe(3);
    expect((await w.admin.post('/api/bulk/learners', action)).status).toBe(400);
    const before = (await rv.get(`${G}/overview`)).body.data.xp;
    const done = await w.admin.post('/api/bulk/learners', { ...action, confirm: true });
    expect(done.status).toBe(200); expect(done.body.data.awarded).toBe(2);
    expect((await rv.get(`${G}/overview`)).body.data.xp).toBe(before + 10);   // Ravi is in two batches but gets it once
    // teacher: only their own batch's learners, and a badge via the same engine
    const b = (await w.admin.post(`${G}/badges`, { name: 'Team Player', xp_reward: 5 })).body.data.id;
    const t = await t1.post('/api/bulk/learners', { action: 'award_badge', badge_id: b, reason: 'Teamwork', batch_id: w.batches.roboA, selection: { batch_ids: [w.batches.roboA] }, confirm: true });
    expect(t.status).toBe(200); expect(t.body.data).toMatchObject({ awarded: 2, xp_granted: 10 });
    const out = await t1.post('/api/bulk/learners', { action: 'award_xp', points: 5, reason: 'ok then', selection: { batch_ids: [w.batches.aiC] }, confirm: true });
    expect([400, 404]).toContain(out.status);
    expect((await rv.post('/api/bulk/learners', { ...action, confirm: true })).status).toBe(403);
  });
});
