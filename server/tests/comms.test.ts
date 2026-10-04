import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { env } from '../src/config/env.js';
import { exec, query } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { setProvider, type SendInput, type SendResult, type WhatsAppProvider } from '../src/modules/comms/aisensy.js';
import { runWorkerOnce } from '../src/modules/comms/delivery.js';

let w: World, other: World;
let ravi: any, meena: any, solo: any, nophone: any;
let co: ReturnType<typeof client>, t1: ReturnType<typeof client>, rv: ReturnType<typeof client>, parent: ReturnType<typeof client>;
let tpl = '';
const SECRET = 'test-webhook-secret-123456';
const hook = (body: unknown, secret = SECRET) => request(app).post(`/api/webhooks/aisensy/${secret}`).send(body as object);

class Fake implements WhatsAppProvider {
  calls: SendInput[] = []; script: SendResult[] = []; n = 0;
  async send(m: SendInput): Promise<SendResult> { this.calls.push(m); return this.script.shift() ?? { ok: true, providerId: `wamid-${++this.n}-${uniq()}` }; }
}
const fake = new Fake();
const pass = (limit = 100) => runWorkerOnce({ provider: fake, limit, perSecond: 1000 });

beforeAll(async () => {
  setProvider(fake);
  w = await buildWorld(); other = await buildWorld();
  const mk = (n: string, extra: object = {}) => newLearner(w, { full_name: n, email: `${n.toLowerCase().replace(/\W/g, '')}-${uniq()}@kids.test`, ...extra });
  const shared = { full_name: 'Parent Shared', mobile: '9870000001', email: `ps-${uniq()}@fam.test` };
  ravi = await mk('Ravi Child', { parent: shared, batch_ids: [w.batches.roboA, w.batches.pyB] });
  meena = await mk('Meena Child', { parent: shared, batch_ids: [w.batches.roboA] });            // sibling: same parent, same phone
  solo = await mk('Solo Kid', { parent: { full_name: 'Parent Solo', mobile: '9870000002' }, batch_ids: [w.batches.roboA] });
  nophone = await mk('NoPhone Kid', { batch_ids: [w.batches.roboA] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD });
  await w.admin.post(`/api/learners/${meena.id}/login`, { password: PASSWORD });
  const cu = `co-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Counsellor C', email: cu, password: PASSWORD, roles: [{ role: 'counsellor' }] });
  co = client(await login(cu)); t1 = client(await login(w.teachers.t1.email)); rv = client(await login(ravi.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
});
afterAll(() => setProvider(null));

describe('access and configuration', () => {
  it('only communication staff reach WhatsApp; templates are admin-only; other orgs see nothing', async () => {
    for (const c of [t1, rv, parent]) { expect((await c.get('/api/whatsapp/status')).status).toBe(403); expect((await c.get('/api/whatsapp/campaigns')).status).toBe(403); }
    const s = (await co.get('/api/whatsapp/status')).body.data;
    expect(s).toMatchObject({ configured: true, webhook_configured: true });
    expect(JSON.stringify(s)).not.toContain('test-aisensy-key'); expect(JSON.stringify(s)).not.toContain(SECRET);       // values are never returned
    expect((await co.post('/api/whatsapp/templates', { name: 'x', aisensy_campaign_name: 'y', use_case: 'welcome' })).status).toBe(403);
    expect((await other.admin.get('/api/whatsapp/templates')).body.data).toHaveLength(0);
  });
  it('templates: create, validate, duplicates', async () => {
    expect((await w.admin.post('/api/whatsapp/templates', { name: 'Bad', aisensy_campaign_name: '', use_case: 'welcome' })).status).toBe(400);
    expect((await w.admin.post('/api/whatsapp/templates', { name: 'Bad', aisensy_campaign_name: 'c', use_case: 'nonsense' })).status).toBe(400);
    const r = await w.admin.post('/api/whatsapp/templates', { name: 'Class reminder', aisensy_campaign_name: 'class_reminder_v1', use_case: 'class_reminder', body_preview: 'Hi {{1}}, class for {{2}} is tomorrow.', variable_names: ['Name', 'Batch'] });
    expect(r.status).toBe(201); tpl = r.body.data.id;
    expect((await w.admin.post('/api/whatsapp/templates', { name: 'Class reminder', aisensy_campaign_name: 'z', use_case: 'welcome' })).status).toBe(409);
    expect((await co.get('/api/whatsapp/templates')).body.data[0].variable_names).toEqual(['Name', 'Batch']);
  });
});

describe('campaign: audience, confirmation, deduplication', () => {
  let cid = '';
  const sel = () => ({ batch_ids: [w.batches.roboA, w.batches.pyB] });
  it('validates variables and placeholders', async () => {
    const base = { name: 'Reminder', template_id: tpl, audience: 'parents', selector: sel(), variables: ['{parent_name}', 'Robotics'] };
    expect((await co.post('/api/whatsapp/campaigns', { ...base, variables: ['only one'] })).status).toBe(400);
    expect((await co.post('/api/whatsapp/campaigns', { ...base, variables: ['{nope}', 'x'] })).status).toBe(400);
    expect((await co.post('/api/whatsapp/campaigns', { ...base, variables: ['{learner_name}', '{batch_name}'] })).status).toBe(400);   // two batches selected
    expect((await co.post('/api/whatsapp/campaigns', { ...base, audience: 'learners' })).status).toBe(400);                         // {parent_name} needs parents
    expect((await co.post('/api/whatsapp/campaigns', { ...base, scheduled_at: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect((await t1.post('/api/whatsapp/campaigns', base)).status).toBe(403);
    const ok = await co.post('/api/whatsapp/campaigns', base); expect(ok.status).toBe(201); cid = ok.body.data.id;
  });
  it('preview shows batches, memberships, unique learners, duplicates removed, and every reason someone is skipped', async () => {
    const p = (await co.post(`/api/whatsapp/campaigns/${cid}/preview`)).body.data;
    expect(p).toMatchObject({ selected_batches: 2, batch_memberships: 5, unique_learners: 4, duplicates_removed: 1, with_phone: 3, no_phone: 1, shared_phone_merged: 1, recipients: 2, ready: true });
    expect(p.warnings.join(' ')).toMatch(/share a number/); expect(p.warnings.join(' ')).toMatch(/no usable parent mobile/);
    expect(p.sample[0].params[0]).toBe('Parent Shared'); expect(p.sample[0].phone).toMatch(/•/);
    expect(Number((await query(`SELECT COUNT(*) AS n FROM whatsapp_recipients WHERE campaign_id = $1`, [cid]))[0].n)).toBe(0);   // preview writes no snapshot
  });
  it('confirmation is explicit, matches what was reviewed, and needs WhatsApp to be configured', async () => {
    expect((await co.post(`/api/whatsapp/campaigns/${cid}/confirm`, { expected_recipients: 2 })).status).toBe(400);               // no confirm flag
    expect((await co.post(`/api/whatsapp/campaigns/${cid}/confirm`, { confirm: true, expected_recipients: 5 })).body.error.code).toBe('AUDIENCE_CHANGED');
    const key = env.AISENSY_API_KEY; (env as any).AISENSY_API_KEY = undefined;
    expect((await co.post(`/api/whatsapp/campaigns/${cid}/confirm`, { confirm: true, expected_recipients: 2 })).body.error.code).toBe('NOT_CONFIGURED');
    (env as any).AISENSY_API_KEY = key;
    expect((await other.admin.post(`/api/whatsapp/campaigns/${cid}/confirm`, { confirm: true, expected_recipients: 2 })).status).toBe(404);
    const done = await co.post(`/api/whatsapp/campaigns/${cid}/confirm`, { confirm: true, expected_recipients: 2 });
    expect(done.status).toBe(200); expect(done.body.data).toMatchObject({ status: 'processing', recipients: 2, unique_learners: 4 });
    expect((await co.post(`/api/whatsapp/campaigns/${cid}/confirm`, { confirm: true, expected_recipients: 2 })).status).toBe(409);   // cannot be confirmed twice
    const rows = await query(`SELECT phone, params FROM whatsapp_recipients WHERE campaign_id = $1 ORDER BY phone`, [cid]);
    expect(rows.map((r) => r.phone)).toEqual(['+919870000001', '+919870000002']);
  });
  it('the worker sends one message per phone through the provider, with the right template and parameters', async () => {
    const s = await pass();
    expect(s).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
    expect(fake.calls).toHaveLength(2);
    const first = fake.calls.find((c) => c.destination === '919870000001')!;
    expect(first).toMatchObject({ campaignName: 'class_reminder_v1', templateParams: ['Parent Shared', 'Robotics'] });
    expect(fake.calls.find((c) => c.destination === '919870000002')!.templateParams[0]).toBe('Parent Solo');
    const c = (await co.get(`/api/whatsapp/campaigns/${cid}`)).body.data;
    expect(c.status).toBe('completed'); expect(c.counts).toMatchObject({ total: 2, sent: 2, successful: 2, failed: 0, in_progress: 0 });
    expect((await pass()).claimed).toBe(0);                                                            // nothing is ever sent twice
  });
  it('webhooks update delivery, never go backwards, ignore replays, and need the secret', async () => {
    const [r] = await query(`SELECT id, provider_message_id AS pid FROM whatsapp_recipients WHERE campaign_id = $1 ORDER BY phone LIMIT 1`, [cid]);
    expect((await hook({ id: r.pid, status: 'delivered' }, 'wrong-secret-wrong-secret')).status).toBe(404);
    expect((await hook({ id: r.pid, status: 'delivered' }, 'x')).status).toBe(404);
    expect((await hook({ event_id: 'e1', data: { message: { id: r.pid, status: 'delivered' } } })).body.data.applied).toBe(1);
    expect((await hook({ event_id: 'e1', data: { message: { id: r.pid, status: 'delivered' } } })).body.data.duplicate).toBe(1);   // replay
    expect((await hook({ event_id: 'e2', messageId: r.pid, status: 'read' })).body.data.applied).toBe(1);
    expect((await hook({ event_id: 'e3', messageId: r.pid, status: 'sent' })).body.data.ignored).toBe(1);                         // late, older event
    expect((await hook({ event_id: 'e4', messageId: r.pid, status: 'failed', error: 'x' })).body.data.ignored).toBe(1);           // already delivered
    expect((await hook({ event_id: 'e5', messageId: 'unknown-id', status: 'delivered' })).body.data.unmatched).toBe(1);
    expect((await hook({ event_id: 'e6', hello: 'world' })).body.data.ignored).toBe(1);
    const row = (await query(`SELECT status, delivered_at, read_at FROM whatsapp_recipients WHERE id = $1`, [r.id]))[0];
    expect(row.status).toBe('read'); expect(row.delivered_at).toBeTruthy(); expect(row.read_at).toBeTruthy();
    const log = (await co.get(`/api/whatsapp/recipients/${r.id}/log`)).body.data.map((x: any) => x.event);
    expect(log).toEqual(['sent', 'delivered', 'read', 'sent', 'failed']);   // every provider event is logged, even the ones that changed nothing
    expect((await co.get(`/api/whatsapp/campaigns/${cid}`)).body.data.counts).toMatchObject({ read: 1, sent: 1 });
    expect((await co.get(`/api/whatsapp/learners/${meena.id}/messages`)).body.data[0]).toMatchObject({ campaign: 'Reminder' });   // siblings share one message, kept on the first child
    expect((await t1.get(`/api/whatsapp/learners/${meena.id}/messages`)).status).toBe(403);
  });
  it('a webhook that arrives before we recorded the message id is applied once we have it', async () => {
    const c2 = (await co.post('/api/whatsapp/campaigns', { name: 'Early webhook', template_id: tpl, audience: 'parents', selector: { learner_ids: [solo.id] }, variables: ['{learner_name}', 'x'] })).body.data.id;
    await co.post(`/api/whatsapp/campaigns/${c2}/confirm`, { confirm: true, expected_recipients: 1 });
    fake.script.push({ ok: true, providerId: 'early-bird-1' });
    expect((await hook({ event_id: 'early', messageId: 'early-bird-1', status: 'delivered' })).body.data.unmatched).toBe(1);
    await pass();
    expect((await query(`SELECT status FROM whatsapp_recipients WHERE campaign_id = $1`, [c2]))[0].status).toBe('delivered');
  });
});

describe('failures, retry, cancel, schedule, opt-out', () => {
  const mkCampaign = async (name: string, selector: object, vars = ['{learner_name}', 'x'], extra: object = {}) => {
    const id = (await co.post('/api/whatsapp/campaigns', { name, template_id: tpl, audience: 'parents', selector, variables: vars, ...extra })).body.data.id;
    return id as string;
  };
  it('retriable failures back off and retry; permanent ones fail at once; failed recipients can be retried', async () => {
    const id = await mkCampaign('Flaky', { batch_ids: [w.batches.roboA] });
    const conf = await co.post(`/api/whatsapp/campaigns/${id}/confirm`, { confirm: true, expected_recipients: 2 }); expect(conf.status).toBe(200);
    fake.script.push({ ok: false, retriable: true, code: 'HTTP_503', message: 'unavailable' }, { ok: false, retriable: false, code: 'HTTP_400', message: 'Invalid template' });
    expect(await pass()).toMatchObject({ claimed: 2, retried: 1, failed: 1, sent: 0 });
    const rows = await query(`SELECT status, attempts, next_attempt_at, last_error FROM whatsapp_recipients WHERE campaign_id = $1 ORDER BY phone`, [id]);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1 }); expect(rows[0].next_attempt_at).toBeTruthy();
    expect(rows[1]).toMatchObject({ status: 'failed', attempts: 1 }); expect(rows[1].last_error).toMatch(/Invalid template/);
    expect((await pass()).claimed).toBe(0);                                                         // not due yet
    await exec(`UPDATE whatsapp_recipients SET next_attempt_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE campaign_id = $1 AND status = 'pending'`, [id]);
    expect(await pass()).toMatchObject({ claimed: 1, sent: 1 });
    expect((await co.get(`/api/whatsapp/campaigns/${id}`)).body.data).toMatchObject({ status: 'partially_failed' });
    expect((await co.post(`/api/whatsapp/campaigns/${id}/retry-failed`)).body.data.requeued).toBe(1);
    expect(await pass()).toMatchObject({ sent: 1 });
    expect((await co.get(`/api/whatsapp/campaigns/${id}`)).body.data).toMatchObject({ status: 'completed' });
    expect((await co.get(`/api/whatsapp/campaigns/${id}/recipients?status=failed`)).body.meta.total).toBe(0);
  });
  it('gives up after repeated retriable failures', async () => {
    const id = await mkCampaign('Down', { learner_ids: [solo.id] });
    await co.post(`/api/whatsapp/campaigns/${id}/confirm`, { confirm: true, expected_recipients: 1 });
    for (let i = 0; i < 4; i++) { fake.script.push({ ok: false, retriable: true, code: 'HTTP_429', message: 'slow down' }); await pass(); await exec(`UPDATE whatsapp_recipients SET next_attempt_at = NULL WHERE campaign_id = $1 AND status = 'pending'`, [id]); }
    const r = (await query(`SELECT status, attempts FROM whatsapp_recipients WHERE campaign_id = $1`, [id]))[0];
    expect(r).toMatchObject({ status: 'failed', attempts: 4 });
    expect((await co.get(`/api/whatsapp/campaigns/${id}`)).body.data.status).toBe('failed');
  });
  it('cancelling stops everything that has not been sent', async () => {
    const id = await mkCampaign('To cancel', { batch_ids: [w.batches.roboA] });
    await co.post(`/api/whatsapp/campaigns/${id}/confirm`, { confirm: true, expected_recipients: 2 });
    const before = fake.calls.length;
    const c = await co.post(`/api/whatsapp/campaigns/${id}/cancel`); expect(c.body.data.cancelled_recipients).toBe(2);
    expect((await pass()).claimed).toBe(0); expect(fake.calls.length).toBe(before);
    expect((await co.get(`/api/whatsapp/campaigns/${id}`)).body.data).toMatchObject({ status: 'cancelled' });
    expect((await co.post(`/api/whatsapp/campaigns/${id}/cancel`)).status).toBe(409);
  });
  it('scheduled campaigns wait until their time', async () => {
    const id = await mkCampaign('Later', { learner_ids: [solo.id] }, ['{learner_name}', 'x'], { scheduled_at: new Date(Date.now() + 3600e3).toISOString() });
    expect((await co.post(`/api/whatsapp/campaigns/${id}/confirm`, { confirm: true, expected_recipients: 1 })).body.data.status).toBe('scheduled');
    expect((await pass()).claimed).toBe(0);
    await exec(`UPDATE whatsapp_campaigns SET scheduled_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = $1`, [id]);
    expect(await pass()).toMatchObject({ claimed: 1, sent: 1 });
  });
  it('opted-out numbers are skipped and anything waiting for them is cancelled', async () => {
    expect((await co.post('/api/whatsapp/optouts', { phone: '9870000002' })).status).toBe(403);
    const id = await mkCampaign('Opt', { batch_ids: [w.batches.roboA] });
    await co.post(`/api/whatsapp/campaigns/${id}/confirm`, { confirm: true, expected_recipients: 2 });
    const oo = await w.admin.post('/api/whatsapp/optouts', { phone: '98700 00002', reason: 'Asked to stop' }); expect(oo.status).toBe(201); expect(oo.body.data.phone).toBe('+919870000002');
    expect((await w.admin.post('/api/whatsapp/optouts', { phone: '9870000002' })).status).toBe(409);
    expect(await pass()).toMatchObject({ claimed: 1, sent: 1 });
    expect((await query(`SELECT status FROM whatsapp_recipients WHERE campaign_id = $1 AND phone = '+919870000002'`, [id]))[0].status).toBe('cancelled');
    const id2 = await mkCampaign('Opt2', { batch_ids: [w.batches.roboA] });
    expect((await co.post(`/api/whatsapp/campaigns/${id2}/preview`)).body.data).toMatchObject({ opted_out: 1, recipients: 1 });
    await w.admin.del(`/api/whatsapp/optouts/${oo.body.data.id}`);
  });
  it('drafts can be edited and deleted; confirmed campaigns cannot', async () => {
    const id = await mkCampaign('Draft', { learner_ids: [solo.id] });
    expect((await co.patch(`/api/whatsapp/campaigns/${id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await co.del(`/api/whatsapp/campaigns/${id}`)).status).toBe(200);
    const id2 = await mkCampaign('Sent', { learner_ids: [solo.id] }); await co.post(`/api/whatsapp/campaigns/${id2}/confirm`, { confirm: true, expected_recipients: 1 });
    expect((await co.patch(`/api/whatsapp/campaigns/${id2}`, { name: 'x' })).status).toBe(409);
    expect((await co.del(`/api/whatsapp/campaigns/${id2}`)).status).toBe(409);
    await pass();
  });
});

