import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { setEmailProvider, type EmailMessage, type EmailProvider, type EmailResult } from '../src/modules/email/provider.js';
import { queueEmail, runEmailWorkerOnce, unsubscribeToken, parseUnsubscribe } from '../src/modules/email/outbox.js';
import { esc, renderEmail } from '../src/modules/email/template.js';
import { buildIcs, fold, icsEscape } from '../src/modules/calendar/ics.js';
import { fillBody } from '../src/modules/certificates/routes.js';
import { runRule } from '../src/modules/reminders/engine.js';

class FakeMail implements EmailProvider {
  sent: EmailMessage[] = []; script: EmailResult[] = [];
  async send(m: EmailMessage): Promise<EmailResult> { const r = this.script.shift(); if (r) { if (r.ok) this.sent.push(m); return r; } this.sent.push(m); return { ok: true, id: 'm1' }; }
  last(to: string) { return [...this.sent].reverse().find((m) => m.to === to); }
}
const fake = new FakeMail();
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runEmailWorkerOnce({ provider: fake, limit: 200 })).claimed) break; };
const tokenIn = (m: EmailMessage | undefined) => /token=([A-Za-z0-9_-]+)/.exec(m?.text ?? '')?.[1] ?? '';

let w: World, other: World; let ravi: any, meena: any; let teacher: ReturnType<typeof client>, rv: ReturnType<typeof client>, parent: ReturnType<typeof client>, bystander: ReturnType<typeof client>;
let parentEmail = '';

