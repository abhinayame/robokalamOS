import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World;
let ravi: any, meena: any, stranger: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, st: ReturnType<typeof client>, parent: ReturnType<typeof client>;
const room = () => `/api/classrooms/${w.batches.roboA}`;

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  const mk = (n: string, extra: object = {}) => newLearner(w, { full_name: n, email: `${n.toLowerCase().replace(/\W/g, '')}-${uniq()}@kids.test`, ...extra });
  ravi = await mk('Ravi Child', { parent: { full_name: 'Parent P', mobile: '9833333333', email: `pp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA] });
  meena = await mk('Meena Child', { batch_ids: [w.batches.roboA] });
  stranger = await mk('Stranger Kid', { batch_ids: [w.batches.aiC] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  for (const l of [ravi, meena, stranger]) await w.admin.post(`/api/learners/${l.id}/login`, { password: PASSWORD });
  t1 = client(await login(w.teachers.t1.email)); t2 = client(await login(w.teachers.t2.email));
  rv = client(await login(ravi.email)); mn = client(await login(meena.email)); st = client(await login(stranger.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  const lp = await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD });
  parent = client(await login(lp.body.data.email));
});

describe('manual scoring + history', () => {
  let act: string, scoreId: string;
  it('teacher creates an activity and scores a whole sheet; others cannot', async () => {
    expect((await rv.post(`${room()}/activities`, { name: 'x' })).status).toBe(403);
    expect((await t2.post(`${room()}/activities`, { name: 'x' })).status).toBe(404);
    expect((await t1.post(`${room()}/activities`, { name: '', max_score: 10 })).status).toBe(400);
    const a = await t1.post(`${room()}/activities`, { name: 'Robotics Project', category: 'Project', max_score: 100 });
    expect(a.status).toBe(201); act = a.body.data.id;
    const sheet = await t1.get(`${room()}/activities/${act}/scores`);
    expect(sheet.body.data.rows).toHaveLength(2);
    const save = await t1.put(`${room()}/activities/${act}/scores`, { entries: [
      { learner_id: ravi.id, score: 92, feedback: 'Excellent design thinking' }, { learner_id: meena.id, score: 70 },
      { learner_id: ravi.id, score: 90, feedback: 'Excellent design thinking' } ] });   // duplicate learner: merged, last wins
    expect(save.status).toBe(200);
    expect(save.body.data.created).toBe(2);
    expect((await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: stranger.id, score: 5 }] })).status).toBe(400);
    expect((await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: ravi.id, score: 101 }] })).status).toBe(400);
    expect((await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: ravi.id, score: -1 }] })).status).toBe(400);
    expect((await rv.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: ravi.id, score: 100 }] })).status).toBe(403);
    expect((await mn.get(`${room()}/activities/${act}/scores`)).status).toBe(403);
  });
  it('changing a score is audited with previous and new values; unchanged saves add nothing', async () => {
    const list = await t1.get(`/api/scores?learner_id=${ravi.id}`);
    expect(list.body.data).toHaveLength(1);
    scoreId = list.body.data[0].id;
    expect(list.body.data[0].score).toBe(90);
    expect((await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: ravi.id, score: 90, feedback: 'Excellent design thinking' }] })).body.data.unchanged).toBe(1);
    expect((await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: ravi.id, score: 95, feedback: 'Even better' }] })).body.data.updated).toBe(1);
    const h = await t1.get(`/api/scores/${scoreId}/history`);
    expect(h.body.data.map((r: any) => r.action)).toEqual(['updated', 'created']);
    expect(h.body.data[0]).toMatchObject({ previous_score: 90, new_score: 95, changed_by: 'Teacher t1' });
    expect((await rv.get(`/api/scores/${scoreId}/history`)).status).toBe(200);
    expect((await mn.get(`/api/scores/${scoreId}/history`)).status).toBe(404);
    expect((await t2.get(`/api/scores/${scoreId}/history`)).status).toBe(404);
  });
  it('privacy: learners see own scores only; parents see the child; strangers and other orgs get 404', async () => {
    expect((await rv.get('/api/scores')).body.data).toHaveLength(1);
    expect((await mn.get(`/api/scores?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await parent.get('/api/scores')).body.data[0].score).toBe(95);
    expect((await t2.get(`/api/scores?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await other.admin.get(`/api/scores?learner_id=${ravi.id}`)).status).toBe(404);
    expect((await rv.del(`/api/scores/${scoreId}`)).status).toBe(403);
  });
  it('clearing a score keeps the trail and frees the slot', async () => {
    await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: meena.id, score: null }] });
    expect((await mn.get('/api/scores')).body.data).toHaveLength(0);
    const rows = await query(`SELECT action FROM score_history h JOIN scores s ON s.id = h.score_id WHERE s.learner_id = $1 ORDER BY h.id`, [meena.id]);
    expect(rows.map((r) => r.action)).toEqual(['created', 'deleted']);
    expect((await t1.put(`${room()}/activities/${act}/scores`, { entries: [{ learner_id: meena.id, score: 60 }] })).body.data.created).toBe(1);
  });
  it('assignment evaluation requires a score and writes it to the gradebook', async () => {
    const a = await t1.post(`${room()}/assignments`, { title: 'Line follower', max_marks: 50 });
    const aid = a.body.data.id;
    const sub = await rv.put(`/api/assignments/${aid}/submission`, { body: 'done', submit: true });
    expect((await t1.post(`/api/submissions/${sub.body.data.id}/review`, { action: 'evaluate' })).status).toBe(400);
    expect((await t1.post(`/api/submissions/${sub.body.data.id}/review`, { action: 'evaluate', score: 51 })).status).toBe(400);
    expect((await t1.post(`/api/submissions/${sub.body.data.id}/review`, { action: 'evaluate', score: 45, feedback: 'Good' })).status).toBe(200);
    const d = await rv.get(`/api/assignments/${aid}`);
    expect(d.body.data.submission.score).toBe(45);
    expect((await mn.get(`/api/assignments/${aid}`)).body.data.submission).toBeNull();
    // re-evaluating updates the same score and extends the history
    await t1.post(`/api/submissions/${sub.body.data.id}/review`, { action: 'evaluate', score: 48 });
    const sc = (await rv.get(`/api/scores?type=assignment`)).body.data;
    expect(sc).toHaveLength(1); expect(sc[0].score).toBe(48);
    expect((await t1.get(`/api/scores/${sc[0].id}/history`)).body.data).toHaveLength(2);
  });
});

describe('gradebook', () => {
  it('managers see everyone with totals; learners only themselves; parents their child', async () => {
    const g = await t1.get(`${room()}/gradebook`);
    expect(g.status).toBe(200);
    expect(g.body.data.rows).toHaveLength(2);
    expect(g.body.data.columns.map((c: any) => c.type).sort()).toEqual(['activity', 'assignment']);
    const r = g.body.data.rows.find((x: any) => x.full_name === 'Ravi Child');
    expect(r.summary.scored).toBe(2);
    expect(r.summary.total).toBe(95 + 48);
    expect(r.summary.max_total).toBe(150);
    expect(r.summary.completion_pct).toBe(100);
    expect(r.summary.performance).toBe('excellent');
    const m = g.body.data.rows.find((x: any) => x.full_name === 'Meena Child');
    expect(m.summary.scored).toBe(1);
    expect(m.summary.completion_pct).toBe(50);
    const mine = await rv.get(`${room()}/gradebook`);
    expect(mine.body.data.rows.map((x: any) => x.full_name)).toEqual(['Ravi Child']);
    expect(mine.body.data.rows[0].learner_code).toBeUndefined();
    expect((await rv.get(`${room()}/gradebook?learner_id=${meena.id}`)).body.data.rows).toHaveLength(0);
    expect((await parent.get(`${room()}/gradebook`)).body.data.rows).toHaveLength(1);
    expect((await t2.get(`${room()}/gradebook`)).status).toBe(404);
    expect((await st.get(`${room()}/gradebook`)).status).toBe(404);
  });
  it('filters by type, category, date and search', async () => {
    expect((await t1.get(`${room()}/gradebook?type=activity`)).body.data.columns).toHaveLength(1);
    expect((await t1.get(`${room()}/gradebook?category=Project`)).body.data.columns).toHaveLength(1);
    expect((await t1.get(`${room()}/gradebook?from=2000-01-01&to=2000-01-02`)).body.data.columns).toHaveLength(0);
    expect((await t1.get(`${room()}/gradebook?search=Meena`)).body.data.rows).toHaveLength(1);
  });
});

describe('quizzes', () => {
  let quizId: string;
  const questions = [
    { kind: 'single', prompt: '2+2?', options: ['3', '4', '5'], answer_key: 1, marks: 2 },
    { kind: 'multiple', prompt: 'Primes?', options: ['2', '3', '4', '5'], answer_key: [0, 1, 3], marks: 3 },
    { kind: 'short', prompt: 'Capital of India?', answer_key: ['New Delhi', 'Delhi'], marks: 1 },
  ];
  it('authoring: validation, publish rules, learners never see drafts or keys', async () => {
    expect((await rv.post('/api/quizzes', { batch_id: w.batches.roboA, title: 'x' })).status).toBe(403);
    expect((await t2.post('/api/quizzes', { batch_id: w.batches.roboA, title: 'x' })).status).toBe(404);
    const q = await t1.post('/api/quizzes', { batch_id: w.batches.roboA, title: 'Sensors quiz', time_limit_minutes: 30, max_attempts: 2, reveal_answers: true });
    expect(q.status).toBe(201); quizId = q.body.data.id;
    expect((await t1.post(`/api/quizzes/${quizId}/publish`, { published: true })).status).toBe(400);     // no questions
    expect((await t1.put(`/api/quizzes/${quizId}/questions`, { questions: [{ kind: 'single', prompt: 'x', options: ['a', 'b'], answer_key: 5 }] })).status).toBe(400);
    expect((await t1.put(`/api/quizzes/${quizId}/questions`, { questions })).status).toBe(200);
    expect((await rv.get(`/api/quizzes/${quizId}`)).status).toBe(404);                                     // draft
    expect((await rv.get(`/api/quizzes?batch_id=${w.batches.roboA}`)).body.data).toHaveLength(0);
    expect((await t1.post(`/api/quizzes/${quizId}/publish`, { published: true })).status).toBe(200);
    const view = await rv.get(`/api/quizzes/${quizId}`);
    expect(view.body.data.questions).toBeUndefined();
    expect(view.body.data.availability).toBe('open');
    expect((await st.get(`/api/quizzes/${quizId}`)).status).toBe(404);
    expect((await t1.get(`/api/quizzes/${quizId}`)).body.data.questions[0].answer_key).toBe(1);
  });
  it('attempt: questions have no answer keys; grading is server-side; best attempt goes to the gradebook', async () => {
    expect((await parent.post(`/api/quizzes/${quizId}/attempts`)).status).toBe(403);
    expect((await st.post(`/api/quizzes/${quizId}/attempts`)).status).toBe(404);
    const s = await rv.post(`/api/quizzes/${quizId}/attempts`);
    expect(s.status).toBe(201);
    expect(JSON.stringify(s.body.data.questions)).not.toMatch(/answer_key/);
    expect(s.body.data.deadline_at).toBeTruthy();
    const again = await rv.post(`/api/quizzes/${quizId}/attempts`);
    expect(again.status).toBe(200); expect(again.body.data.attempt_id).toBe(s.body.data.attempt_id);   // resumes, no second attempt
    const ids = s.body.data.questions.map((x: any) => x.id);
    const sub = await rv.post(`/api/quizzes/attempts/${s.body.data.attempt_id}/submit`, { answers: { [ids[0]]: 1, [ids[1]]: [0, 1], [ids[2]]: '  new   delhi ' } });
    expect(sub.status).toBe(200);
    expect(sub.body.data).toMatchObject({ score: 3, max_score: 6, status: 'submitted' });          // multiple needs an exact set
    expect(sub.body.data.review).toHaveLength(3);
    expect((await rv.post(`/api/quizzes/attempts/${s.body.data.attempt_id}/submit`, { answers: {} })).status).toBe(409);
    expect((await mn.get(`/api/quizzes/attempts/${s.body.data.attempt_id}`)).status).toBe(404);
    // second attempt improves the score; third is refused
    const s2 = await rv.post(`/api/quizzes/${quizId}/attempts`);
    const ids2 = s2.body.data.questions.map((x: any) => x.id);
    const r2 = await rv.post(`/api/quizzes/attempts/${s2.body.data.attempt_id}/submit`, { answers: { [ids2[0]]: 1, [ids2[1]]: [0, 1, 3], [ids2[2]]: 'Delhi' } });
    expect(r2.body.data.score).toBe(6);
    expect((await rv.post(`/api/quizzes/${quizId}/attempts`)).status).toBe(409);
    const q = (await rv.get('/api/scores?type=quiz')).body.data;
    expect(q).toHaveLength(1); expect(q[0].score).toBe(6);
    // a worse retake never lowers the recorded best
    await query(`UPDATE quizzes SET max_attempts = 5 WHERE id = $1`, [quizId]);
    const s3 = await rv.post(`/api/quizzes/${quizId}/attempts`);
    await rv.post(`/api/quizzes/attempts/${s3.body.data.attempt_id}/submit`, { answers: {} });
    expect((await rv.get('/api/scores?type=quiz')).body.data[0].score).toBe(6);
  });
  it('locks questions after attempts; enforces the time limit; manager sees attempts', async () => {
    expect((await t1.put(`/api/quizzes/${quizId}/questions`, { questions })).status).toBe(409);
    expect((await t1.post(`/api/quizzes/${quizId}/publish`, { published: false })).status).toBe(409);
    expect((await t1.patch(`/api/quizzes/${quizId}`, { max_attempts: 9 })).status).toBe(409);
    expect((await t1.get(`/api/quizzes/${quizId}/attempts`)).body.data.length).toBe(3);
    expect((await rv.get(`/api/quizzes/${quizId}/attempts`)).status).toBe(403);
    const z = await t1.post('/api/quizzes', { batch_id: w.batches.roboA, title: 'Timed', time_limit_minutes: 1 });
    await t1.put(`/api/quizzes/${z.body.data.id}/questions`, { questions: [questions[0]] });
    await t1.post(`/api/quizzes/${z.body.data.id}/publish`, { published: true });
    const s = await mn.post(`/api/quizzes/${z.body.data.id}/attempts`);
    await query(`UPDATE quiz_attempts SET deadline_at = DATE_SUB(NOW(3), INTERVAL 5 MINUTE) WHERE id = $1`, [s.body.data.attempt_id]);
    const late = await mn.post(`/api/quizzes/attempts/${s.body.data.attempt_id}/submit`, { answers: { [s.body.data.questions[0].id]: 1 } });
    expect(late.body.data).toMatchObject({ status: 'expired', score: 0 });
    // closed windows
    const c = await t1.post('/api/quizzes', { batch_id: w.batches.roboA, title: 'Closed', closes_at: new Date(Date.now() + 3600e3).toISOString() });
    await t1.put(`/api/quizzes/${c.body.data.id}/questions`, { questions: [questions[0]] });
    await t1.post(`/api/quizzes/${c.body.data.id}/publish`, { published: true });
    await query(`UPDATE quizzes SET closes_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id = $1`, [c.body.data.id]);
    expect((await mn.post(`/api/quizzes/${c.body.data.id}/attempts`)).status).toBe(409);
    expect((await t1.post('/api/quizzes', { batch_id: w.batches.roboA, title: 'Bad window', opens_at: '2030-01-02T00:00:00Z', closes_at: '2030-01-01T00:00:00Z' })).status).toBe(400);
  });
  it('quiz shows in the gradebook; deleting removes its scores with a trail', async () => {
    const g = (await t1.get(`${room()}/gradebook?type=quiz`)).body.data;
    expect(g.columns.map((c: any) => c.name)).toContain('Sensors quiz');
    expect((await t1.del(`/api/quizzes/${quizId}`)).status).toBe(200);
    expect((await rv.get('/api/scores?type=quiz')).body.data).toHaveLength(0);
    expect((await rv.get(`/api/quizzes/${quizId}`)).status).toBe(404);
  });
});