describe('AiSensy provider (against a local stand-in server)', () => {
  let srv: http.Server; let last: any; let status = 200; let reply: any = { success: 'true', submitted_message_id: 'wamid.live' };
  beforeAll(async () => {
    srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { last = { url: req.url, method: req.method, body: JSON.parse(b || '{}') }; res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    (env as any).AISENSY_BASE_URL = `http://127.0.0.1:${(srv.address() as any).port}`;
    setProvider(null);
  });
  afterAll(() => { srv.close(); setProvider(fake); });
  it('posts the documented payload and reads the message id', async () => {
    const { sendTemplateMessage } = await import('../src/modules/comms/aisensy.js');
    const r = await sendTemplateMessage({ destination: '919870000001', campaignName: 'class_reminder_v1', userName: 'Ravi Child', templateParams: ['A', 'B'] });
    expect(r).toEqual({ ok: true, providerId: 'wamid.live' });
    expect(last).toMatchObject({ method: 'POST', url: '/campaign/t1/api/v2', body: { apiKey: 'test-aisensy-key-0001', campaignName: 'class_reminder_v1', destination: '919870000001', templateParams: ['A', 'B'] } });
  });
  it('classifies errors and never leaks the key', async () => {
    const { sendTemplateMessage } = await import('../src/modules/comms/aisensy.js');
    const m = { destination: '919870000001', campaignName: 'c', userName: 'x', templateParams: [] };
    status = 500; reply = { message: 'upstream down test-aisensy-key-0001' };
    const a = await sendTemplateMessage(m); expect(a).toMatchObject({ ok: false, retriable: true }); expect(JSON.stringify(a)).not.toContain('test-aisensy-key');
    status = 429; expect(await sendTemplateMessage(m)).toMatchObject({ ok: false, retriable: true });
    status = 400; reply = { message: 'Campaign not found' }; expect(await sendTemplateMessage(m)).toMatchObject({ ok: false, retriable: false, message: 'Campaign not found' });
    status = 200; reply = { success: 'false', message: 'Invalid number' }; expect(await sendTemplateMessage(m)).toMatchObject({ ok: false, retriable: false });
  });
});

describe('announcements (in-app)', () => {
  const sel = (ids: string[]) => ({ batch_ids: ids });
  it('teachers announce to their own batches only; learners cannot; people are notified once', async () => {
    expect((await rv.post('/api/announcements', { title: 'Hi', body: 'Hello', selector: sel([w.batches.roboA]), confirm: true })).status).toBe(403);
    expect((await t1.post('/api/announcements', { title: 'Hi', body: 'Hello', selector: sel([w.batches.aiC]), confirm: true })).status).toBe(400);   // not their learners
    expect((await t1.post('/api/announcements', { title: 'Hi', body: 'Hello', selector: sel([w.batches.roboA]) })).status).toBe(400);               // no confirmation
    const pv = (await t1.post('/api/announcements/preview', { selector: sel([w.batches.roboA, w.batches.pyB]) })).body.data;
    expect(pv.unique_learners).toBeGreaterThan(0);
    const before = (await parent.get('/api/notifications')).body.meta.total;
    const r = await t1.post('/api/announcements', { title: 'Robotics kit day', body: 'Bring your kits on Friday.', selector: sel([w.batches.roboA]), post_to_stream: true, confirm: true });
    expect(r.status).toBe(201); expect(r.body.data).toMatchObject({ streams_posted: 1 });
    expect((await parent.get('/api/notifications')).body.meta.total).toBe(before + 1);                 // two children in the audience, ONE notification for the parent
    expect((await rv.get('/api/notifications')).body.data.some((n: any) => n.kind === 'announcement' && n.title === 'Robotics kit day')).toBe(true);
    expect((await t1.get('/api/notifications')).body.data.some((n: any) => n.kind === 'announcement')).toBe(false);   // not the sender
    expect((await rv.get(`/api/classrooms/${w.batches.roboA}/stream`)).body.data.some((p: any) => p.body === 'Bring your kits on Friday.')).toBe(true);
    expect((await t1.get('/api/announcements')).body.data).toHaveLength(1);
  });
  it('posting to a Stream needs batches the sender manages', async () => {
    expect((await t1.post('/api/announcements', { title: 'Hi', body: 'Hello', selector: { learner_ids: [ravi.id] }, post_to_stream: true, confirm: true })).status).toBe(400);
    expect((await t1.post('/api/announcements', { title: 'Hi', body: 'Hello', selector: sel([w.batches.pyB, w.batches.roboA]), post_to_stream: true, confirm: true })).status).toBe(404);   // a batch outside their scope does not exist for them
  });
});