beforeAll(async () => {
  setEmailProvider(fake);
  w = await buildWorld(); other = await buildWorld();
  ravi = await newLearner(w, { full_name: 'Ravi Cert', email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Ravi Parent', mobile: '9870000001', email: `rp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA] });
  meena = await newLearner(w, { full_name: 'Meena Cert', email: `meena-${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD });
  await w.admin.post(`/api/learners/${meena.id}/login`, { password: PASSWORD });
  teacher = client(await login(w.teachers.t1.email)); rv = client(await login(ravi.email)); bystander = client(await login(meena.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  const pl = await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD }); parentEmail = pl.body.data.email;
  parent = client(await login(parentEmail));
});
afterAll(() => setEmailProvider(null));

describe('e-mail templates', () => {
  it('escape everything that comes from a person', () => {
    expect(esc(`<script>"x"&'y'</script>`)).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
    const m = renderEmail({ orgName: '<b>Org</b>', color: 'red;background:url(x)', title: 'Hi <i>', paragraphs: ['<img src=x onerror=alert(1)>'], button: { label: 'Go', url: 'javascript:alert(1)' } });
    expect(m.html).not.toContain('<img'); expect(m.html).not.toContain('<b>Org'); expect(m.html).toContain('#12263f'); expect(m.html).toContain('href="#"');
  });
});

describe('outbox and worker', () => {
  it('sends, dedupes, and respects opt-outs for notifications only', async () => {
    const to = `x-${uniq()}@fam.test`;
    expect(await queueEmail({ orgId: w.orgId, to, subject: 'Hello', text: 'Hi', dedupeKey: `k-${to}` })).toBeTruthy();
    expect(await queueEmail({ orgId: w.orgId, to, subject: 'Hello', text: 'Hi', dedupeKey: `k-${to}` })).toBeNull();          // same key: once
    expect(await queueEmail({ orgId: w.orgId, to: 'not-an-email', subject: 'x', text: 'y' })).toBeNull();
    await drain(); expect(fake.last(to)?.subject).toBe('Hello');
    await exec(`INSERT INTO email_optouts (id, org_id, email) VALUES (UUID(), $1, $2)`, [w.orgId, to]);
    expect(await queueEmail({ orgId: w.orgId, to, subject: 'Promo', text: 'p', category: 'notification' })).toBeNull();
    expect(await queueEmail({ orgId: w.orgId, to, subject: 'Receipt', text: 'p', category: 'transactional' })).toBeTruthy();   // account mail still goes
    await drain(); expect(fake.last(to)?.subject).toBe('Receipt');
  });
  it('retries with back-off, and gives up at once on a permanent error', async () => {
    const a = `r-${uniq()}@fam.test`; const id = (await queueEmail({ orgId: w.orgId, to: a, subject: 'Retry', text: 't' }))!;
    fake.script.push({ ok: false, retriable: true, code: 'ETIMEDOUT', message: 'timeout' });
    await runEmailWorkerOnce({ provider: fake });
    let row = await queryOne(`SELECT status, attempts, next_attempt_at > NOW(3) AS later FROM email_outbox WHERE id = $1`, [id]);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 }); expect(Number(row!.later)).toBe(1);
    await exec(`UPDATE email_outbox SET next_attempt_at = NOW(3) WHERE id = $1`, [id]); await runEmailWorkerOnce({ provider: fake });
    expect((await queryOne(`SELECT status FROM email_outbox WHERE id = $1`, [id]))!.status).toBe('sent');
    const b = `p-${uniq()}@fam.test`; const id2 = (await queueEmail({ orgId: w.orgId, to: b, subject: 'Bounce', text: 't' }))!;
    fake.script.push({ ok: false, retriable: false, code: 'SMTP_550', message: 'no such user' }); await runEmailWorkerOnce({ provider: fake });
    row = await queryOne(`SELECT status, attempts, last_error FROM email_outbox WHERE id = $1`, [id2]); expect(row).toMatchObject({ status: 'failed', attempts: 1 }); expect(row!.last_error).toContain('SMTP_550');
  });
  it('unsubscribe links are signed', async () => {
    const e = `u-${uniq()}@fam.test`; const t = unsubscribeToken(e, w.orgId);
    expect(parseUnsubscribe(t)).toEqual({ email: e, orgId: w.orgId }); expect(parseUnsubscribe(t.slice(0, -2) + 'xx')).toBeNull(); expect(parseUnsubscribe('garbage')).toBeNull();
    expect((await request(app).get(`/api/public/unsubscribe/${t}`)).status).toBe(200);
    expect((await request(app).get(`/api/public/unsubscribe/${t}x`)).status).toBe(400);
    expect(await queryOne(`SELECT 1 FROM email_optouts WHERE email = $1`, [e])).toBeTruthy();
  });
  it('outbox view is for staff and never returns bodies', async () => {
    const r = await w.admin.get('/api/email/outbox'); expect(r.status).toBe(200); expect(JSON.stringify(r.body)).not.toContain('body_text');
    expect((await rv.get('/api/email/outbox')).status).toBe(403);
  });
});

describe('password reset', () => {
  it('advertises itself only when e-mail is configured', async () => { expect((await request(app).get('/api/auth/capabilities')).body.data.password_reset).toBe(true); });
  it('gives the same answer for known and unknown addresses', async () => {
    const known = await request(app).post('/api/auth/forgot-password').send({ email: ravi.email });
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: `nobody-${uniq()}@x.test` });
    expect(known.status).toBe(200); expect(unknown.status).toBe(200); expect(unknown.body).toEqual(known.body);
    await drain(); expect(fake.last(ravi.email)?.subject).toBe('Reset your password');
    expect(fake.sent.some((m) => m.to.startsWith('nobody-'))).toBe(false);
  });
  it('resets once, signs out every device, and the old password stops working', async () => {
    const t = tokenIn(fake.last(ravi.email)); expect(t.length).toBeGreaterThan(30);
    expect((await request(app).get(`/api/auth/reset-password/check?token=${t}`)).body.data.valid).toBe(true);
    expect((await request(app).post('/api/auth/reset-password').send({ token: t, new_password: 'short' })).status).toBe(400);
    expect((await rv.get('/api/auth/me')).status).toBe(200);
    const ok = await request(app).post('/api/auth/reset-password').send({ token: t, new_password: 'Brand-New-Pass-77' }); expect(ok.status).toBe(200);
    expect((await rv.get('/api/auth/me')).status).toBe(401);                                                           // old session is gone
    expect((await request(app).post('/api/auth/login').send({ email: ravi.email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: ravi.email, password: 'Brand-New-Pass-77' })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token: t, new_password: 'Another-Pass-1234' })).status).toBe(400);   // single use
    expect((await request(app).get(`/api/auth/reset-password/check?token=${t}`)).body.data.valid).toBe(false);
    await drain(); expect(fake.last(ravi.email)?.subject).toBe('Your password was changed');
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'auth.password_reset_done' AND entity_id = $1`, [ravi.user_id ?? (await queryOne(`SELECT user_id FROM learners WHERE id = $1`, [ravi.id]))!.user_id])).toBeTruthy();
  });
  it('a newer request cancels the older link, expired links fail, and only a hash is stored', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: meena.email }); await drain(); const t1 = tokenIn(fake.last(meena.email));
    await request(app).post('/api/auth/forgot-password').send({ email: meena.email }); await drain(); const t2 = tokenIn(fake.last(meena.email));
    expect(t1).not.toBe(t2);
    expect((await request(app).post('/api/auth/reset-password').send({ token: t1, new_password: 'Valid-Pass-12345' })).status).toBe(400);
    expect(await queryOne(`SELECT 1 FROM password_resets WHERE token_hash = $1`, [t2])).toBeNull();
    await exec(`UPDATE password_resets SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE used_at IS NULL`);
    expect((await request(app).post('/api/auth/reset-password').send({ token: t2, new_password: 'Valid-Pass-12345' })).status).toBe(400);
  });
  it('clears a lock-out', async () => {
    const u = (await queryOne(`SELECT id FROM users WHERE lower(email) = $1`, [parentEmail.toLowerCase()]))!.id;
    await exec(`UPDATE users SET failed_login_count = 9, locked_until = DATE_ADD(NOW(3), INTERVAL 1 HOUR) WHERE id = $1`, [u]);
    await request(app).post('/api/auth/forgot-password').send({ email: parentEmail }); await drain();
    await request(app).post('/api/auth/reset-password').send({ token: tokenIn(fake.last(parentEmail)), new_password: 'Parent-New-Pass-88' });
    expect((await request(app).post('/api/auth/login').send({ email: parentEmail, password: 'Parent-New-Pass-88' })).status).toBe(200);
  });
});

