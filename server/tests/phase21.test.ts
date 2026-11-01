import { beforeAll, describe, expect, it } from 'vitest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { amountInWords } from '../src/modules/fees/receipt.js';
import { splitProportional } from '../src/modules/fees/adjust.js';
import { buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

let w: World, other: World; let acct: ReturnType<typeof client>, t1: ReturnType<typeof client>, parent: ReturnType<typeof client>; let ravi: any; let plan = '';
const bin = (res: any, cb: any) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); };

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  ravi = await newLearner(w, { full_name: 'Ravi Kumar', email: `ravi-${uniq()}@kids.test`, parent: { full_name: 'Ravi Parent', mobile: '9870000051', email: `rp-${uniq()}@fam.test` }, batch_ids: [w.batches.roboA] });
  await w.admin.post(`/api/batches/${w.batches.roboA}/teachers`, { teacher_id: w.teachers.t1.id, role: 'lead' });
  const mail = `acct-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Accounts Sam', email: mail, password: PASSWORD, roles: [{ role: 'accountant' }] }); acct = client(await login(mail));
  t1 = client(await login(w.teachers.t1.email));
  const parentId = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data.parents[0].id; parent = client(await login((await w.admin.post(`/api/parents/${parentId}/login`, { password: PASSWORD })).body.data.email));
  plan = (await w.admin.post('/api/fees/plans', { name: 'Robotics 6000', items: [{ label: 'Admission', amount: 2000, due_days: 0 }, { label: 'Term 2', amount: 2000, due_days: 30 }, { label: 'Term 3', amount: 2000, due_days: 60 }] })).body.data.id;
});
const today = () => new Date().toISOString().slice(0, 10);
const give = async (learner: any, batch: string | null = null) => { await w.admin.post('/api/fees/assign', { plan_id: plan, selector: { learner_ids: [learner.id] }, batch_id: batch, start_date: today(), confirm: true }); return (await w.admin.get(`/api/fees/learners/${learner.id}`)).body.data.fees.find((f: any) => f.status === 'active' && f.title === 'Robotics 6000'); };
const fresh = async (name: string) => newLearner(w, { full_name: name, email: `${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
const pay = async (learner: any, amount: number, extra: object = {}) => (await acct.post('/api/fees/payments', { learner_id: learner.id, amount, method: 'cash', ...extra })).body.data;
const net = async (feeId: string, learner: any) => (await w.admin.get(`/api/fees/learners/${learner.id}`)).body.data.fees.find((f: any) => f.id === feeId);

describe('maths and words', () => {
  it('splits money exactly and writes amounts in Indian words', () => {
    expect(splitProportional(5400, [2000, 2000, 2000])).toEqual([1800, 1800, 1800]); expect(splitProportional(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100); expect(splitProportional(7, [0, 0])).toEqual([4, 3]);
    expect(amountInWords(2000000)).toBe('Rupees Twenty thousand only'); expect(amountInWords(12345650)).toBe('Rupees One lakh twenty-three thousand four hundred fifty-six and fifty paise only'); expect(amountInWords(10000000 * 100 + 100)).toContain('crore');
  });
});

describe('discounts on a learner fee', () => {
  it('gives a percentage or amount, spreads it over the unpaid instalments, and keeps what was paid', async () => {
    const k = await fresh('Disc One'); const fee = await give(k);
    expect((await t1.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 10, reason: 'Sibling' })).status).toBe(403);
    expect((await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 10 })).status).toBe(400);                 // a reason is required
    const r = await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 10, reason: 'Sibling discount' }); expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.data).toMatchObject({ gross: '6000.00', discount: '600.00', net: '5400.00', percent: 10 });
    let f = await net(fee.id, k); expect(f.installments.map((i: any) => i.amount)).toEqual([1800, 1800, 1800]); expect(f).toMatchObject({ discount_amount: 600, discount_type: 'percent', discount_reason: 'Sibling discount' });
    await pay(k, 1800);                                                                                                               // Admission paid in full
    expect((await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 20, reason: 'Scholarship' })).status).toBe(200);
    f = await net(fee.id, k); expect(f.installments.map((i: any) => i.amount)).toEqual([1800, 1500, 1500]); expect(f.installments[0].status).toBe('paid'); expect(f.net_amount).toBe(4800);   // paid part stays, the rest shrinks
    expect((await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'amount', value: 4500, reason: 'Too much' })).status).toBe(409);   // would be below what is already paid
    const h = (await acct.get(`/api/fees/fees/${fee.id}/history`)).body.data; expect(h.length).toBe(2); expect(h[0]).toMatchObject({ after_discount: 1200, reason: 'Scholarship', by_name: 'Accounts Sam' });
    expect((await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'none', reason: 'Withdrawn' })).body.data).toMatchObject({ discount: '0.00', net: '6000.00' });
    f = await net(fee.id, k); expect(f.installments.map((i: any) => i.amount)).toEqual([2000, 2000, 2000]);
    expect((await other.admin.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 5, reason: 'x y' })).status).toBe(404);
  });
  it('lets an owner cap what the accounts team may give', async () => {
    const k = await fresh('Disc Two'); const fee = await give(k);
    expect((await acct.put('/api/fees/discount-limit', { percent: 20 })).status).toBe(403); expect((await w.admin.put('/api/fees/discount-limit', { percent: 20 })).status).toBe(200);
    const over = await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 25, reason: 'Big ask' }); expect(over.status).toBe(403); expect(over.body.error.message).toContain('20%');
    expect((await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 15, reason: 'Fine' })).status).toBe(200);
    expect((await w.admin.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 40, reason: 'Owner approved' })).status).toBe(200);
    expect((await w.admin.get('/api/fees/receipt-settings')).body.data.discount_limit_percent).toBe(20);
    await w.admin.put('/api/fees/discount-limit', { percent: null });
  });
  it('waives a fee completely and brings it back', async () => {
    const k = await fresh('Disc Three'); const fee = await give(k);
    expect((await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 100, reason: 'Full scholarship' })).body.data.net).toBe('0.00');
    let f = await net(fee.id, k); expect(f.installments.every((i: any) => i.status === 'cancelled')).toBe(true); expect((await w.admin.get(`/api/fees/learners/${k.id}`)).body.data.totals.outstanding).toBe('0.00');
    await acct.post(`/api/fees/fees/${fee.id}/discount`, { type: 'percent', value: 50, reason: 'Scholarship reduced' });
    f = await net(fee.id, k); expect(f.installments.map((i: any) => i.status)).toEqual(['pending', 'pending', 'pending']); expect(f.net_amount).toBe(3000);
  });
  it('keeps named discounts to pick from, and records the reason and level when a plan is given', async () => {
    expect((await t1.post('/api/fees/discount-presets', { name: 'Sibling', kind: 'percent', value: 10 })).status).toBe(403);
    expect((await w.admin.post('/api/fees/discount-presets', { name: 'Sibling', kind: 'percent', value: 150 })).status).toBe(400);
    const id = (await w.admin.post('/api/fees/discount-presets', { name: 'Sibling', kind: 'percent', value: 10 })).body.data.id; expect((await w.admin.post('/api/fees/discount-presets', { name: 'Sibling', kind: 'amount', value: 500 })).status).toBe(409);
    expect((await acct.get('/api/fees/discount-presets')).body.data).toMatchObject([{ name: 'Sibling', kind: 'percent', value: 10 }]);
    expect((await w.admin.put(`/api/fees/discount-presets/${id}`, { name: 'Sibling', kind: 'percent', value: 12, active: false })).status).toBe(200);
    const k = await fresh('Disc Four'); const r = await acct.post('/api/fees/assign', { plan_id: plan, selector: { learner_ids: [k.id] }, start_date: today(), discount: { type: 'percent', value: 10, reason: 'Early bird', preset_id: id }, level_label: 'Level 3', confirm: true }); expect(r.status).toBe(201);
    const f = (await w.admin.get(`/api/fees/learners/${k.id}`)).body.data.fees[0]; expect(f).toMatchObject({ discount_amount: 600, discount_type: 'percent', discount_reason: 'Early bird', level_label: 'Level 3' });
    expect((await w.admin.del(`/api/fees/discount-presets/${id}`)).status).toBe(200);
  });
});

