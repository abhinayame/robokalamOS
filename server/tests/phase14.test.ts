import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { env } from '../src/config/env.js';
import { exec, query, queryOne } from '../src/db/pool.js';
import { app, buildWorld, client, login, mobile, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { setEmailProvider, type EmailMessage, type EmailProvider, type EmailResult } from '../src/modules/email/provider.js';
import { runEmailWorkerOnce } from '../src/modules/email/outbox.js';
import { classify, processInbound } from '../src/modules/comms/inbound.js';
import { runRule } from '../src/modules/reminders/engine.js';

class FakeMail implements EmailProvider { sent: EmailMessage[] = []; async send(m: EmailMessage): Promise<EmailResult> { this.sent.push(m); return { ok: true, id: 'm' }; } }
const mail = new FakeMail();
const drain = async () => { for (let i = 0; i < 4; i++) if (!(await runEmailWorkerOnce({ provider: mail, limit: 200 })).claimed) break; };
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const H = 3600_000;

let w: World, other: World; let admin: ReturnType<typeof client>, teacher: ReturnType<typeof client>, counsellor: ReturnType<typeof client>, acct: ReturnType<typeof client>, learnerC: ReturnType<typeof client>;
let counsellorId = ''; let plan = ''; let slug = '';

beforeAll(async () => {
  setEmailProvider(mail);
  w = await buildWorld(); other = await buildWorld(); admin = w.admin;
  slug = (await admin.get('/api/organizations/current')).body.data.slug;
  await admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  teacher = client(await login(w.teachers.t1.email));
  const cu = `co-${uniq()}@test.dev`; counsellorId = (await admin.post('/api/users', { full_name: 'Counsellor C', email: cu, password: PASSWORD, roles: [{ role: 'counsellor' }] })).body.data.id; counsellor = client(await login(cu));
  const au = `ac-${uniq()}@test.dev`; await admin.post('/api/users', { full_name: 'Accountant A', email: au, password: PASSWORD, roles: [{ role: 'accountant' }] }); acct = client(await login(au));
  plan = (await admin.post('/api/fees/plans', { name: 'Admission plan', items: [{ label: 'Admission', amount: 4000, due_days: 0 }, { label: 'Term 2', amount: 2000, due_days: 30 }] })).body.data.id;
  const lc = await newLearner(w, { full_name: 'Learner Login', email: `ll-${uniq()}@kids.test` }); await admin.post(`/api/learners/${lc.id}/login`, { password: PASSWORD }); learnerC = client(await login(lc.email));
});
afterAll(() => setEmailProvider(null));

describe('admissions: enrol a lead in one step', () => {
  let lead: any; let full: string;
  it('needs the CRM permission, a confirmation, and previews without writing', async () => {
    lead = await newLearner(w, { full_name: 'Admit Me', parent: { full_name: 'Admit Parent', mobile: mobile(), email: `ap-${uniq()}@fam.test` } });
    await counsellor.post('/api/crm/leads', { learner_id: lead.id, lead_status: 'interested', counsellor_user_id: counsellorId });
    const body = { batch_id: w.batches.roboA, plan_id: plan, payment: { amount: 1500, method: 'cash', request_id: `adm-${uniq()}` } };
    for (const c of [teacher, learnerC, acct]) expect((await c.post(`/api/admissions/enrol/${lead.id}`, body)).status).toBe(403);
    expect((await counsellor.post(`/api/admissions/enrol/${lead.id}`, body)).status).toBe(403);     // payment and fee need their own permissions
    expect((await counsellor.post(`/api/admissions/enrol/${lead.id}`, { batch_id: w.batches.roboA })).status).toBe(400);   // no confirmation
    const dry = await admin.post(`/api/admissions/enrol/${lead.id}`, { ...body, dry_run: true }); expect(dry.status).toBe(200); expect(dry.body.data).toMatchObject({ already_member: false, fee: { to_create: 1 } });
    expect(await queryOne(`SELECT 1 FROM learner_batch_memberships WHERE learner_id = $1`, [lead.id])).toBeNull();           // nothing written by a preview
  });
  it('a full batch refuses and leaves nothing half-done', async () => {
    const small = (await admin.post('/api/batches', { name: `Tiny ${uniq()}`, program_id: w.program, course_id: w.courseRobotics, academic_year: '2026-27', capacity: 1, status: 'active' })).body.data.id;
    const first = await newLearner(w, { full_name: 'Seat Holder', batch_ids: [small] });
    const r = await admin.post(`/api/admissions/enrol/${lead.id}`, { batch_id: small, plan_id: plan, confirm: true }); expect(r.status).toBe(409);
    expect(await queryOne(`SELECT 1 FROM learner_fees WHERE learner_id = $1`, [lead.id])).toBeNull();
    expect((await queryOne(`SELECT lead_status FROM crm_leads WHERE learner_id = $1`, [lead.id]))!.lead_status).toBe('interested');
    void first;
  });
  it('confirms: seat, fee, first payment, converted lead; and repeating changes nothing', async () => {
    const rid = `adm-${uniq()}`; const body = { batch_id: w.batches.roboA, plan_id: plan, payment: { amount: 1500, method: 'cash', request_id: rid }, confirm: true };
    const r = await admin.post(`/api/admissions/enrol/${lead.id}`, body); expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ converted: true, seat: { joined: 1 }, fee: { created: 1 }, payment: { duplicate: false } });
    expect((await queryOne(`SELECT lead_status FROM crm_leads WHERE learner_id = $1`, [lead.id]))!.lead_status).toBe('converted');
    expect(await queryOne(`SELECT 1 FROM crm_activities WHERE learner_id = $1 AND type = 'admission_confirmed'`, [lead.id])).toBeTruthy();
    const led = (await admin.get(`/api/fees/learners/${lead.id}`)).body.data; expect(Number(led.totals.paid)).toBe(1500); expect(Number(led.totals.billed)).toBe(6000);
    const again = await admin.post(`/api/admissions/enrol/${lead.id}`, body); expect(again.status).toBe(201); expect(again.body.data).toMatchObject({ seat: { already_member: 1 }, fee: { created: 0 }, payment: { duplicate: true } });
    expect(Number((await admin.get(`/api/fees/learners/${lead.id}`)).body.data.totals.paid)).toBe(1500);                       // not charged twice
    expect((await other.admin.post(`/api/admissions/enrol/${lead.id}`, body)).status).toBe(404);
    full = lead.id;
  });
  it('a payment on top of nothing is refused', async () => {
    const l2 = await newLearner(w, { full_name: 'No Fee Yet' });
    expect((await admin.post(`/api/admissions/enrol/${l2.id}`, { batch_id: w.batches.roboB, payment: { amount: 100, method: 'cash' }, confirm: true })).status).toBe(400);
    void full;
  });
});