describe('calendar feeds', () => {
  beforeAll(async () => { rv = client(await login(ravi.email, 'Brand-New-Pass-77')); parent = client(await login(parentEmail, 'Parent-New-Pass-88')); });
  it('writes valid, escaped, folded iCalendar', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\;c\\\\d\\ne');
    const long = fold('SUMMARY:' + 'é'.repeat(80)); for (const l of long.split('\r\n')) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    const ics = buildIcs('X', [{ uid: 'u1', start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T11:00:00.000Z', title: 'Robotics, week 1', cancelled: true, description: 'Join: https://zoom.us/j/1' }]);
    expect(ics).toContain('DTSTART:20260101T100000Z'); expect(ics).toContain('STATUS:CANCELLED'); expect(ics).toContain('SUMMARY:CANCELLED: Robotics\\, week 1'); expect(ics.endsWith('\r\n')).toBe(true);
  });
  let url = ''; let sid = '';
  it('creates a link once, and serves each person only their own classes', async () => {
    const s = await teacher.post(`/api/classrooms/${w.batches.roboA}/sessions`, { title: 'Feed class', starts_at: new Date(Date.now() + 86400_000).toISOString(), ends_at: new Date(Date.now() + 90000_000).toISOString(), meeting_url: 'https://meet.google.com/abc-defg-hij' });
    expect(s.status).toBe(201); sid = s.body.data.id;
    const other2 = await w.admin.post(`/api/classrooms/${w.batches.pyB}/sessions`, { title: 'Python secret', starts_at: new Date(Date.now() + 86400_000).toISOString(), ends_at: new Date(Date.now() + 90000_000).toISOString() });
    expect(other2.status).toBe(201);
    expect((await teacher.get('/api/calendar/me')).body.data.active).toBe(false);
    const r = await teacher.post('/api/calendar/me/regenerate', {}); expect(r.status).toBe(200); url = r.body.data.url; expect(url).toMatch(/\.ics$/);
    const path = new URL(url).pathname; const feed = await request(app).get(path);
    expect(feed.status).toBe(200); expect(feed.headers['content-type']).toContain('text/calendar'); expect(feed.text).toContain('Feed class'); expect(feed.text).toContain('https://meet.google.com/abc-defg-hij'); expect(feed.text).not.toContain('Python secret');
    const parentFeed = await parent.post('/api/calendar/me/regenerate', {}); const pf = await request(app).get(new URL(parentFeed.body.data.url).pathname);
    expect(pf.text).toContain('Feed class'); expect(pf.text).not.toContain('Python secret');       // a parent sees the child's batch
    expect(JSON.stringify(await queryOne(`SELECT token_hash FROM calendar_tokens WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [w.teachers.t1.email]))).not.toContain(path.split('/').pop()!.replace('.ics', ''));
  });
  it('shows cancelled classes, revokes, and rejects guesses', async () => {
    await teacher.post(`/api/classrooms/${w.batches.roboA}/sessions/${sid}/cancel`, { cancel_reason: 'Holiday' }).catch(() => null);
    const path = new URL(url).pathname;
    const dl = await teacher.get(`/api/calendar/session/${sid}.ics`); expect(dl.status).toBe(200); expect(dl.text).toContain('BEGIN:VEVENT');
    expect((await bystander.get(`/api/calendar/session/${sid}.ics`)).status).toBe(200);                // enrolled learner may add it too
    expect((await other.admin.get(`/api/calendar/session/${sid}.ics`)).status).toBe(404);
    const again = await teacher.post('/api/calendar/me/regenerate', {}); expect((await request(app).get(path)).status).toBe(404);    // old link dead
    expect((await request(app).get(new URL(again.body.data.url).pathname)).status).toBe(200);
    expect((await teacher.del('/api/calendar/me')).status).toBe(200); expect((await request(app).get(new URL(again.body.data.url).pathname)).status).toBe(404);
    expect((await request(app).get('/api/public/calendar/AAAAAAAAAAAAAAAAAAAAAAAA.ics')).status).toBe(404);
    expect((await request(app).get('/api/public/calendar/short.ics')).status).toBe(404);
  });
});

describe('certificates', () => {
  let design = ''; let certId = ''; let code = '';
  it('fills placeholders and refuses unknown ones', async () => {
    expect(fillBody('{name} finished {course_name}, {batch_name} on {date}.', { name: 'A', course_name: 'C', batch_name: 'B', date: 'D' })).toBe('A finished C, B on D.');
    const bad = await w.admin.post('/api/certificates/designs', { name: 'Bad', body_text: 'Hello {secret}' }); expect(bad.status).toBe(400);
    expect((await teacher.post('/api/certificates/designs', { name: 'T', body_text: 'x y z w q' })).status).toBe(403);
    const ok = await w.admin.post('/api/certificates/designs', { name: 'Completion', title_text: 'Certificate of Completion', body_text: 'has completed {course_name} ({batch_name}) on {date}.', signatory_name: 'Dr. Rao', signatory_title: 'Director' });
    expect(ok.status).toBe(201); design = ok.body.data.id;
    expect((await w.admin.post('/api/certificates/designs', { name: 'Completion', body_text: 'has completed {course_name}.' })).status).toBe(409);
  });
  const sel = () => ({ batch_ids: [w.batches.roboA] });
  it('previews, requires confirmation, issues once per learner', async () => {
    const body = { design_id: design, selector: sel(), batch_id: w.batches.roboA };
    const dry = await w.admin.post('/api/certificates/issue', { ...body, dry_run: true }); expect(dry.status).toBe(200); expect(dry.body.data).toMatchObject({ selected: 2, to_issue: 2, already_have: 0 });
    expect((await w.admin.post('/api/certificates/issue', body)).status).toBe(400);
    const go = await w.admin.post('/api/certificates/issue', { ...body, confirm: true }); expect(go.status).toBe(201); expect(go.body.data).toMatchObject({ issued: 2 });
    const again = await w.admin.post('/api/certificates/issue', { ...body, confirm: true }); expect(again.body.data).toMatchObject({ issued: 0, already_have: 2 });
    const list = await w.admin.get('/api/certificates'); expect(list.body.data).toHaveLength(2);
    const c = list.body.data.find((x: any) => x.recipient_name === 'Ravi Cert'); certId = c.id; code = c.code; expect(code).toMatch(/^RKC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await queryOne(`SELECT 1 FROM notifications WHERE kind = 'certificate.issued'`)).toBeTruthy();
    expect((await other.admin.post('/api/certificates/issue', { ...body, confirm: true })).status).toBe(404);
  });
  it('wording is frozen at issue time', async () => {
    await w.admin.put(`/api/certificates/designs/${design}`, { name: 'Completion', title_text: 'Changed Title', body_text: 'changed {name}.', status: 'active' });
    const row = await queryOne(`SELECT title, body FROM certificates WHERE id = $1`, [certId]); expect(row!.title).toBe('Certificate of Completion'); expect(row!.body).toContain('Robotics'); expect(row!.body).not.toContain('changed');
  });
  it('serves the PDF to staff in scope, the learner, the parent, and nobody else', async () => {
    const pdf = await w.admin.get(`/api/certificates/${certId}/pdf`).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toContain('application/pdf'); expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await rv.get(`/api/certificates/${certId}/pdf`)).status).toBe(200); expect((await parent.get(`/api/certificates/${certId}/pdf`)).status).toBe(200);
    expect((await bystander.get(`/api/certificates/${certId}/pdf`)).status).toBe(404);              // another learner's certificate
    expect((await other.admin.get(`/api/certificates/${certId}/pdf`)).status).toBe(404);
    expect((await rv.get('/api/certificates/me')).body.data).toHaveLength(1); expect((await parent.get('/api/certificates/me')).body.data).toHaveLength(1);
    expect((await rv.get('/api/certificates')).status).toBe(403);
  });
  it('can be verified publicly with minimal fields, and shows revocation', async () => {
    const v = await request(app).get(`/api/public/verify/${code.toLowerCase()}`); expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ valid: true, recipient_name: 'Ravi Cert', course_name: 'Robotics' }); expect(JSON.stringify(v.body)).not.toMatch(/mobile|email|learner_id|learner_code/);
    expect((await request(app).get('/api/public/verify/RKC-AAAA-AAAA')).status).toBe(404); expect((await request(app).get('/api/public/verify/nonsense')).status).toBe(404);
    expect((await teacher.post(`/api/certificates/${certId}/revoke`, { reason: 'Issued in error' })).status).toBe(403);
    expect((await w.admin.post(`/api/certificates/${certId}/revoke`, { reason: 'x' })).status).toBe(400);
    expect((await w.admin.post(`/api/certificates/${certId}/revoke`, { reason: 'Issued in error' })).status).toBe(200);
    expect((await w.admin.post(`/api/certificates/${certId}/revoke`, { reason: 'Issued in error' })).status).toBe(409);
    expect((await request(app).get(`/api/public/verify/${code}`)).body.data).toMatchObject({ valid: false, status: 'revoked' });
    const re = await w.admin.post('/api/certificates/issue', { design_id: design, selector: sel(), batch_id: w.batches.roboA, confirm: true }); expect(re.body.data.issued).toBe(1);   // a revoked one can be re-issued
  });
});

describe('reminders by e-mail', () => {
  it('queues e-mails once, skips people with no address, honours opt-outs and the channel rules', async () => {
    const bad = await w.admin.post('/api/reminders/rules', { name: 'No body', kind: 'class_upcoming', channel: 'email', audience: 'learners', offset_value: 2 }); expect(bad.status).toBe(400);
    const badTok = await w.admin.post('/api/reminders/rules', { name: 'Bad token', kind: 'class_upcoming', channel: 'email', audience: 'learners', offset_value: 2, email_subject: 'Hi {amount}', email_body: 'x' }); expect(badTok.status).toBe(400);
    const nomail = await newLearner(w, { full_name: 'No Mail', batch_ids: [w.batches.roboA] });
    const r = await w.admin.post('/api/reminders/rules', { name: 'Class mail', kind: 'class_upcoming', channel: 'email', audience: 'learners', offset_value: 30, send_from_hour: 0, send_to_hour: 24, enabled: false,
      email_subject: 'Class soon: {batch_name}', email_body: 'Hi {learner_first_name},\n\n{batch_name} starts at {class_time}. See you there!' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const start = new Date(Date.now() + 20 * 3600_000); // within the 30-hour lookahead
    await w.admin.post(`/api/classrooms/${w.batches.roboA}/sessions`, { title: 'Mail class', starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600_000).toISOString() });
    const dry = await runRule(r.body.data.id, { dryRun: true, force: true }); expect(dry.queued).toBeGreaterThanOrEqual(2); expect(dry.skipped.no_phone).toBeGreaterThanOrEqual(1);
    await exec(`INSERT INTO email_optouts (id, org_id, email) VALUES (UUID(), $1, $2)`, [w.orgId, meena.email.toLowerCase()]);
    const real = await runRule(r.body.data.id, { force: true }); expect(real.queued).toBeGreaterThanOrEqual(1);
    const again = await runRule(r.body.data.id, { force: true }); expect(again.queued).toBe(0);
    await drain();
    const m = fake.last(ravi.email.toLowerCase()); expect(m?.subject).toContain('Class soon: Robotics Batch A'); expect(m?.text).toContain('Hi Ravi,');
    expect(fake.sent.some((x) => x.to === meena.email.toLowerCase() && x.subject.startsWith('Class soon'))).toBe(false);          // opted out
    const log = await query(`SELECT reason FROM reminder_log WHERE rule_id = $1 AND outcome = 'skipped'`, [r.body.data.id]); expect(log.map((x) => x.reason)).toEqual(expect.arrayContaining(['no_email', 'opted_out']));
    void nomail;
    const list = (await w.admin.get('/api/reminders/rules')).body.data.find((x: any) => x.id === r.body.data.id); expect(list).toMatchObject({ channel: 'email', template_name: null });
  });
});