describe('correcting a payment', () => {
  it('changes a wrong date, and the dashboard and the receipt follow', async () => {
    const k = await fresh('Pay One'); await give(k);
    const lastMonth = new Date(); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 2);
    const before = Number((await w.admin.get('/api/fees/summary')).body.data.collected_this_month);
    const p = await pay(k, 2000, { paid_at: lastMonth.toISOString() }); const id = p.payment.id;
    expect(Number((await w.admin.get('/api/fees/summary')).body.data.collected_this_month)).toBe(before);                          // paid two months ago: not this month
    expect((await t1.patch(`/api/fees/payments/${id}`, { paid_at: new Date().toISOString(), reason: 'wrong date' })).status).toBe(403);
    expect((await acct.patch(`/api/fees/payments/${id}`, { paid_at: new Date().toISOString() })).status).toBe(400);                  // needs a reason
    expect((await acct.patch(`/api/fees/payments/${id}`, { paid_at: new Date(Date.now() + 86400_000 * 3).toISOString(), reason: 'future?' })).status).toBe(400);
    const r = await acct.patch(`/api/fees/payments/${id}`, { paid_at: new Date().toISOString(), method: 'upi', reference: 'UPI-1', reason: 'Date was entered wrongly' }); expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.data).toMatchObject({ revision: 1, receipt_no: p.payment.receipt_no });
    expect(Number((await w.admin.get('/api/fees/summary')).body.data.collected_this_month)).toBe(before + 2000);                     // the main dashboard moved with it
    const d = (await acct.get(`/api/fees/payments/${id}`)).body.data; expect(d.payment).toMatchObject({ method: 'upi', reference: 'UPI-1', revision: 1 }); expect(d.revisions[0]).toMatchObject({ revision: 1, kind: 'edit', reason: 'Date was entered wrongly', changed_by_name: 'Accounts Sam' }); expect(JSON.parse(JSON.stringify(d.revisions[0].before_json)).method).toBe('cash');
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'payment.edited' AND entity_id = $1`, [id])).toBeTruthy();
    for (const t of ['classic', 'modern', 'slip']) { const pdf = await w.admin.get(`/api/fees/payments/${id}/receipt.pdf?template=${t}`).buffer(true).parse(bin); expect(pdf.status, t).toBe(200); expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-'); }
  });
  it('changes the amount and re-spreads it, or refuses when it cannot', async () => {
    const k = await fresh('Pay Two'); const fee = await give(k); const p = await pay(k, 2000); const id = p.payment.id;
    const r = await acct.patch(`/api/fees/payments/${id}`, { amount: 3000, reason: 'Counted wrongly' }); expect(r.status, JSON.stringify(r.body)).toBe(200);
    const f = await net(fee.id, k); expect(f.installments.map((i: any) => i.paid_amount)).toEqual([2000, 1000, 0]); expect(Number((await w.admin.get(`/api/fees/learners/${k.id}`)).body.data.totals.paid)).toBe(3000);
    await acct.patch(`/api/fees/payments/${id}`, { amount: 1500, reason: 'Less after all' }); expect((await net(fee.id, k)).installments.map((i: any) => i.paid_amount)).toEqual([1500, 0, 0]);
    const big = await acct.patch(`/api/fees/payments/${id}`, { amount: 7000, reason: 'Advance' }); expect(big.status).toBe(200); expect((await w.admin.get(`/api/fees/learners/${k.id}`)).body.data.totals).toMatchObject({ paid: '6000.00', credit: '1000.00' });
    await acct.patch(`/api/fees/payments/${id}`, { amount: 2000, reason: 'Back again' });
    expect((await w.admin.post(`/api/fees/payments/${id}/refund`, { amount: 500, reason: 'Kit returned' })).status).toBe(201);
    expect((await acct.patch(`/api/fees/payments/${id}`, { amount: 2500, reason: 'No' })).status).toBe(409);                                        // has a refund
    expect((await acct.patch(`/api/fees/payments/${id}`, { note: 'Handed to the front desk', reason: 'Add a note' })).status).toBe(200);           // but a note is fine
  });
  it('cancels a payment recorded by mistake and reopens what it paid', async () => {
    const k = await fresh('Pay Three'); const fee = await give(k); const p = await pay(k, 2500); const id = p.payment.id;
    const before = Number((await w.admin.get('/api/fees/summary')).body.data.collected_this_month);
    expect((await parent.post(`/api/fees/payments/${id}/void`, { reason: 'x y' })).status).toBe(403); expect((await t1.post(`/api/fees/payments/${id}/void`, { reason: 'x y' })).status).toBe(403);
    expect((await acct.post(`/api/fees/payments/${id}/void`, {})).status).toBe(400);
    const v = await acct.post(`/api/fees/payments/${id}/void`, { reason: 'Recorded twice by mistake' }); expect(v.status, JSON.stringify(v.body)).toBe(200); expect(v.body.data.status).toBe('voided');
    expect((await net(fee.id, k)).installments.map((i: any) => [i.status, i.paid_amount])).toEqual([['pending', 0], ['pending', 0], ['pending', 0]]);
    expect(Number((await w.admin.get('/api/fees/summary')).body.data.collected_this_month)).toBe(before - 2500);
    const led = (await w.admin.get(`/api/fees/learners/${k.id}`)).body.data; expect(led.totals).toMatchObject({ paid: '0.00', outstanding: '6000.00', credit: '0.00' }); expect(led.payments[0]).toMatchObject({ status: 'voided', void_reason: 'Recorded twice by mistake' });
    expect((await acct.patch(`/api/fees/payments/${id}`, { note: 'x', reason: 'again' })).status).toBe(409); expect((await acct.post(`/api/fees/payments/${id}/void`, { reason: 'again again' })).status).toBe(409);
    const sys = (await w.admin.get('/api/system/status')).body.data.integrity.find((c: any) => c.id === 'payment_unaccounted'); expect(sys.ok).toBe(true);
    const pdf = await w.admin.get(`/api/fees/payments/${id}/receipt.pdf`).buffer(true).parse(bin); expect(pdf.status).toBe(200);                       // the receipt is kept, stamped as cancelled
    const again = await pay(k, 2500); expect(again.payment.receipt_no).not.toBe(p.payment.receipt_no);                                                 // and a fresh one can be recorded
  });
});

describe('receipt designs', () => {
  it('saves the school design and previews each look', async () => {
    expect((await t1.put('/api/fees/receipt-settings', { template: 'modern' })).status).toBe(403);
    expect((await w.admin.put('/api/fees/receipt-settings', { template: 'fancy' })).status).toBe(400); expect((await w.admin.put('/api/fees/receipt-settings', { template: 'modern', accent: 'red' })).status).toBe(400);
    const s = await w.admin.put('/api/fees/receipt-settings', { template: 'modern', address: '12 Park Road, Chennai', tax_id: '33ABCDE1234F1Z5', header: 'Robotics for every child', footer: 'Fees once paid are not refundable.', signatory: 'Dr. Rao', signatory_title: 'Director', accent: '#7a1f3d', show_logo: false });
    expect(s.status).toBe(200); expect(s.body.data).toMatchObject({ template: 'modern', tax_id: '33ABCDE1234F1Z5', accent: '#7a1f3d', show_logo: false });
    expect((await acct.get('/api/fees/receipt-settings')).body.data.template).toBe('modern'); expect((await other.admin.get('/api/fees/receipt-settings')).body.data.template).toBe('classic');
    for (const t of ['classic', 'modern', 'slip']) for (const extra of ['', '&revised=true', '&void=true']) { const r = await w.admin.get(`/api/fees/receipt-preview.pdf?template=${t}${extra}`).buffer(true).parse(bin); expect(r.status, t + extra).toBe(200); expect((r.body as Buffer).length).toBeGreaterThan(1500); }
    expect((await w.admin.get('/api/fees/receipt-preview.pdf?template=fancy')).status).toBe(400); expect((await parent.get('/api/fees/receipt-preview.pdf')).status).toBe(403);
  });
});

describe('levels: a learner across years', () => {
  it('shows the journey and moves a learner up a level with fee, discount and a shareable badge', async () => {
    const prog = (await w.admin.get('/api/programs')).body.data[0].id; const mkCourse = async (name: string, level: number) => (await w.admin.post('/api/courses', { program_id: prog, name, code: `L${level}${uniq()}`.slice(0, 18), level_no: level })).body.data.id;
    const c1 = await mkCourse('Robotics Level 1', 1), c2 = await mkCourse('Robotics Level 2', 2);
    expect((await w.admin.get('/api/courses')).body.data.find((c: any) => c.id === c2).level_no).toBe(2);
    const mkBatch = async (name: string, course: string) => (await w.admin.post('/api/batches', { name, program_id: prog, course_id: course, academic_year: '2026-27', status: 'active', capacity: 10 })).body.data.id;
    const b1 = await mkBatch('L1 morning', c1), b2 = await mkBatch('L2 morning', c2);
    const k = await newLearner(w, { full_name: 'Levelup Kid', email: `${uniq()}@kids.test`, batch_ids: [b1] }); await w.admin.post(`/api/learners/${k.id}/login`, { password: PASSWORD });
    const j0 = (await w.admin.get(`/api/levels/learners/${k.id}/journey`)).body.data; expect(j0).toMatchObject({ current_level: 1, levels_finished: 0, months_with_us: 0 }); expect(j0.steps.length).toBe(1);
    const nb = (await w.admin.get(`/api/levels/learners/${k.id}/next-batches`)).body.data; expect(nb.find((b: any) => b.id === b2)).toMatchObject({ suggested: true, level_no: 2 }); expect(nb.find((b: any) => b.id === b1)).toBeUndefined();
    expect((await t1.post(`/api/levels/learners/${k.id}/promote`, { to_batch_id: b2 })).status).toBe(403);
    expect((await acct.post(`/api/levels/learners/${k.id}/promote`, { to_batch_id: b2 })).status).toBe(403);                                           // accounts cannot move people between batches
    expect((await w.admin.post(`/api/levels/learners/${k.id}/promote`, { to_batch_id: b2, discount: { type: 'percent', value: 10 } })).status).toBe(400);   // a discount needs a plan
    const r = await w.admin.post(`/api/levels/learners/${k.id}/promote`, { to_batch_id: b2, plan_id: plan, start_date: today(), discount: { type: 'percent', value: 10, reason: 'Loyal learner' } }); expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ from: { id: b1, level_no: 1 }, to: { id: b2, level_no: 2 }, badge: { name: 'Level 1 complete' } }); expect(r.body.data.badge.learner_badge_id).toBeTruthy(); expect(r.body.data.fee).toMatchObject({ created: 1 });
    const m = await query(`SELECT batch_id, status FROM learner_batch_memberships WHERE learner_id = $1 ORDER BY joined_at`, [k.id]); expect(m.map((x) => x.status).sort()).toEqual(['active', 'completed']);
    const fee = (await w.admin.get(`/api/fees/learners/${k.id}`)).body.data.fees[0]; expect(fee).toMatchObject({ level_label: 'Level 2', discount_amount: 600, discount_reason: 'Loyal learner' });
    const j = (await w.admin.get(`/api/levels/learners/${k.id}/journey`)).body.data; expect(j).toMatchObject({ current_level: 2, levels_finished: 1 }); expect(j.level_badges.map((x: any) => x.name)).toEqual(['Level 1 complete']); expect(j.steps.map((s: any) => s.status)).toEqual(['completed', 'active']); expect(j.fees.discount).toBe('600.00');
    expect(await queryOne(`SELECT 1 FROM notifications WHERE learner_id = $1 AND kind = 'level.promoted'`, [k.id])).toBeTruthy();
    expect((await w.admin.post(`/api/levels/learners/${k.id}/promote`, { to_batch_id: b2 })).status).toBe(409);                                         // already there
    expect((await other.admin.get(`/api/levels/learners/${k.id}/journey`)).status).toBe(404);
  });
});
