import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { exec, newId, query, queryOne } from '../src/db/pool.js';
import { setEmailProvider } from '../src/modules/email/provider.js';
import { setPaymentProvider } from '../src/modules/fees/razorpay.js';
import { setZoomProvider as setZoom } from '../src/modules/live/zoom.js';
import { setProvider as setWhatsApp } from '../src/modules/comms/aisensy.js';
import { runPushOnce, setPushSender } from '../src/modules/push/service.js';
import { buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World; let ravi: any, meena: any, outsider: any;
let t1: ReturnType<typeof client>, t2: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, parent: ReturnType<typeof client>, out: ReturnType<typeof client>;

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  ravi = await newLearner(w, { full_name: 'Ravi Kumar', email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Ravi Parent', mobile: '9870000031', email: `rp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA] });
  meena = await newLearner(w, { full_name: 'Meena Rao', email: `meena-${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
  outsider = await newLearner(w, { full_name: 'Out Sider', email: `out-${uniq()}@kids.test`, batch_ids: [w.batches.pyB] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  for (const l of [ravi, meena, outsider]) await w.admin.post(`/api/learners/${l.id}/login`, { password: PASSWORD });
  t1 = client(await login(w.teachers.t1.email)); t2 = client(await login(w.teachers.t2.email)); rv = client(await login(ravi.email)); mn = client(await login(meena.email)); out = client(await login(outsider.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id; parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
});

describe('provider self-test', () => {
  it('is for owners only, and runs harmless live checks that clean up after themselves', async () => {
    expect((await t1.post('/api/system/selftest/zoom')).status).toBe(403); expect((await parent.post('/api/system/selftest/email')).status).toBe(403);
    const log: string[] = [];
    setZoom({ createMeeting: async () => { log.push('zoom:create'); return { ok: true, id: 'm1', joinUrl: 'https://z' }; }, deleteMeeting: async (id) => { log.push(`zoom:delete:${id}`); }, startUrl: async () => ({ ok: false, message: 'n/a' }) } as any);
    setPaymentProvider({ createLink: async (i) => { log.push(`rzp:create:${i.amountPaise}`); return { ok: true, id: 'pl_1', shortUrl: 'https://r' }; }, cancelLink: async (id) => { log.push(`rzp:cancel:${id}`); } });
    setEmailProvider({ send: async (m) => { log.push(`mail:${m.to}`); return { ok: true, id: 'x' }; } });
    setWhatsApp({ send: async (m) => { log.push(`wa:${m.destination}:${m.campaignName}`); return { ok: true, providerId: 'w1' }; } });
    Object.assign(env, { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret_x_0001', AISENSY_API_KEY: 'k_test_0001', AISENSY_WA_NUMBER: '919000000000', WHATSAPP_PROVIDER: 'aisensy' });
    try {
      expect((await w.admin.post('/api/system/selftest/zoom')).body.data).toMatchObject({ ok: true }); expect((await w.admin.post('/api/system/selftest/razorpay')).body.data).toMatchObject({ ok: true });
      expect((await w.admin.post('/api/system/selftest/email')).body.data).toMatchObject({ ok: true });
      expect((await w.admin.post('/api/system/selftest/whatsapp', { phone: '9876543210', campaign_name: 'welcome_msg' })).body.data).toMatchObject({ ok: true });
      expect(log).toEqual(['zoom:create', 'zoom:delete:m1', 'rzp:create:100', 'rzp:cancel:pl_1', `mail:${w.adminEmail}`, 'wa:919876543210:welcome_msg']);
      setZoom({ createMeeting: async () => ({ ok: false, retriable: false, code: 'HTTP_401', message: 'Invalid client secret' }), deleteMeeting: async () => { log.push('should-not-delete'); }, startUrl: async () => ({ ok: false, message: '' }) } as any);
      expect((await w.admin.post('/api/system/selftest/zoom')).body.data).toMatchObject({ ok: false, step: 'HTTP_401', detail: 'Invalid client secret' }); expect(log).not.toContain('should-not-delete');
    } finally { setZoom(null); setPaymentProvider(null); setEmailProvider(null); setWhatsApp(null); Object.assign(env, { RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: undefined, AISENSY_API_KEY: undefined, AISENSY_WA_NUMBER: undefined }); }
    expect((await w.admin.post('/api/system/selftest/push')).body.data).toMatchObject({ ok: false, step: 'config' });
    expect((await w.admin.post('/api/system/selftest/whatsapp', {})).status).toBe(400);
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'selftest.zoom'`)).toBeTruthy();
  });
});