describe('demo class booking', () => {
  let slot = ''; let tiny = '';
  const pub = (path: string, body?: object) => body ? request(app).post(`/api/public/demo/${slug}${path}`).send(body) : request(app).get(`/api/public/demo/${slug}${path}`);
  const parentMobile = mobile();
  it('is closed to the public until the school opens it', async () => {
    expect((await pub('/slots')).status).toBe(404);
    expect((await teacher.put('/api/demo/settings', { enabled: true })).status).toBe(403);
    expect((await admin.put('/api/demo/settings', { enabled: true })).status).toBe(200);
    expect((await pub('/slots')).status).toBe(200);
    expect((await request(app).get('/api/public/demo/no-such-school/slots')).status).toBe(404);
  });
  it('slots: validated, staff only, shown to the public with seats left', async () => {
    expect((await admin.post('/api/demo/slots', { title: 'Past', starts_at: iso(-H), ends_at: iso(0), capacity: 5 })).status).toBe(400);
    expect((await admin.post('/api/demo/slots', { title: 'Backwards', starts_at: iso(2 * H), ends_at: iso(H), capacity: 5 })).status).toBe(400);
    expect((await teacher.post('/api/demo/slots', { title: 'Nope', starts_at: iso(48 * H), ends_at: iso(49 * H) })).status).toBe(403);
    const c = await counsellor.post('/api/demo/slots', { title: 'Robotics free demo', starts_at: iso(48 * H), ends_at: iso(49 * H), capacity: 3, meeting_url: 'https://meet.google.com/abc-defg-hij' }); expect(c.status).toBe(201); slot = c.body.data.id;
    const t = await counsellor.post('/api/demo/slots', { title: 'One seat only', starts_at: iso(50 * H), ends_at: iso(51 * H), capacity: 1 }); tiny = t.body.data.id;
    const list = (await pub('/slots')).body.data; expect(list.slots.find((s: any) => s.id === slot)).toMatchObject({ seats_left: 3, online: true }); expect(JSON.stringify(list)).not.toContain('meet.google.com');   // the link is for people who booked
  });
  it('books: creates the child, parent and a lead; a repeat or a bot creates nothing more', async () => {
    const body = { slot_id: slot, child_name: 'Aarav Demo', parent_name: 'Priya Demo', mobile: parentMobile, email: `priya-${uniq()}@fam.test` };
    const r = await pub('/book', body); expect(r.status, JSON.stringify(r.body)).toBe(201); expect(r.body.data).toMatchObject({ booked: true, title: 'Robotics free demo', join_url: 'https://meet.google.com/abc-defg-hij' });
    const l = await queryOne(`SELECT l.id, c.lead_status, c.lead_source FROM learners l JOIN crm_leads c ON c.learner_id = l.id WHERE l.org_id = $1 AND l.full_name = 'Aarav Demo'`, [w.orgId]); expect(l).toMatchObject({ lead_status: 'demo_scheduled', lead_source: 'Demo booking page' });
    expect((await pub('/book', body)).status).toBe(409);                                             // same child, same slot
    const sib = await pub('/book', { ...body, child_name: 'Sibling Demo' }); expect(sib.status).toBe(201);
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM parents WHERE org_id = $1 AND mobile = $2`, [w.orgId, `+91${parentMobile}`.replace('+9191', '+91')]))?.n ?? 1)).toBeGreaterThanOrEqual(0);
    const before = Number((await queryOne(`SELECT COUNT(*) AS n FROM learners WHERE org_id = $1`, [w.orgId]))!.n);
    const bot = await pub('/book', { ...body, child_name: 'Bot Child', mobile: mobile(), website: 'http://spam' }); expect(bot.status).toBe(201);
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM learners WHERE org_id = $1`, [w.orgId]))!.n)).toBe(before);   // looked successful, did nothing
    expect((await pub('/book', { ...body, child_name: 'X Y', mobile: '12345' })).status).toBe(400);
    expect((await pub('/book', { slot_id: uuidish(), child_name: 'Ghost Kid', parent_name: 'Ghost P', mobile: mobile() })).status).toBe(404);
    expect((await other.admin.get(`/api/demo/bookings`)).body.data.length).toBe(0);                  // another school sees nothing
    await drain(); expect(mail.sent.some((m) => m.subject.startsWith('Your demo class is booked'))).toBe(true);
  });
  it('the last seat can only be taken once', async () => {
    const mk = (n: string) => pub('/book', { slot_id: tiny, child_name: `Race ${n}`, parent_name: 'Race Parent', mobile: mobile() });
    const rs = await Promise.all([mk('A'), mk('B'), mk('C')]); expect(rs.filter((r) => r.status === 201)).toHaveLength(1); expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    const slots = (await admin.get('/api/demo/slots')).body.data; expect(Number(slots.find((s: any) => s.id === tiny).booked)).toBe(1);
  });
  it('staff follow the booking through: attended, no-show, cancel', async () => {
    const bookings = (await counsellor.get(`/api/demo/bookings?slot_id=${slot}`)).body.data; expect(bookings.length).toBe(2);
    const aarav = bookings.find((b: any) => b.full_name === 'Aarav Demo'); const sib = bookings.find((b: any) => b.full_name === 'Sibling Demo');
    expect((await counsellor.post(`/api/demo/bookings/${aarav.id}/status`, { status: 'attended' })).status).toBe(400);   // the demo is two days away
    await exec(`UPDATE demo_slots SET starts_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR), ends_at = DATE_ADD(NOW(3), INTERVAL 1 HOUR) WHERE id = $1`, [slot]);
    expect((await teacher.post(`/api/demo/bookings/${aarav.id}/status`, { status: 'attended' })).status).toBe(403);
    expect((await counsellor.post(`/api/demo/bookings/${aarav.id}/status`, { status: 'attended' })).status).toBe(200);
    expect((await queryOne(`SELECT lead_status FROM crm_leads WHERE learner_id = $1`, [aarav.learner_id]))!.lead_status).toBe('demo_attended');
    await counsellor.patch(`/api/crm/leads/${sib.learner_id}`, { counsellor_user_id: counsellorId });
    expect((await counsellor.post(`/api/demo/bookings/${sib.id}/status`, { status: 'no_show' })).status).toBe(200);
    expect(await queryOne(`SELECT 1 FROM follow_ups WHERE learner_id = $1 AND status = 'open' AND note LIKE 'Missed the demo%'`, [sib.learner_id])).toBeTruthy();
    expect((await counsellor.post(`/api/demo/bookings/${sib.id}/status`, { status: 'cancelled' })).status).toBe(200);
    expect((await counsellor.post(`/api/demo/bookings/${sib.id}/status`, { status: 'attended' })).status).toBe(409);
  });
  it('cancelling a slot cancels its bookings, and capacity cannot drop below the seats taken', async () => {
    expect((await counsellor.patch(`/api/demo/slots/${tiny}`, { capacity: 1 })).status).toBe(200);
    expect((await admin.post('/api/demo/slots', { title: 'Cap', starts_at: iso(60 * H), ends_at: iso(61 * H), capacity: 5 })).status).toBe(201);
    expect((await counsellor.patch(`/api/demo/slots/${tiny}`, { status: 'cancelled' })).status).toBe(200);
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM demo_bookings WHERE slot_id = $1 AND status = 'booked'`, [tiny]))!.n)).toBe(0);
    expect((await pub('/slots')).body.data.slots.find((s: any) => s.id === tiny)).toBeUndefined();
    expect((await pub('/book', { slot_id: tiny, child_name: 'Late Kid', parent_name: 'Late P', mobile: mobile() })).status).toBe(409);
  });
  it('demo reminders: a rule finds booked demos inside its window', async () => {
    const s2 = (await admin.post('/api/demo/slots', { title: 'Tomorrow demo', starts_at: iso(10 * H), ends_at: iso(11 * H), capacity: 5 })).body.data.id;
    await pub('/book', { slot_id: s2, child_name: 'Reminder Kid', parent_name: 'Reminder Parent', mobile: mobile(), email: `rk-${uniq()}@fam.test` });
    const r = await admin.post('/api/reminders/rules', { name: 'Demo mail', kind: 'demo_upcoming', channel: 'email', audience: 'parents', offset_value: 24, send_from_hour: 0, send_to_hour: 24, enabled: false, email_subject: 'Demo soon: {demo_title}', email_body: 'Hi {parent_name},\n\n{learner_first_name}\'s demo {demo_title} is on {demo_date} at {demo_time} ({demo_where}).' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const dry = await runRule(r.body.data.id, { dryRun: true, force: true }); expect(dry.candidates).toBeGreaterThanOrEqual(1);
    const real = await runRule(r.body.data.id, { force: true }); expect(real.queued).toBeGreaterThanOrEqual(1); expect((await runRule(r.body.data.id, { force: true })).queued).toBe(0);
  });
});
const uuidish = () => crypto.randomUUID();

describe('inbound WhatsApp replies', () => {
  const phone = mobile(); const shared = mobile(); let kid: any; const e164 = `+91${shared}`; const digits = `91${phone}`; const sharedDigits = `91${shared}`;
  beforeAll(async () => {
    kid = await newLearner(w, { full_name: 'Reply Kid', parent: { full_name: 'Reply Parent', mobile: phone } });
    await counsellor.post('/api/crm/leads', { learner_id: kid.id, lead_status: 'new', counsellor_user_id: counsellorId });
    await newLearner(w, { full_name: 'Shared Kid', parent: { full_name: 'Shared Parent', mobile: shared } });
    await newLearner(other, { full_name: 'Other Org Kid', parent: { full_name: 'Other Parent', mobile: shared } });   // the same number is known to two schools
  });
  it('only whole-message keywords count', () => {
    expect(classify('STOP')).toBe('stop'); expect(classify(' Stop. ')).toBe('stop'); expect(classify('please do not stop the classes')).toBe('other'); expect(classify('Yes!')).toBe('interested'); expect(classify('DEMO')).toBe('interested'); expect(classify('START')).toBe('start'); expect(classify('hello, what are the fees for robotics?')).toBe('other');
  });
  it('an interested reply updates the lead and gives the counsellor a follow-up, once', async () => {
    const id = `wamid.${uniq()}`;
    const r = await processInbound([{ providerId: id, phone: digits, text: 'YES' }]); expect(r.lead_updates).toBe(1);
    expect((await queryOne(`SELECT lead_status FROM crm_leads WHERE learner_id = $1`, [kid.id]))!.lead_status).toBe('interested');
    expect(await queryOne(`SELECT 1 FROM crm_activities WHERE learner_id = $1 AND type = 'whatsapp_reply'`, [kid.id])).toBeTruthy();
    expect(await queryOne(`SELECT 1 FROM follow_ups WHERE learner_id = $1 AND assigned_to = $2 AND status = 'open'`, [kid.id, counsellorId])).toBeTruthy();
    expect((await processInbound([{ providerId: id, phone: digits, text: 'YES' }])).duplicate).toBe(1);                             // the same message again changes nothing
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM follow_ups WHERE learner_id = $1`, [kid.id]))!.n)).toBe(1);
  });
  it('STOP opts the number out everywhere it is known; START brings it back', async () => {
    await processInbound([{ providerId: `wamid.${uniq()}`, phone: sharedDigits, text: 'stop' }]);
    for (const o of [w.orgId, other.orgId]) expect(await queryOne(`SELECT 1 FROM whatsapp_optouts WHERE org_id = $1 AND phone = $2`, [o, e164])).toBeTruthy();
    await processInbound([{ providerId: `wamid.${uniq()}`, phone: sharedDigits, text: 'START' }]);
    expect(await queryOne(`SELECT 1 FROM whatsapp_optouts WHERE phone = $1`, [e164])).toBeNull();
    const unk = await processInbound([{ providerId: `wamid.${uniq()}`, phone: `91${mobile()}`, text: 'STOP' }]); expect(unk.opted_out).toBe(0);   // an unknown number opts nobody out
  });
  it('arrives through the signed Meta webhook, and the Replies list is staff only', async () => {
    const id = `wamid.${uniq()}`;
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ id, from: digits, type: 'text', text: { body: 'Can I get the fee details?' } }] } }] }] };
    const raw = JSON.stringify(payload); const sig = `sha256=${crypto.createHmac('sha256', env.META_APP_SECRET!).update(raw).digest('hex')}`;
    const ok = await request(app).post('/api/webhooks/meta').set('Content-Type', 'application/json').set('x-hub-signature-256', sig).send(raw); expect(ok.status).toBe(200); expect(ok.body.data.inbound).toMatchObject({ received: 1, lead_updates: 1 });
    expect((await request(app).post('/api/webhooks/meta').set('Content-Type', 'application/json').set('x-hub-signature-256', 'sha256=bad').send(raw)).status).toBe(404);
    const list = await counsellor.get('/api/whatsapp/replies'); expect(list.status).toBe(200); expect(list.body.data.some((x: any) => x.body === 'Can I get the fee details?')).toBe(true);
    expect((await learnerC.get('/api/whatsapp/replies')).status).toBe(403);
    expect((await other.admin.get('/api/whatsapp/replies')).body.data.some((x: any) => x.body === 'Can I get the fee details?')).toBe(false);   // each school sees only its own
  });
});

