import { beforeAll, describe, expect, it } from 'vitest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { setProvider, type SendInput, type SendResult, type WhatsAppProvider } from '../src/modules/comms/aisensy.js';
import { runWorkerOnce } from '../src/modules/comms/delivery.js';
import { runAllRules, runRule } from '../src/modules/reminders/engine.js';

class Fake implements WhatsAppProvider { calls: SendInput[] = []; n = 0; async send(m: SendInput): Promise<SendResult> { this.calls.push(m); return { ok: true, providerId: `wamid-${++this.n}-${uniq()}` }; } }
const fake = new Fake();
const pass = async () => { for (let i = 0; i < 4; i++) await runWorkerOnce({ provider: fake, limit: 200, perSecond: 1000 }); };

let w: World, other: World; let tplFee = '', tplClass = '', tplAbs = '';
let ravi: any, meena: any, solo: any, nophone: any, optout: any;
let teacher: ReturnType<typeof client>, counsellor: ReturnType<typeof client>;
const tz = 'Asia/Kolkata';
// calendar days in the organization's timezone, which is what the engine and the fee dates use
const D = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() + n * 86_400_000));
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
// a sending window that contains the current hour, and one that does not
const open = () => ({ send_from_hour: 0, send_to_hour: 24 });
const closed = () => { const h = hourNow(); return h > 0 ? { send_from_hour: 0, send_to_hour: h } : { send_from_hour: 1, send_to_hour: 2 }; };
let seq = 0;
const rule = (extra: object) => ({ name: `Rule ${uniq()}-${seq++}`, audience: 'parents', ...open(), ...extra });

async function mkTpl(name: string, vars: string[]) {
  const r = await w.admin.post('/api/whatsapp/templates', { name, aisensy_campaign_name: `${name.toLowerCase().replace(/\W/g, '_')}_v1`, use_case: 'fee_reminder', variable_names: vars });
  expect(r.status).toBe(201); return r.body.data.id as string;
}
async function assignFee(learnerIds: string[], plan: string, startOffset: number) {
  const r = await w.admin.post('/api/fees/assign', { plan_id: plan, selector: { learner_ids: learnerIds }, start_date: D(startOffset), confirm: true });
  expect(r.status).toBe(201);
}