describe('parent-teacher chat', () => {
  let thread = '';
  it('is for parents and staff of that learner only', async () => {
    expect((await rv.get('/api/chat/threads')).status).toBe(403);                        // a child never sees it
    const kids = await parent.get('/api/chat/threads'); expect(kids.status).toBe(200); expect(kids.body.data.map((x: any) => x.learner_name)).toEqual(['Ravi Kumar']);
    expect((await parent.post('/api/chat/threads', { learner_id: meena.id })).status).toBe(404);   // not their child
    const t = await parent.post('/api/chat/threads', { learner_id: ravi.id }); expect(t.status).toBe(200); thread = t.body.data.id;
    expect((await parent.post('/api/chat/threads', { learner_id: ravi.id })).body.data.id).toBe(thread);   // one thread per child
    expect((await t1.get(`/api/chat/threads/${thread}/messages`)).status).toBe(200);
    expect((await t2.get(`/api/chat/threads/${thread}/messages`)).status).toBe(404);   // a teacher of another batch
    expect((await other.admin.get(`/api/chat/threads/${thread}/messages`)).status).toBe(404);
  });
  it('notifies the other side once, tracks unread, and can be read', async () => {
    expect((await parent.post(`/api/chat/threads/${thread}/messages`, { body: '   ' })).status).toBe(400);
    expect((await parent.post(`/api/chat/threads/${thread}/messages`, { body: 'Hello, how is Ravi doing in robotics?' })).status).toBe(201);
    expect((await parent.post(`/api/chat/threads/${thread}/messages`, { body: 'Also, is there homework?' })).status).toBe(201);
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND kind = 'chat.message' AND read_at IS NULL`, [w.teachers.t1.id]))!.n)).toBe(1);   // not one bell per message
    expect((await t1.get('/api/chat/unread')).body.data.unread).toBe(2);
    expect((await parent.get('/api/chat/unread')).body.data.unread).toBe(0);
    expect((await t1.post(`/api/chat/threads/${thread}/messages`, { body: 'He is doing great!' })).status).toBe(201);
    expect((await parent.get('/api/chat/unread')).body.data.unread).toBe(1);
    expect((await t1.post(`/api/chat/threads/${thread}/read`)).status).toBe(200); expect((await t1.get('/api/chat/unread')).body.data.unread).toBe(0);
    const m = (await parent.get(`/api/chat/threads/${thread}/messages`)).body.data; expect(m.messages.map((x: any) => x.body)).toEqual(['Hello, how is Ravi doing in robotics?', 'Also, is there homework?', 'He is doing great!']);
    expect(m.messages.map((x: any) => x.role)).toEqual(['parent', 'parent', 'staff']);
    const list = (await t1.get('/api/chat/threads')).body.data; expect(list.length).toBe(1); expect(list[0].last_body).toBe('He is doing great!');
  });
  it('lets a sender take back a message, and a moderator hide any; closed threads stop', async () => {
    const msgs = (await parent.get(`/api/chat/threads/${thread}/messages`)).body.data.messages;
    expect((await t1.post(`/api/chat/messages/${msgs[0].id}/hide`)).status).toBe(403);      // not theirs, and not a moderator
    expect((await parent.post(`/api/chat/messages/${msgs[1].id}/hide`)).status).toBe(200);
    expect((await w.admin.post(`/api/chat/messages/${msgs[2].id}/hide`)).status).toBe(200);
    const after = (await parent.get(`/api/chat/threads/${thread}/messages`)).body.data.messages; expect(after[1]).toMatchObject({ hidden: true, body: null }); expect(after[2].hidden).toBe(true);
    expect((await t1.post(`/api/chat/threads/${thread}/status`, { status: 'closed' })).status).toBe(403);
    expect((await w.admin.post(`/api/chat/threads/${thread}/status`, { status: 'closed' })).status).toBe(200);
    expect((await parent.post(`/api/chat/threads/${thread}/messages`, { body: 'Anyone there?' })).status).toBe(409);
    await w.admin.post(`/api/chat/threads/${thread}/status`, { status: 'open' });
  });
});

describe('web push', () => {
  const sub = (host: string) => ({ endpoint: `https://${host}/send/abc${uniq()}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });
  it('is off until keys exist, accepts only real push services, and pushes each notification once', async () => {
    expect((await parent.get('/api/push/config')).body.data).toMatchObject({ enabled: false, public_key: null });
    expect((await parent.post('/api/push/subscribe', sub('fcm.googleapis.com'))).status).toBe(400);
    Object.assign(env, { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.in' });
    try {
      expect((await parent.get('/api/push/config')).body.data).toMatchObject({ enabled: true, public_key: 'pub' });
      expect((await parent.post('/api/push/subscribe', sub('evil.example.com'))).status).toBe(400);
      expect((await parent.post('/api/push/subscribe', { ...sub('fcm.googleapis.com'), endpoint: 'http://fcm.googleapis.com/x' })).status).toBe(400);
      const live = sub('fcm.googleapis.com'); const dead = sub('updates.push.services.mozilla.com');
      expect((await parent.post('/api/push/subscribe', live)).status).toBe(201); expect((await parent.post('/api/push/subscribe', dead)).status).toBe(201);
      await exec(`UPDATE notifications SET push_state = 'skipped', read_at = NOW(3)`);
      const calls: string[] = []; setPushSender(async (s, payload) => { calls.push(`${new URL(s.endpoint).hostname}|${JSON.parse(payload).title}|${JSON.parse(payload).url}`); return s.endpoint === dead.endpoint ? { ok: false, gone: true, message: '410' } : { ok: true }; });
      const t = (await parent.post('/api/chat/threads', { learner_id: ravi.id })).body.data.id;
      await t1.post(`/api/chat/threads/${t}/messages`, { body: 'Push me' });
      await exec(`UPDATE notifications SET created_at = DATE_SUB(created_at, INTERVAL 5 SECOND) WHERE push_state = 'pending'`);
      const r = await runPushOnce(); expect(r.claimed).toBeGreaterThan(0);
      expect(calls).toContain(`fcm.googleapis.com|New message about Ravi Kumar|/messages/${t}`);
      expect(await queryOne(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [dead.endpoint])).toBeFalsy();     // a gone device is forgotten
      const n = calls.length; await runPushOnce(); expect(calls.length).toBe(n);                                              // never twice
      expect((await parent.post('/api/push/unsubscribe', { endpoint: live.endpoint })).status).toBe(200);
      expect(await queryOne(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [live.endpoint])).toBeFalsy();
    } finally { setPushSender(null); Object.assign(env, { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_SUBJECT: undefined }); }
  });
  it('marks waiting notifications skipped when push is off, so switching it on later floods nobody', async () => {
    await exec(`INSERT INTO notifications (id, org_id, user_id, kind, title, created_at) VALUES ($1,$2,$3,'x','old', DATE_SUB(NOW(3), INTERVAL 1 MINUTE))`, [newId(), w.orgId, w.teachers.t1.id]);
    const r = await runPushOnce(); expect(r.pushed).toBe(0);
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM notifications WHERE push_state = 'pending' AND created_at < DATE_SUB(NOW(3), INTERVAL 1 SECOND)`))!.n)).toBe(0);
  });
});

describe('question bank and learning paths', () => {
  const q = (n: string, topic = 'Sensors') => ({ topic, difficulty: 'easy', q: `What does ${n} do?`, options: ['Senses', 'Sleeps'], answer: 0 });
  it('is for teachers and admins, validated, and gives random draws', async () => {
    expect((await parent.get('/api/bank')).status).toBe(403); expect((await rv.post('/api/bank', q('IR'))).status).toBe(403);
    expect((await t1.post('/api/bank', { ...q('IR'), answer: 5 })).status).toBe(400);
    for (const n of ['IR', 'LDR', 'Ultrasonic']) expect((await t1.post('/api/bank', q(n))).status).toBe(201);
    await t1.post('/api/bank', q('Servo', 'Motors'));
    expect((await t1.get('/api/bank/topics')).body.data).toEqual([{ topic: 'Motors', questions: 1 }, { topic: 'Sensors', questions: 3 }]);
    expect((await t1.get('/api/bank?topic=Sensors')).body.meta.total).toBe(3);
    const pick = (await t1.post('/api/bank/pick', { topic: 'Sensors', count: 2 })).body.data; expect(pick.length).toBe(2); expect(new Set(pick.map((x: any) => x.id)).size).toBe(2);
    expect((await other.admin.get('/api/bank')).body.meta.total).toBe(0);
    const bulk = await t1.post('/api/bank/bulk', { topic: 'Sensors', questions: [q('IR'), q('PIR')] }); expect(bulk.body.data).toEqual({ added: 1, skipped: 1 });   // a duplicate is skipped
  });
  const mkCourse = async (title: string) => {
    const id = (await w.admin.post('/api/lms/courses', { title, audience: 'learners' })).body.data.id;
    await w.admin.post(`/api/lms/courses/${id}/lessons`, { title: 'Lesson one', kind: 'text', body: 'Read this.' }); await w.admin.patch(`/api/lms/courses/${id}`, { status: 'published' }); return id;
  };
  it('unlocks the next course when one is finished, and finishes the path', async () => {
    const c1 = await mkCourse('Step one'), c2 = await mkCourse('Step two');
    expect((await t1.post('/api/lms/paths', { title: 'X', course_ids: [c1] })).status).toBe(403);
    expect((await w.admin.post('/api/lms/paths', { title: 'X', course_ids: [c1, c1] })).status).toBe(400);
    const p = await w.admin.post('/api/lms/paths', { title: 'Maker journey', summary: 'Two steps', course_ids: [c1, c2] }); expect(p.status).toBe(201); const path = p.body.data.id;
    expect((await w.admin.post(`/api/lms/paths/${path}/assign`, { selector: { learner_ids: [ravi.id] }, confirm: true })).status).toBe(409);   // publish first
    await w.admin.patch(`/api/lms/paths/${path}`, { status: 'published' });
    expect((await w.admin.post(`/api/lms/paths/${path}/assign`, { selector: { learner_ids: [ravi.id] } })).status).toBe(400);               // needs confirmation
    const dry = await w.admin.post(`/api/lms/paths/${path}/assign`, { selector: { learner_ids: [ravi.id, meena.id] }, dry_run: true }); expect(dry.body.data.learners).toMatchObject({ to_assign: 2 });
    expect((await w.admin.post(`/api/lms/paths/${path}/assign`, { selector: { learner_ids: [ravi.id] }, due_days: 14, confirm: true })).status).toBe(201);
    expect((await w.admin.post(`/api/lms/paths/${path}/assign`, { selector: { learner_ids: [ravi.id] }, confirm: true })).body.data.learners).toMatchObject({ to_assign: 0, already: 1 });
    let mine = (await rv.get('/api/learn/paths')).body.data; expect(mine[0].steps.map((s: any) => s.state)).toEqual(['open', 'locked']);
    expect((await rv.get(`/api/learn/courses/${c2}`)).status).toBe(404);                                                              // the locked course is not reachable
    const c1d = (await rv.get(`/api/learn/courses/${c1}`)).body.data; const done = await rv.post(`/api/learn/courses/${c1}/lessons/${c1d.lessons[0].id}/complete`, {});
    expect(done.body.data).toMatchObject({ course_completed: true, path_unlocked: ['Step two'] });
    mine = (await rv.get('/api/learn/paths')).body.data; expect(mine[0].steps.map((s: any) => s.state)).toEqual(['done', 'open']);
    expect(await queryOne(`SELECT 1 FROM notifications WHERE kind = 'lms.path' AND title LIKE 'Next step unlocked%' AND learner_id = $1`, [ravi.id])).toBeTruthy();
    const due = await queryOne(`SELECT due_at FROM lms_enrollments WHERE course_id = $1 AND learner_id = $2`, [c2, ravi.id]); expect(due!.due_at).toBeTruthy();
    const c2d = (await rv.get(`/api/learn/courses/${c2}`)).body.data; const fin = await rv.post(`/api/learn/courses/${c2}/lessons/${c2d.lessons[0].id}/complete`, {});
    expect(fin.body.data).toMatchObject({ path_finished: ['Maker journey'] }); expect((await rv.get('/api/learn/paths')).body.data[0].finished).toBe(true);
    const prog = (await w.admin.get(`/api/lms/paths/${path}/progress`)).body.data; expect(prog.rows[0]).toMatchObject({ name: 'Ravi Kumar', done: 2, total: 2, finished: true });
    expect((await other.admin.get(`/api/lms/paths/${path}`)).status).toBe(404);
  });
});

describe('QR check-in and live polls', () => {
  let session = ''; const sign = (secret: string, sid: string, win: number) => `${sid}.${win}.${crypto.createHmac('sha256', secret).update(`${sid}.${win}`).digest('hex').slice(0, 20)}`;
  const win = () => Math.floor(Date.now() / 30_000);
  beforeAll(async () => {
    session = newId();
    await exec(`INSERT INTO class_sessions (id, org_id, batch_id, title, starts_at, ends_at, created_by) VALUES ($1,$2,$3,'Robot class', DATE_SUB(NOW(3), INTERVAL 5 MINUTE), DATE_ADD(NOW(3), INTERVAL 1 HOUR), $4)`, [session, w.orgId, w.batches.roboA, w.teachers.t1.id]);
  });
  it('shows a rotating code to the teacher only, and checks learners in once', async () => {
    expect((await rv.post(`/api/checkin/sessions/${session}/open`, {})).status).toBe(403);          // a learner cannot open it
    expect((await t2.post(`/api/checkin/sessions/${session}/open`, {})).status).toBe(404);          // another batch's teacher either
    expect((await t1.get(`/api/checkin/sessions/${session}/code`)).body.data.open).toBe(false);
    expect((await rv.post('/api/checkin', { token: `${session}.${win()}.aaaaaaaaaaaaaaaaaaaa` })).status).toBe(400);   // not open: no secret yet
    expect((await t1.post(`/api/checkin/sessions/${session}/open`, { minutes: 15 })).status).toBe(200);
    const code = (await t1.get(`/api/checkin/sessions/${session}/code`)).body.data; expect(code).toMatchObject({ open: true, checked_in: 0 }); const token = String(code.path).replace('/checkin/', '');
    expect((await rv.get(`/api/checkin/sessions/${session}/code`)).status).toBe(403);
    expect((await parent.post('/api/checkin', { token })).status).toBe(403);                         // a parent cannot check a child in
    expect((await out.post('/api/checkin', { token })).status).toBe(403);                            // a learner of another batch
    expect((await rv.post('/api/checkin', { token: token.slice(0, -2) + 'zz' })).status).toBe(400); // forged
    const secret = (await queryOne(`SELECT checkin_secret AS s FROM class_sessions WHERE id = $1`, [session]))!.s;
    expect((await rv.post('/api/checkin', { token: sign(secret, session, win() - 5) })).status).toBe(400);   // a stale photo of the screen
    const ok1 = await rv.post('/api/checkin', { token }); expect(ok1.status).toBe(200); expect(ok1.body.data).toMatchObject({ status: 'present', already: false });
    expect((await rv.post('/api/checkin', { token })).body.data.already).toBe(true);
    expect(await queryOne(`SELECT 1 FROM attendance WHERE session_id = $1 AND learner_id = $2 AND source = 'qr' AND status = 'present'`, [session, ravi.id])).toBeTruthy();
    // a teacher's own mark always wins
    await t1.put(`/api/classrooms/${w.batches.roboA}/sessions/${session}/attendance`, { entries: [{ learner_id: meena.id, status: 'excused' }] });
    const mr = await mn.post('/api/checkin', { token }); expect(mr.body.data).toMatchObject({ status: 'excused', already: true });
    expect((await t1.get(`/api/checkin/sessions/${session}/code`)).body.data.checked_in).toBe(1);
    await t1.post(`/api/checkin/sessions/${session}/close`); expect((await mn.post('/api/checkin', { token })).status).toBe(409);
  });
  it('runs a poll: one anonymous vote each, results after voting, closed by the teacher', async () => {
    expect((await t2.post('/api/polls', { batch_id: w.batches.roboA, question: 'Ready?', options: ['Yes', 'No'] })).status).toBe(404);
    expect((await rv.post('/api/polls', { batch_id: w.batches.roboA, question: 'Ready?', options: ['Yes', 'No'] })).status).toBe(403);
    expect((await t1.post('/api/polls', { batch_id: w.batches.roboA, question: 'Ready?', options: ['Only one'] })).status).toBe(400);
    const poll = (await t1.post('/api/polls', { batch_id: w.batches.roboA, question: 'Which sensor is your favourite?', options: ['IR', 'Ultrasonic', 'Light'] })).body.data.id;
    expect(await queryOne(`SELECT 1 FROM notifications WHERE kind = 'poll.open' AND learner_id = $1`, [ravi.id])).toBeTruthy();
    const before = (await mn.get(`/api/polls?batch_id=${w.batches.roboA}`)).body.data[0]; expect(before).toMatchObject({ status: 'open', my_choice: null }); expect(before.counts).toBeUndefined();   // no peeking
    expect((await mn.post(`/api/polls/${poll}/vote`, { choice: 9 })).status).toBe(400);
    expect((await mn.post(`/api/polls/${poll}/vote`, { choice: 1 })).status).toBe(201);
    expect((await mn.post(`/api/polls/${poll}/vote`, { choice: 0 })).status).toBe(409);
    expect((await rv.post(`/api/polls/${poll}/vote`, { choice: 1 })).status).toBe(201);
    expect((await parent.post(`/api/polls/${poll}/vote`, { choice: 0 })).status).toBe(403);
    expect((await out.post(`/api/polls/${poll}/vote`, { choice: 0 })).status).toBe(404);
    const after = (await mn.get(`/api/polls?batch_id=${w.batches.roboA}`)).body.data[0]; expect(after).toMatchObject({ my_choice: 1, total: 2, counts: [0, 2, 0] });
    expect((await t1.get(`/api/polls?batch_id=${w.batches.roboA}`)).body.data[0].counts).toEqual([0, 2, 0]);
    expect((await rv.post(`/api/polls/${poll}/close`)).status).toBe(403);
    expect((await t1.post(`/api/polls/${poll}/close`)).status).toBe(200);
    expect((await w.admin.post(`/api/polls/${poll}/vote`, { choice: 0 })).status).toBe(403);
    const late = await query(`SELECT 1 FROM poll_votes WHERE poll_id = $1`, [poll]); expect(late.length).toBe(2);
  });
});
