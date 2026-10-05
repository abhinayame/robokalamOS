import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { exec, query } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { setPaymentProvider, type LinkInput, type LinkResult, type PaymentProvider } from '../src/modules/fees/razorpay.js';
import { discountedParts } from '../src/modules/fees/money.js';

const WH = 'test-rzp-webhook-secret';
const sign = (raw: string, secret = WH) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const hook = (body: object, opts: { secret?: string; eventId?: string } = {}) => {
  const raw = JSON.stringify(body);
  return request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sign(raw, opts.secret)).set('X-Razorpay-Event-Id', opts.eventId ?? `evt_${uniq()}`).send(raw);
};

class FakeRazorpay implements PaymentProvider {
  links: LinkInput[] = []; n = 0; fail = false;
  async createLink(i: LinkInput): Promise<LinkResult> { this.links.push(i); if (this.fail) return { ok: false, retriable: true, code: 'HTTP_500', message: 'boom' }; return { ok: true, id: `plink_${++this.n}${uniq()}`, shortUrl: `https://rzp.io/i/test${this.n}` }; }
  async cancelLink() { /* nothing to cancel in the fake */ }
}
const fake = new FakeRazorpay();

let w: World, other: World;
let ravi: any, meena: any, solo: any;
let teacher: ReturnType<typeof client>, rv: ReturnType<typeof client>, mn: ReturnType<typeof client>, parent: ReturnType<typeof client>, acct: ReturnType<typeof client>, branchAdmin: ReturnType<typeof client>;
let planId = '';
const D = (n: number) => { const d = new Date(Date.now() + n * 86_400_000); return d.toISOString().slice(0, 10); };
const money = (v: unknown) => Number(v);