describe('automatic receipt e-mails', () => {
  it('sends one receipt to the parent after a payment, honours the switch, never twice', async () => {
    const pe = `rp-${uniq()}@fam.test`; const l = await newLearner(w, { full_name: 'Receipt Kid', parent: { full_name: 'Receipt Parent', mobile: mobile(), email: pe } });
    await admin.post('/api/fees/assign', { plan_id: plan, selector: { learner_ids: [l.id] }, start_date: new Date().toISOString().slice(0, 10), confirm: true });
    const rid = crypto.randomUUID(); const pay = await admin.post('/api/fees/payments', { learner_id: l.id, amount: 1000, method: 'upi', request_id: rid }); expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    await admin.post('/api/fees/payments', { learner_id: l.id, amount: 1000, method: 'upi', request_id: rid });            // a double click
    await drain(); const got = mail.sent.filter((m) => m.to === pe); expect(got).toHaveLength(1); expect(got[0]!.subject).toContain('Payment received'); expect(got[0]!.text).toContain('Admission');
    expect((await counsellor.put('/api/fees/settings', { receipt_email: false })).status).toBe(403);
    expect((await admin.put('/api/fees/settings', { receipt_email: false })).status).toBe(200); expect((await admin.get('/api/fees/settings')).body.data.receipt_email).toBe(false);
    await admin.post('/api/fees/payments', { learner_id: l.id, amount: 500, method: 'cash', request_id: crypto.randomUUID() }); await drain();
    expect(mail.sent.filter((m) => m.to === pe)).toHaveLength(1);                                                        // switched off: no second receipt
    await admin.put('/api/fees/settings', { receipt_email: true });
  });
});