beforeAll(async () => {
  setProvider(fake);
  w = await buildWorld(); other = await buildWorld();
  const shared = { full_name: 'Shared Parent', mobile: '9840000001' };
  ravi = await newLearner(w, { full_name: 'Ravi Kumar', parent: shared, batch_ids: [w.batches.roboA] });
  meena = await newLearner(w, { full_name: 'Meena Kumar', parent: shared, batch_ids: [w.batches.roboA] });
  solo = await newLearner(w, { full_name: 'Solo Singh', parent: { full_name: 'Solo Parent', mobile: '9840000002' }, batch_ids: [w.batches.roboA] });
  nophone = await newLearner(w, { full_name: 'No Phone', batch_ids: [w.batches.roboA] });
  optout = await newLearner(w, { full_name: 'Opted Out', parent: { full_name: 'Quiet Parent', mobile: '9840000003' }, batch_ids: [w.batches.roboA] });
  await w.admin.post('/api/whatsapp/optouts', { phone: '9840000003' });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  teacher = client(await login(w.teachers.t1.email));
  const cu = `co-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Counsellor', email: cu, password: PASSWORD, roles: [{ role: 'counsellor' }] }); counsellor = client(await login(cu));
  tplFee = await mkTpl('Fee reminder', ['Parent', 'Child', 'Amount', 'Due date']);
  tplClass = await mkTpl('Class reminder', ['Child', 'Class', 'Time']);
  tplAbs = await mkTpl('Absence note', ['Parent', 'Child', 'Class']);
});

describe('rules are validated and protected', () => {
  it('rejects wrong value counts, tokens that do not fit the kind, and repeats on the wrong kind', async () => {
    const base = { kind: 'fee_due', template_id: tplFee, offset_value: 3 };
    expect((await w.admin.post('/api/reminders/rules', rule({ ...base, variables: ['{parent_name}'] }))).status).toBe(400);
    const bad = await w.admin.post('/api/reminders/rules', rule({ ...base, variables: ['{parent_name}', '{learner_name}', '{class_time}', '{due_date}'] }));
    expect(bad.status).toBe(400); expect(bad.body.error.message).toContain('{class_time}');
    expect((await w.admin.post('/api/reminders/rules', rule({ ...base, repeat_days: 3, max_sends: 2, variables: ['a', 'b', 'c', 'd'] }))).status).toBe(400);
    expect((await w.admin.post('/api/reminders/rules', rule({ ...base, audience: 'learners', variables: ['{parent_name}', 'b', 'c', 'd'] }))).status).toBe(400);
    expect((await w.admin.post('/api/reminders/rules', rule({ ...base, send_from_hour: 20, send_to_hour: 9, variables: ['a', 'b', 'c', 'd'] }))).status).toBe(400);
  });
  it('is open to org admins, readable by comms readers, closed to teachers and other organizations', async () => {
    const ok = await w.admin.post('/api/reminders/rules', rule({ kind: 'fee_due', template_id: tplFee, offset_value: 3, variables: ['{parent_name}', '{learner_first_name}', '{amount_due}', '{due_date}'] }));
    expect(ok.status).toBe(201);
    expect((await counsellor.get('/api/reminders/rules')).status).toBe(200);
    expect((await counsellor.post('/api/reminders/rules', rule({ kind: 'fee_due', template_id: tplFee, offset_value: 1, variables: ['a', 'b', 'c', 'd'] }))).status).toBe(403);
    expect((await teacher.get('/api/reminders/rules')).status).toBe(403);
    expect((await other.admin.get('/api/reminders/rules')).body.data).toHaveLength(0);
    expect((await other.admin.post(`/api/reminders/rules/${ok.body.data.id}/run`)).status).toBe(404);
    expect((await w.admin.get('/api/reminders/meta')).body.data.kinds).toHaveLength(4);
    await w.admin.del(`/api/reminders/rules/${ok.body.data.id}`);
  });
});

describe('fee due reminders', () => {
  let ruleId = ''; let plan = '';
  it('queues one personalised message per installment due soon, shared phones get one each, and sends them through the normal worker', async () => {
    plan = (await w.admin.post('/api/fees/plans', { name: 'Term fee', items: [{ label: 'Term 1', amount: 3600, due_days: 0 }, { label: 'Term 2', amount: 2400, due_days: 40 }] })).body.data.id;
    await assignFee([ravi.id, meena.id, solo.id, nophone.id, optout.id], plan, 2);       // Term 1 is due in 2 days for all five
    const r = await w.admin.post('/api/reminders/rules', rule({ name: 'Fee heads-up', kind: 'fee_due', template_id: tplFee, offset_value: 3, variables: ['{parent_name}', '{learner_first_name}', '{amount_due}', '{due_date}'] }));
    expect(r.status).toBe(201); ruleId = r.body.data.id;
    const prev = (await w.admin.post(`/api/reminders/rules/${ruleId}/preview`)).body.data;
    expect(prev).toMatchObject({ candidates: 5, fresh: 5, queued: 3, skipped: { no_phone: 1, opted_out: 1 } });
    expect(prev.sample[0].params).toHaveLength(4);
    expect((await query(`SELECT COUNT(*) AS n FROM reminder_log WHERE rule_id = $1`, [ruleId]))[0].n).toBe(0);      // preview writes nothing
    const run = (await w.admin.post(`/api/reminders/rules/${ruleId}/run`)).body.data;
    expect(run).toMatchObject({ queued: 3, campaigns: 2 });                                                         // ravi + meena share a phone -> two waves
    await pass();
    const to = fake.calls.filter((c) => c.campaignName === 'fee_reminder_v1');
    expect(to).toHaveLength(3);
    const ravi1 = to.find((c) => c.templateParams[1] === 'Ravi')!;
    expect(ravi1.templateParams[0]).toBe('Shared Parent'); expect(ravi1.templateParams[2]).toBe('₹3,600'); expect(ravi1.templateParams[3]).toMatch(/\d{1,2} \w{3} \d{4}/);
    expect(to.filter((c) => c.destination === '919840000001')).toHaveLength(2);                                      // both siblings were told
    expect(to.some((c) => c.destination === '919840000003')).toBe(false);                                            // opted out
    const logs = await query(`SELECT outcome, reason FROM reminder_log WHERE rule_id = $1 ORDER BY id`, [ruleId]);
    expect(logs.filter((l) => l.outcome === 'queued')).toHaveLength(3);
    expect(logs.filter((l) => l.outcome === 'skipped').map((l) => l.reason).sort()).toEqual(['no_phone', 'opted_out']);
  });
  it('never sends the same reminder twice, even when two runs overlap', async () => {
    const again = (await w.admin.post(`/api/reminders/rules/${ruleId}/run`)).body.data;
    expect(again).toMatchObject({ fresh: 0, queued: 0, campaigns: 0 });
    // fresh work appears for a new learner; two overlapping runs may only queue it once
    const late = await newLearner(w, { full_name: 'Late Joiner', parent: { full_name: 'Late Parent', mobile: '9840000009' }, batch_ids: [w.batches.roboA] });
    await assignFee([late.id], plan, 1);
    const [a, b] = await Promise.all([runRule(ruleId, { force: true }), runRule(ruleId, { force: true })]);
    expect(a.queued + b.queued).toBe(1);
    expect((await query(`SELECT COUNT(*) AS n FROM reminder_log WHERE rule_id = $1 AND learner_id = $2`, [ruleId, late.id]))[0].n).toBe(1);
  });
  it('shows automatic campaigns in the campaign list, marked as automatic, with delivery counts', async () => {
    const list = (await w.admin.get('/api/whatsapp/campaigns?page_size=50')).body.data;
    const auto = list.filter((c: any) => c.kind === 'auto');
    expect(auto.length).toBeGreaterThanOrEqual(2); expect(auto[0].name).toContain('Fee heads-up');
    expect(auto.some((c: any) => c.counts?.successful >= 1)).toBe(true);
  });
  it('stays quiet outside its sending hours unless run on purpose, and stops when disabled', async () => {
    const r2 = (await w.admin.post('/api/reminders/rules', rule({ name: 'Quiet hours', kind: 'fee_due', template_id: tplFee, offset_value: 60, ...closed(), variables: ['{parent_name}', '{learner_first_name}', '{amount_due}', '{due_date}'] }))).body.data.id;
    const quiet = await runRule(r2);
    expect(quiet.queued).toBe(0); expect(quiet.skipped_reason).toBe('outside sending hours'); expect(quiet.window_open).toBe(false);
    const forced = await runRule(r2, { force: true }); expect(forced.queued).toBeGreaterThan(0);        // Term 2 (due in ~42 days) is inside a 60 day horizon
    expect((await w.admin.patch(`/api/reminders/rules/${ruleId}`, { enabled: true })).status).toBe(200);
    expect((await runAllRules()).rules).toBeGreaterThanOrEqual(1);                                         // an enabled rule is picked up by the scheduler pass
    await w.admin.patch(`/api/reminders/rules/${ruleId}`, { enabled: false });
    expect((await queryOne(`SELECT enabled FROM reminder_rules WHERE id = $1`, [ruleId]))!.enabled).toBeFalsy();
    const all = await runAllRules();                                                                      // runAllRules only touches enabled rules
    expect(all.rules).toBe(0);
  });
});

describe('fee overdue reminders repeat on a schedule and then stop', () => {
  it('sends at 2 days overdue, again at 5, and never a third time', async () => {
    const plan = (await w.admin.post('/api/fees/plans', { name: 'Overdue plan', items: [{ label: 'Only', amount: 1000, due_days: 0 }] })).body.data.id;
    const kid = await newLearner(w, { full_name: 'Overdue Kid', parent: { full_name: 'Overdue Parent', mobile: '9840000020' }, batch_ids: [w.batches.roboA] });
    await assignFee([kid.id], plan, -2);                                                                  // due 2 days ago
    const rid = (await w.admin.post('/api/reminders/rules', rule({ name: 'Chase', kind: 'fee_overdue', template_id: tplFee, offset_value: 2, repeat_days: 3, max_sends: 2, variables: ['{parent_name}', '{learner_first_name}', '{amount_due}', '{days_overdue}'] }))).body.data.id;
    const mine = (r: any) => r.fresh;
    // other learners with overdue fees from earlier tests would also match; look only at this learner's log
    await runRule(rid, { force: true });
    const count = async () => Number((await queryOne(`SELECT COUNT(*) AS n FROM reminder_log WHERE rule_id = $1 AND learner_id = $2 AND outcome = 'queued'`, [rid, kid.id]))!.n);
    expect(await count()).toBe(1);
    await runRule(rid, { force: true }); expect(await count()).toBe(1);                                   // same day: nothing new
    await exec(`UPDATE fee_installments SET due_date = $2 WHERE learner_id = $1`, [kid.id, D(-5)]);        // now 5 days overdue -> second reminder
    await runRule(rid, { force: true }); expect(await count()).toBe(2);
    await exec(`UPDATE fee_installments SET due_date = $2 WHERE learner_id = $1`, [kid.id, D(-9)]);        // 9 days -> would be a third: over the limit
    await runRule(rid, { force: true }); expect(await count()).toBe(2);
    await pass();
    const sent = fake.calls.filter((c) => c.destination === '919840000020').map((c) => c.templateParams[3]);
    expect(sent).toEqual(['2', '5']);                                                                     // the days-overdue token was filled in each time
    void mine;
  });
  it('does not remind about installments that are already paid', async () => {
    const plan = (await w.admin.post('/api/fees/plans', { name: 'Paid plan', items: [{ label: 'One', amount: 500, due_days: 0 }] })).body.data.id;
    const kid = await newLearner(w, { full_name: 'Paid Kid', parent: { full_name: 'Paid Parent', mobile: '9840000021' }, batch_ids: [w.batches.roboA] });
    await assignFee([kid.id], plan, -10);
    await w.admin.post('/api/fees/payments', { learner_id: kid.id, amount: 500, method: 'cash' });
    const rid = (await w.admin.post('/api/reminders/rules', rule({ name: 'Chase 2', kind: 'fee_overdue', template_id: tplFee, offset_value: 1, variables: ['{parent_name}', '{learner_first_name}', '{amount_due}', '{days_overdue}'] }))).body.data.id;
    await runRule(rid, { force: true });
    expect((await query(`SELECT COUNT(*) AS n FROM reminder_log WHERE rule_id = $1 AND learner_id = $2`, [rid, kid.id]))[0].n).toBe(0);
  });
});

describe('class and absence reminders', () => {
  it('reminds each learner once about a class that starts soon, and not about cancelled or far-off classes', async () => {
    const soon = new Date(Date.now() + 2 * 3600_000); const later = new Date(Date.now() + 30 * 3600_000);
    const mk = (d: Date, title: string) => w.admin.post(`/api/classrooms/${w.batches.roboA}/sessions`, { title, starts_at: d.toISOString(), ends_at: new Date(d.getTime() + 3600_000).toISOString() });
    const a = await mk(soon, 'Line follower lab'); expect(a.status).toBe(201);
    const far = await mk(later, 'Far class'); expect(far.status).toBe(201);
    const rid = (await w.admin.post('/api/reminders/rules', rule({ name: 'Class soon', kind: 'class_upcoming', template_id: tplClass, offset_value: 3, audience: 'learners', variables: ['{learner_first_name}', '{class_title}', '{class_time}'] }))).body.data.id;
    // learners need mobile numbers for this audience
    await exec(`UPDATE learners SET mobile = CONCAT('+9199000000', RIGHT(learner_code, 2)) WHERE org_id = $1 AND mobile IS NULL`, [w.orgId]);
    const r1 = await runRule(rid, { force: true });
    expect(r1.queued).toBeGreaterThanOrEqual(4);
    const r2 = await runRule(rid, { force: true }); expect(r2.queued).toBe(0);
    await pass();
    const msgs = fake.calls.filter((c) => c.campaignName === 'class_reminder_v1');
    expect(msgs.length).toBeGreaterThanOrEqual(4);
    expect(msgs.every((m) => m.templateParams[1] === 'Line follower lab')).toBe(true);
    expect(msgs[0]!.templateParams[2]).toMatch(/\d{1,2}:\d{2}\s?(am|pm)/i);
  });
  it('tells a parent when their child was marked absent', async () => {
    const adminId = (await queryOne(`SELECT id FROM users WHERE email = $1`, [w.adminEmail]))!.id;
    const s = (await queryOne(`SELECT id FROM class_sessions WHERE org_id = $1 AND title = 'Line follower lab'`, [w.orgId]))!.id;
    await exec(`INSERT INTO attendance (id, org_id, session_id, batch_id, learner_id, status, marked_by, marked_at) VALUES (UUID(), $1, $2, $3, $4, 'absent', $5, DATE_SUB(NOW(3), INTERVAL 2 HOUR))`, [w.orgId, s, w.batches.roboA, solo.id, adminId]);
    await exec(`INSERT INTO attendance (id, org_id, session_id, batch_id, learner_id, status, marked_by, marked_at) VALUES (UUID(), $1, $2, $3, $4, 'present', $5, DATE_SUB(NOW(3), INTERVAL 2 HOUR))`, [w.orgId, s, w.batches.roboA, ravi.id, adminId]);
    const rid = (await w.admin.post('/api/reminders/rules', rule({ name: 'Absent', kind: 'absence', template_id: tplAbs, offset_value: 1, variables: ['{parent_name}', '{learner_first_name}', '{class_title}'] }))).body.data.id;
    const r = await runRule(rid, { force: true });
    expect(r.queued).toBe(1); expect(r.candidates).toBe(1);
    await pass();
    const m = fake.calls.find((c) => c.campaignName === 'absence_note_v1')!;
    expect(m.destination).toBe('919840000002'); expect(m.templateParams).toEqual(['Solo Parent', 'Solo', 'Line follower lab']);
    expect((await runRule(rid, { force: true })).queued).toBe(0);
  });
});

describe('the log and the audit trail', () => {
  it('lists what each rule did, paginated and filterable, and audits rule changes', async () => {
    const log = await w.admin.get('/api/reminders/log?page_size=5');
    expect(log.status).toBe(200); expect(log.body.data.length).toBeLessThanOrEqual(5); expect(log.body.meta.total).toBeGreaterThan(5);
    expect((await w.admin.get('/api/reminders/log?outcome=skipped')).body.data.every((r: any) => r.outcome === 'skipped')).toBe(true);
    expect((await other.admin.get('/api/reminders/log')).body.meta.total).toBe(0);
    const a = (await query(`SELECT DISTINCT action FROM audit_logs WHERE org_id = $1 AND action LIKE 'reminder_rule.%'`, [w.orgId])).map((r) => r.action);
    expect(a).toEqual(expect.arrayContaining(['reminder_rule.created', 'reminder_rule.enabled', 'reminder_rule.disabled', 'reminder_rule.run_now', 'reminder_rule.deleted']));
  });
});