beforeAll(async () => {
  setPaymentProvider(fake);
  w = await buildWorld(); other = await buildWorld();
  ravi = await newLearner(w, { full_name: 'Ravi Fee', email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Ravi Parent', mobile: '9860000001', email: `rp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA, w.batches.pyB] });
  meena = await newLearner(w, { full_name: 'Meena Fee', email: `meena-${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
  solo = await newLearner(w, { full_name: 'Solo Fee', batch_ids: [w.batches.pyB] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD });
  await w.admin.post(`/api/learners/${meena.id}/login`, { password: PASSWORD });
  teacher = client(await login(w.teachers.t1.email)); rv = client(await login(ravi.email)); mn = client(await login(meena.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id;
  parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
  const au = `acct-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Accountant A', email: au, password: PASSWORD, roles: [{ role: 'accountant' }] });
  acct = client(await login(au));
  const bu = `bra-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Branch Admin', email: bu, password: PASSWORD, roles: [{ role: 'branch_admin', branch_id: w.branchB }] });
  branchAdmin = client(await login(bu));
});

describe('money maths', () => {
  it('splits a discount so the pieces add up exactly', () => {
    expect(discountedParts([400000, 300000, 300000], 100000)).toEqual([360000, 270000, 270000]);
    const odd = discountedParts([333333, 333333, 333334], 1);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(1_000_000 - 1);
    expect(() => discountedParts([100], 100)).toThrow();
  });
});

describe('fee plans', () => {
  it('creates a plan whose total is the sum of its installments, and rejects duplicates and bad input', async () => {
    const r = await w.admin.post('/api/fees/plans', { name: 'Robotics Term', description: 'Three instalments', items: [{ label: 'Admission', amount: 4000, due_days: 0 }, { label: 'Term 2', amount: 3000, due_days: 30 }, { label: 'Term 3', amount: 3000, due_days: 60 }] });
    expect(r.status).toBe(201); planId = r.body.data.id;
    const list = await w.admin.get('/api/fees/plans');
    const p = list.body.data.find((x: any) => x.id === planId);
    expect(money(p.total_amount)).toBe(10000); expect(p.items).toHaveLength(3);
    expect((await w.admin.post('/api/fees/plans', { name: 'Robotics Term', items: [{ label: 'x', amount: 1, due_days: 0 }] })).status).toBe(409);
    expect((await w.admin.post('/api/fees/plans', { name: 'Empty', items: [] })).status).toBe(400);
    expect((await w.admin.post('/api/fees/plans', { name: 'Neg', items: [{ label: 'x', amount: -5, due_days: 0 }] })).status).toBe(400);
    expect((await w.admin.post('/api/fees/plans', { name: 'Paise', items: [{ label: 'x', amount: 10.005, due_days: 0 }] })).status).toBe(400);
  });
  it('is invisible to other organizations and to roles without fee permissions', async () => {
    expect((await other.admin.get('/api/fees/plans')).body.data.some((x: any) => x.id === planId)).toBe(false);
    expect((await teacher.get('/api/fees/plans')).status).toBe(403);
    expect((await rv.get('/api/fees/plans')).status).toBe(403);
    expect((await teacher.post('/api/fees/plans', { name: 'T', items: [{ label: 'x', amount: 1, due_days: 0 }] })).status).toBe(403);
    expect((await acct.get('/api/fees/plans')).status).toBe(200);
  });
});

describe('assigning fees to many learners', () => {
  it('previews first, needs confirmation, and counts a learner in two selected batches once', async () => {
    const selector = { batch_ids: [w.batches.roboA, w.batches.pyB] };
    const dry = await w.admin.post('/api/fees/assign', { plan_id: planId, selector, start_date: D(-45), dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dry_run: true, eligible: 3, to_create: 3, created: 0, installments_each: 3 });
    expect(money(dry.body.data.net_each)).toBe(10000);
    const noConfirm = await w.admin.post('/api/fees/assign', { plan_id: planId, selector, start_date: D(-45) });
    expect(noConfirm.status).toBe(400); expect(noConfirm.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await query(`SELECT COUNT(*) AS n FROM learner_fees WHERE org_id = $1`, [w.orgId]))[0].n).toBe(0);

    const real = await w.admin.post('/api/fees/assign', { plan_id: planId, selector, start_date: D(-45), discount: { type: 'percent', value: 10 }, confirm: true });
    expect(real.status).toBe(201);
    expect(real.body.data).toMatchObject({ created: 3, to_create: 3 }); expect(money(real.body.data.net_each)).toBe(9000);
    const fees = await query(`SELECT learner_id, COUNT(*) AS n FROM learner_fees WHERE org_id = $1 GROUP BY learner_id`, [w.orgId]);
    expect(fees).toHaveLength(3); expect(fees.every((f) => Number(f.n) === 1)).toBe(true);
    const sum = await query(`SELECT SUM(amount) AS s FROM fee_installments WHERE learner_id = $1`, [ravi.id]);
    expect(money(sum[0].s)).toBe(9000);
  });
  it('assigning again changes nothing (one active fee per learner per plan)', async () => {
    const again = await w.admin.post('/api/fees/assign', { plan_id: planId, selector: { batch_ids: [w.batches.roboA] }, start_date: D(-45), confirm: true });
    expect(again.status).toBe(201); expect(again.body.data).toMatchObject({ created: 0, already_assigned: 2, to_create: 0 });
    expect((await query(`SELECT COUNT(*) AS n FROM learner_fees WHERE org_id = $1`, [w.orgId]))[0].n).toBe(3);
  });
  it('rejects a discount that would zero an installment, and respects branch scope', async () => {
    const r = await w.admin.post('/api/fees/assign', { plan_id: planId, selector: { batch_ids: [w.batches.roboB] }, start_date: D(0), discount: { type: 'amount', value: 10000 }, dry_run: true });
    expect(r.status).toBe(400);
    // a Bengaluru branch admin only reaches Bengaluru learners
    const wide = await branchAdmin.post('/api/fees/assign', { plan_id: planId, selector: { all_learners: true }, start_date: D(0), dry_run: true });
    expect(wide.status).toBe(403);   // branch admins may read and record fees, not assign them
  });
});

describe('ledger and access', () => {
  it('shows the learner their own fees only; parents see their children; others get 404', async () => {
    const own = await rv.get(`/api/fees/learners/${ravi.id}`);
    expect(own.status).toBe(200); expect(money(own.body.data.totals.billed)).toBe(9000);
    expect(own.body.data.fees).toHaveLength(1); expect(own.body.data.fees[0].installments).toHaveLength(3);
    expect((await mn.get(`/api/fees/learners/${ravi.id}`)).status).toBe(404);
    expect((await parent.get(`/api/fees/learners/${ravi.id}`)).status).toBe(200);
    expect((await parent.get(`/api/fees/learners/${meena.id}`)).status).toBe(404);
    expect((await other.admin.get(`/api/fees/learners/${ravi.id}`)).status).toBe(404);
    const me = await rv.get('/api/fees/me'); expect(me.body.data).toHaveLength(1);
    expect((await teacher.get(`/api/fees/learners/${ravi.id}`)).status).toBe(403);
  });
  it('splits billed money into overdue and upcoming by due date', async () => {
    const l = (await w.admin.get(`/api/fees/learners/${ravi.id}`)).body.data;
    // start was 45 days ago: Admission (day 0) and Term 2 (day 30) are overdue, Term 3 (day 60) is not
    expect(money(l.totals.overdue)).toBe(3600 + 2700); expect(money(l.totals.outstanding)).toBe(9000);
    const flags = l.fees[0].installments.map((i: any) => i.overdue);
    expect(flags).toEqual([true, true, false]);
  });
});

describe('recording payments', () => {
  it('allocates oldest-due first, supports partial payments, and issues a numbered receipt', async () => {
    const first = await w.admin.post('/api/fees/payments', { learner_id: ravi.id, amount: 5000, method: 'upi', reference: 'UTR123' });
    expect(first.status).toBe(201);
    expect(first.body.data.payment.receipt_no).toMatch(/-RCT-000001$/);
    expect(first.body.data.allocations.map((a: any) => money(a.amount))).toEqual([3600, 1400]);   // Admission fully, Term 2 partly
    const l = (await w.admin.get(`/api/fees/learners/${ravi.id}`)).body.data;
    const st = l.fees[0].installments.map((i: any) => [i.status, money(i.paid_amount)]);
    expect(st).toEqual([['paid', 3600], ['partial', 1400], ['pending', 0]]);
    expect(money(l.totals.paid)).toBe(5000); expect(money(l.totals.outstanding)).toBe(4000);
    const second = await w.admin.post('/api/fees/payments', { learner_id: ravi.id, amount: 100, method: 'cash' });
    expect(second.body.data.payment.receipt_no).toMatch(/-RCT-000002$/);
  });
  it('a retried request never records twice', async () => {
    const request_id = crypto.randomUUID();
    const a = await w.admin.post('/api/fees/payments', { learner_id: meena.id, amount: 500, method: 'cash', request_id });
    const b = await w.admin.post('/api/fees/payments', { learner_id: meena.id, amount: 500, method: 'cash', request_id });
    expect(a.status).toBe(201); expect(b.status).toBe(200);
    expect(b.body.data.payment.id).toBe(a.body.data.payment.id);
    expect(money((await w.admin.get(`/api/fees/learners/${meena.id}`)).body.data.totals.paid)).toBe(500);
  });
  it('refuses overpayment, future dates, online as a manual method, other orgs, and roles without permission', async () => {
    expect((await w.admin.post('/api/fees/payments', { learner_id: solo.id, amount: 999999, method: 'cash' })).status).toBe(400);
    expect((await w.admin.post('/api/fees/payments', { learner_id: solo.id, amount: 10, method: 'cash', paid_at: new Date(Date.now() + 3 * 86_400_000).toISOString() })).status).toBe(400);
    expect((await w.admin.post('/api/fees/payments', { learner_id: solo.id, amount: 10, method: 'online' })).status).toBe(400);
    expect((await w.admin.post('/api/fees/payments', { learner_id: solo.id, amount: 0, method: 'cash' })).status).toBe(400);
    expect((await other.admin.post('/api/fees/payments', { learner_id: solo.id, amount: 10, method: 'cash' })).status).toBe(404);
    expect((await teacher.post('/api/fees/payments', { learner_id: solo.id, amount: 10, method: 'cash' })).status).toBe(403);
    expect((await rv.post('/api/fees/payments', { learner_id: ravi.id, amount: 10, method: 'cash' })).status).toBe(403);
  });
  it('can pay chosen installments, and a branch admin records only for their own branch', async () => {
    const l = (await w.admin.get(`/api/fees/learners/${solo.id}`)).body.data;
    const last = l.fees[0].installments[2];
    const r = await w.admin.post('/api/fees/payments', { learner_id: solo.id, amount: 100, method: 'cheque', installment_ids: [last.id] });
    expect(r.status).toBe(201); expect(r.body.data.allocations).toHaveLength(1); expect(r.body.data.allocations[0].installment_id).toBe(last.id);
    expect((await branchAdmin.post('/api/fees/payments', { learner_id: solo.id, amount: 100, method: 'cash' })).status).toBe(201);        // solo is in a Bengaluru batch
    expect((await branchAdmin.post('/api/fees/payments', { learner_id: ravi.id, amount: 100, method: 'cash' })).status).toBe(201);          // ravi is also in pyB (Bengaluru)
    expect((await branchAdmin.post('/api/fees/payments', { learner_id: meena.id, amount: 100, method: 'cash' })).status).toBe(404);         // meena is Chennai only
  });
  it('generates a PDF receipt that the learner can download and others cannot', async () => {
    const pays = (await w.admin.get(`/api/fees/payments?learner_id=${ravi.id}`)).body.data;
    const id = pays[pays.length - 1].id;
    const pdf = await w.admin.get(`/api/fees/payments/${id}/receipt.pdf`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toContain('application/pdf'); expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await rv.get(`/api/fees/payments/${id}`)).status).toBe(200);
    expect((await mn.get(`/api/fees/payments/${id}`)).status).toBe(404);
  });
});

describe('refunds, cancellation and adjustments', () => {
  it('takes a refund back from the latest installments first and keeps every total consistent', async () => {
    const pays = (await w.admin.get(`/api/fees/payments?learner_id=${ravi.id}&method=upi`)).body.data;
    const pay = pays[0];
    const before = (await w.admin.get(`/api/fees/learners/${ravi.id}`)).body.data;
    const r = await w.admin.post(`/api/fees/payments/${pay.id}/refund`, { amount: 2000, reason: 'Duplicate enrolment' });
    expect(r.status).toBe(201);
    const after = (await w.admin.get(`/api/fees/learners/${ravi.id}`)).body.data;
    expect(money(after.totals.paid)).toBe(money(before.totals.paid) - 2000);
    const st = after.fees[0].installments.map((i: any) => money(i.paid_amount));
    expect(st[1]).toBe(200);          // Term 2 keeps the two later 100 payments; this payment's 1400 there came off first
    expect(st[0]).toBe(3600 - 600);   // the remaining 600 came off Admission
    const det = (await w.admin.get(`/api/fees/payments/${pay.id}`)).body.data;
    expect(det.payment.status).toBe('partially_refunded'); expect(det.refunds).toHaveLength(1);
    expect((await w.admin.post(`/api/fees/payments/${pay.id}/refund`, { amount: 3500, reason: 'too much' })).status).toBe(400);
    expect((await w.admin.post(`/api/fees/payments/${pay.id}/refund`, { amount: 3000, reason: 'rest' })).status).toBe(201);
    expect((await w.admin.get(`/api/fees/payments/${pay.id}`)).body.data.payment.status).toBe('refunded');
    expect((await branchAdmin.post(`/api/fees/payments/${pay.id}/refund`, { amount: 1, reason: 'x' })).status).toBe(403);
  });
  it('refuses to cancel a fee that has payments, cancels one that has none, and never lets an installment fall below what is paid', async () => {
    const m = (await w.admin.get(`/api/fees/learners/${meena.id}`)).body.data;
    expect((await w.admin.post(`/api/fees/fees/${m.fees[0].id}/cancel`, { reason: 'left' })).status).toBe(409);
    const inst = m.fees[0].installments[0];
    const low = await w.admin.patch(`/api/fees/installments/${inst.id}`, { amount: 100, reason: 'waiver' });
    expect(low.status).toBe(400);
    const waive = await w.admin.patch(`/api/fees/installments/${inst.id}`, { amount: 600, reason: 'Sibling concession' });
    expect(waive.status).toBe(200);
    const fresh = await newLearner(w, { full_name: 'Fresh Fee', batch_ids: [w.batches.roboB] });
    await w.admin.post('/api/fees/assign', { plan_id: planId, selector: { learner_ids: [fresh.id] }, start_date: D(0), confirm: true });
    const f = (await w.admin.get(`/api/fees/learners/${fresh.id}`)).body.data.fees[0];
    expect((await w.admin.post(`/api/fees/fees/${f.id}/cancel`, { reason: 'Joined elsewhere' })).status).toBe(200);
    const after = (await w.admin.get(`/api/fees/learners/${fresh.id}`)).body.data;
    expect(money(after.totals.billed)).toBe(0);
  });
  it('adds a one-off charge', async () => {
    const r = await w.admin.post(`/api/fees/learners/${solo.id}/fees`, { title: 'Exam fee', amount: 250, due_date: D(-1) });
    expect(r.status).toBe(201);
    const l = (await w.admin.get(`/api/fees/learners/${solo.id}`)).body.data;
    expect(l.fees.some((f: any) => f.title === 'Exam fee' && f.installments[0].overdue)).toBe(true);
  });
});

describe('dues, summary and reports', () => {
  it('lists dues server-side with filters and pagination, scoped to what the caller may see', async () => {
    const all = await w.admin.get('/api/fees/dues?status=all&page_size=2&page=1');
    expect(all.status).toBe(200); expect(all.body.data.length).toBeLessThanOrEqual(2); expect(all.body.meta.total).toBeGreaterThan(2);
    const od = await w.admin.get('/api/fees/dues?status=overdue&page_size=100');
    expect(od.body.data.every((d: any) => d.days_overdue > 0)).toBe(true);
    const up = await w.admin.get('/api/fees/dues?status=upcoming&page_size=100');
    expect(up.body.data.every((d: any) => d.days_overdue <= 0)).toBe(true);
    const byName = await w.admin.get('/api/fees/dues?status=all&search=Meena');
    expect(byName.body.data.every((d: any) => d.full_name === 'Meena Fee')).toBe(true);
    const bx = await branchAdmin.get('/api/fees/dues?status=all&page_size=100');     // Bengaluru: ravi + solo, never meena (Chennai only)
    expect(bx.body.data.some((d: any) => d.full_name === 'Meena Fee')).toBe(false);
    expect(bx.body.data.some((d: any) => d.full_name === 'Solo Fee')).toBe(true);
    expect((await teacher.get('/api/fees/dues')).status).toBe(403);
    expect((await w.admin.get('/api/fees/dues?status=bogus')).status).toBe(400);
  });
  it('summarises billed, collected and overdue consistently with the ledgers', async () => {
    const s = (await w.admin.get('/api/fees/summary')).body.data;
    const ledgers = await Promise.all([ravi, meena, solo].map(async (l) => (await w.admin.get(`/api/fees/learners/${l.id}`)).body.data.totals));
    expect(money(s.billed)).toBeCloseTo(ledgers.reduce((a, t) => a + money(t.billed), 0) + 0, 2);
    expect(money(s.outstanding)).toBeCloseTo(money(s.billed) - money(s.collected), 2);
    expect(s.collected_this_month).toBeDefined();
  });
  it('exposes fee reports with the same permission as the data', async () => {
    const list = await w.admin.get('/api/reports'); expect(list.body.data.map((r: any) => r.id)).toEqual(expect.arrayContaining(['fees', 'collections']));
    const dues = await w.admin.get('/api/reports/fees'); expect(dues.status).toBe(200); expect(dues.body.data.rows.length).toBeGreaterThan(0);
    expect(dues.body.data.rows[0]).toHaveProperty('balance');
    const col = await w.admin.get('/api/reports/collections'); expect(col.body.data.rows.some((r: any) => /RCT/.test(r.receipt))).toBe(true);
    expect((await teacher.get('/api/reports/fees')).status).toBe(404);
  });
  it('shows fee numbers on the admin dashboard', async () => {
    const d = (await w.admin.get('/api/dashboard')).body.data;
    expect(d.kpis.fees).toMatchObject({ outstanding: expect.any(Number), overdue: expect.any(Number) });
    expect((await teacher.get('/api/dashboard')).body.data.kpis?.fees).toBeUndefined();
  });
});

describe('online payments through Razorpay payment links', () => {
  let linkId = ''; let providerLinkId = ''; let amount = 0;
  it('creates a link for what is due, reuses it, and lets a learner or parent do it for themselves only', async () => {
    const r = await rv.post('/api/fees/pay-links', { learner_id: ravi.id });
    expect(r.status).toBe(201); expect(r.body.data.short_url).toMatch(/^https:\/\/rzp\.io\//);
    linkId = r.body.data.id; amount = money(r.body.data.amount);
    expect(fake.links.at(-1)!.amountPaise).toBe(Math.round(amount * 100)); expect(fake.links.at(-1)!.customer.name).toBe('Ravi Fee');
    const again = await parent.post('/api/fees/pay-links', { learner_id: ravi.id });
    expect(again.status).toBe(200); expect(again.body.data.id).toBe(linkId); expect(again.body.data.reused).toBe(true);
    expect((await mn.post('/api/fees/pay-links', { learner_id: ravi.id })).status).toBe(404);
    expect((await teacher.post('/api/fees/pay-links', { learner_id: ravi.id })).status).toBe(403);
    providerLinkId = (await query(`SELECT provider_link_id FROM payment_links WHERE id = $1`, [linkId]))[0].provider_link_id;
  });
  it('turns provider errors into a clear 502 and keeps nothing', async () => {
    fake.fail = true;
    const before = (await query(`SELECT COUNT(*) AS n FROM payment_links WHERE org_id = $1`, [w.orgId]))[0].n;
    const r = await mn.post('/api/fees/pay-links', { learner_id: meena.id });
    fake.fail = false;
    expect(r.status).toBe(502); expect(r.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect((await query(`SELECT COUNT(*) AS n FROM payment_links WHERE org_id = $1`, [w.orgId]))[0].n).toBe(before);
  });
  const paid = (pid: string, link = providerLinkId, amt = Math.round(amount * 100)) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: link, amount_paid: amt, status: 'paid' } }, payment: { entity: { id: pid, amount: amt, method: 'upi' } } } });
  it('ignores webhooks that are unsigned or signed with the wrong secret', async () => {
    expect((await request(app).post('/api/webhooks/razorpay').send(paid('pay_x'))).status).toBe(404);
    expect((await hook(paid('pay_x'), { secret: 'wrong-secret-wrong' })).status).toBe(404);
    expect((await query(`SELECT COUNT(*) AS n FROM payments WHERE provider = 'razorpay'`))[0].n).toBe(0);
  });
  it('records the payment once, however many times the event arrives', async () => {
    const before = money((await w.admin.get(`/api/fees/learners/${ravi.id}`)).body.data.totals.paid);
    const pid = `pay_${uniq()}`;
    const a = await hook(paid(pid), { eventId: 'evt_one' });
    expect(a.status).toBe(200); expect(a.body.data.outcome).toBe('applied');
    const same = await hook(paid(pid), { eventId: 'evt_one' });                   // exact retry
    const diff = await hook(paid(pid), { eventId: 'evt_two' });                   // same payment, new event id
    expect(same.body.data.outcome).toBe('duplicate'); expect(diff.body.data.outcome).toBe('duplicate');
    const l = (await w.admin.get(`/api/fees/learners/${ravi.id}`)).body.data;
    expect(money(l.totals.paid)).toBeCloseTo(before + amount, 2); expect(money(l.totals.outstanding)).toBeCloseTo(0, 2);
    expect((await query(`SELECT COUNT(*) AS n FROM payments WHERE provider_payment_id = $1`, [pid]))[0].n).toBe(1);
    expect((await query(`SELECT status FROM payment_links WHERE id = $1`, [linkId]))[0].status).toBe('paid');
    expect(l.payments.some((p: any) => p.provider === 'razorpay' && p.method === 'upi')).toBe(true);
  });
  it('keeps money that arrives after the dues were cleared as credit instead of losing it, and tolerates unknown links', async () => {
    const link2 = await w.admin.post('/api/fees/pay-links', { learner_id: solo.id });
    expect(link2.status).toBe(201);
    const pl = (await query(`SELECT provider_link_id FROM payment_links WHERE id = $1`, [link2.body.data.id]))[0].provider_link_id;
    await w.admin.post('/api/fees/payments', { learner_id: solo.id, amount: money(link2.body.data.amount), method: 'cash' });   // cleared at the counter first
    const r = await hook(paid(`pay_${uniq()}`, pl, Math.round(money(link2.body.data.amount) * 100)));
    expect(r.body.data.outcome).toBe('applied');
    const l = (await w.admin.get(`/api/fees/learners/${solo.id}`)).body.data;
    expect(money(l.totals.credit)).toBeCloseTo(money(link2.body.data.amount), 2);
    expect((await hook(paid(`pay_${uniq()}`, 'plink_unknown'))).body.data.outcome).toBe('unmatched');
    expect((await hook({ event: 'something.else' })).body.data.outcome).toBe('ignored');
  });
  it('marks expired links', async () => {
    const link3 = await mn.post('/api/fees/pay-links', { learner_id: meena.id });
    const pl = (await query(`SELECT provider_link_id FROM payment_links WHERE id = $1`, [link3.body.data.id]))[0].provider_link_id;
    await hook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: pl } } } });
    expect((await query(`SELECT status FROM payment_links WHERE id = $1`, [link3.body.data.id]))[0].status).toBe('expired');
  });
  it('never returns provider secrets', async () => {
    const s = await w.admin.get('/api/fees/status');
    expect(s.body.data.online_payments).toBe(true);
    expect(JSON.stringify(s.body)).not.toContain('test-rzp-secret-0001'); expect(JSON.stringify(s.body)).not.toContain('rzp_test_keyid0001');
  });
});

describe('audit', () => {
  it('records plans, assignments, payments, refunds and links', async () => {
    const a = (await query(`SELECT DISTINCT action FROM audit_logs WHERE org_id = $1 AND (action LIKE 'fee%' OR action LIKE 'payment.%')`, [w.orgId])).map((r) => r.action);
    expect(a).toEqual(expect.arrayContaining(['fee_plan.created', 'fee.assigned', 'payment.recorded', 'payment.refunded', 'payment.link_created', 'fee.cancelled', 'fee.installment_adjusted']));
  });
});

describe('money integrity', () => {
  it('every installment and payment adds up after all of the above, and the system status notices when one does not', async () => {
    const sys = client(w.superToken, w.orgId);
    const ok = (await sys.get('/api/system/status')).body.data;
    expect(ok.integrity.find((c: any) => c.id === 'fee_allocation_mismatch')).toMatchObject({ count: 0, ok: true });
    expect(ok.integrity.find((c: any) => c.id === 'payment_unaccounted')).toMatchObject({ count: 0, ok: true });
    expect(ok.integrity_ok).toBe(true); expect(ok.fees.online_payments).toBe(true);
    const i = (await query(`SELECT id, paid_amount FROM fee_installments WHERE org_id = $1 AND paid_amount > 0 LIMIT 1`, [w.orgId]))[0];
    await exec(`UPDATE fee_installments SET paid_amount = paid_amount - 1 WHERE id = $1`, [i.id]);       // simulate corruption
    const bad = (await sys.get('/api/system/status')).body.data;
    expect(bad.integrity.find((c: any) => c.id === 'fee_allocation_mismatch').count).toBe(1); expect(bad.integrity_ok).toBe(false);
    await exec(`UPDATE fee_installments SET paid_amount = $2 WHERE id = $1`, [i.id, i.paid_amount]);
    expect((await sys.get('/api/system/status')).body.data.integrity_ok).toBe(true);
  });
});