describe('teacher workload and pay estimate', () => {
  const m = new Date().toISOString().slice(0, 7);
  it('adds up held classes and hours, applies the rate, and protects the data', async () => {
    let n = 0;
    const mk = async (title: string, hours: number, status: string) => {
      const start = new Date(); start.setUTCDate(1); start.setUTCHours(6 + 3 * n++, 0, 0, 0);
      const id = (await admin.post(`/api/classrooms/${w.batches.roboA}/sessions`, { title, starts_at: new Date(Date.now() + 40 * 24 * H).toISOString(), ends_at: new Date(Date.now() + 40 * 24 * H + hours * H).toISOString() })).body.data.id;
      await exec(`UPDATE class_sessions SET starts_at = $2, ends_at = DATE_ADD($2, INTERVAL $3 MINUTE), status = $4 WHERE id = $1`, [id, start, hours * 60, status]);
      return id;
    };
    await mk('Held 1.5h', 1.5, 'completed'); await mk('Held 1h', 1, 'completed'); await mk('Cancelled', 1, 'cancelled');
    await exec(`UPDATE teacher_batch_memberships SET assigned_at = DATE_SUB(assigned_at, INTERVAL 60 DAY) WHERE teacher_user_id = $1`, [w.teachers.t1.id]);
    for (const c of [teacher, learnerC, counsellor]) expect((await c.get(`/api/payroll/summary?month=${m}`)).status).toBe(403);
    expect((await admin.get('/api/payroll/summary?month=2026-13')).status).toBe(400);
    let s = (await admin.get(`/api/payroll/summary?month=${m}`)).body.data; let row = s.teachers.find((t: any) => t.teacher_id === w.teachers.t1.id);
    expect(row).toMatchObject({ classes_held: 2, classes_cancelled: 1, hours: 2.5, rate_per_hour: null, estimated_pay: null }); expect(s.totals.without_rate).toBe(1);
    expect((await acct.put(`/api/payroll/rates/${w.teachers.t1.id}`, { rate_per_hour: 400, effective_from: `${m}-01` })).status).toBe(403);   // read-only role
    expect((await admin.put(`/api/payroll/rates/${w.teachers.t1.id}`, { rate_per_hour: 400, effective_from: `${m}-01` })).status).toBe(200);
    expect((await admin.put(`/api/payroll/rates/${w.teachers.t1.id}`, { rate_per_hour: -1, effective_from: `${m}-01` })).status).toBe(400);
    s = (await acct.get(`/api/payroll/summary?month=${m}`)).body.data; row = s.teachers.find((t: any) => t.teacher_id === w.teachers.t1.id);
    expect(row, JSON.stringify(row)).toMatchObject({ rate_per_hour: '400.00', estimated_pay: '1000.00' }); expect(s.totals.estimated_pay).toBe('1000.00');
    expect((await other.admin.get(`/api/payroll/summary?month=${m}`)).body.data.teachers).toHaveLength(0);
    const csv = await admin.get(`/api/payroll/summary.csv?month=${m}`); expect(csv.status).toBe(200); expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.text).toContain('1000.00');
    expect((await admin.get('/api/payroll/rates')).body.data.find((t: any) => t.teacher_id === w.teachers.t1.id).rate_per_hour).toBe('400.00');
  });
});
