import { beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, client, login, newLearner, uniq, type World } from './helpers.js';
import { resolveRange } from '../src/modules/dashboard/period.js';

let w: World; let teacher: ReturnType<typeof client>;
let asha: any, bala: any;
const D = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  w = await buildWorld();
  asha = await newLearner(w, { full_name: 'Asha Period', email: `asha-${uniq()}@kids.test`, batch_ids: [w.batches.roboA] });
  bala = await newLearner(w, { full_name: 'Bala Period', email: `bala-${uniq()}@kids.test`, batch_ids: [w.batches.pyB] });
  const plan = await w.admin.post('/api/fees/plans', { name: `Term ${uniq()}`, items: [{ label: 'Admission', amount: 4000, due_days: 0 }, { label: 'Term 2', amount: 6000, due_days: 60 }] });
  expect(plan.status).toBe(201);
  const as = await w.admin.post('/api/fees/assign', { plan_id: plan.body.data.id, selector: { learner_ids: [asha.id, bala.id] }, start_date: D(-10), confirm: true });
  expect(as.status).toBe(201);
  for (const [l, amount, paid_at] of [[asha, 1500, undefined], [asha, 500, undefined], [bala, 1000, undefined], [bala, 700, new Date(Date.now() - 800 * 86_400_000).toISOString()]] as const) {
    const r = await w.admin.post('/api/fees/payments', { learner_id: l.id, amount, method: 'cash', ...(paid_at ? { paid_at } : {}) });
    expect(r.status).toBe(201);
  }
  teacher = client(await login(w.teachers.t1.email));
});

describe('reporting periods', () => {
  it('turns a preset into calendar bounds that end today, in the school time zone', () => {
    const now = new Date('2026-11-04T06:00:00Z');   // a Wednesday
    const r = (period: any) => resolveRange({ period }, 'Asia/Kolkata', now)!;
    expect(r('week')).toMatchObject({ start: '2026-11-02', end: '2026-11-04' });
    expect(r('month').start).toBe('2026-11-01');
    expect(r('quarter').start).toBe('2026-10-01');
    expect(r('half').start).toBe('2026-07-01');
    expect(r('year').start).toBe('2026-01-01');
    expect(r('all')).toMatchObject({ start: null, fromTs: null });
    expect(r('month').fromTs).toBe('2026-10-31 18:30:00.000');   // midnight in India, in UTC
    expect(resolveRange({}, 'Asia/Kolkata', now)).toBeNull();
    expect(() => resolveRange({ period: 'custom', from: '2026-02-01' }, 'Asia/Kolkata', now)).toThrow();
    expect(() => resolveRange({ from: '2026-03-01', to: '2026-02-01' }, 'Asia/Kolkata', now)).toThrow();
    expect(resolveRange({ from: '2026-02-01', to: '2026-02-28' }, 'Asia/Kolkata', now)).toMatchObject({ key: 'custom', start: '2026-02-01', end: '2026-02-28' });
  });

  it('keeps the unfiltered dashboard exactly as before when no period is asked for', async () => {
    const d = (await w.admin.get('/api/dashboard')).body.data;
    expect(d.period).toBeUndefined();
    expect(d.kpis.fees.collected).toBeUndefined();
    expect(d.kpis.fees.collected_this_month).toBe(3000);
  });

  it('filters activity numbers by the chosen period and says which period it used', async () => {
    const m = (await w.admin.get('/api/dashboard?period=month')).body.data;
    expect(m.period).toMatchObject({ key: 'month', label: 'This month' });
    expect(m.kpis.fees).toMatchObject({ collected: 3000, payments: 3, payers: 2 });
    expect(m.kpis.new_learners).toBeGreaterThanOrEqual(2);
    const all = (await w.admin.get('/api/dashboard?period=all')).body.data;
    expect(all.kpis.fees).toMatchObject({ collected: 3700, payments: 4, payers: 2 });
    expect(all.kpis.fees.outstanding).toBe(m.kpis.fees.outstanding);   // balances do not depend on the period
    expect((await w.admin.get('/api/dashboard?period=decade')).status).toBe(400);
    expect((await w.admin.get('/api/dashboard?period=custom&from=2026-01-01')).status).toBe(400);
  });
});

describe('dashboard details', () => {
  it('lists the payments behind "collected", and the people who paid add up to the number', async () => {
    const r = await w.admin.get('/api/dashboard/details/collected?period=month');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.rows).toHaveLength(3);
    expect(d.summary).toEqual(expect.arrayContaining([{ label: 'Collected', value: 3000, kind: 'money' }, { label: 'People who paid', value: 2 }]));
    expect(d.rows.reduce((s: number, x: any) => s + x.amount, 0)).toBe(3000);
    expect(new Set(d.rows.map((x: any) => x.full_name))).toEqual(new Set(['Asha Period', 'Bala Period']));
    expect(d.rows[0].link).toMatch(/^\/learners\//);
    expect(d.columns.map((c: any) => c.key)).toContain('receipt_no');
    const all = (await w.admin.get('/api/dashboard/details/collected?period=all')).body.data;
    expect(all.rows).toHaveLength(4);
  });

  it('shows who still owes, matching the outstanding number', async () => {
    const k = (await w.admin.get('/api/dashboard?period=month')).body.data.kpis.fees;
    const d = (await w.admin.get('/api/dashboard/details/outstanding')).body.data;
    expect(d.period).toBeNull();
    expect(d.summary[0].value).toBe(k.outstanding);
    expect(d.rows.find((x: any) => x.full_name === 'Asha Period').due).toBe(10000 - 2000);
  });

  it('lists new learners and batches with links into the app', async () => {
    const nl = (await w.admin.get('/api/dashboard/details/new_learners?period=week')).body.data;
    expect(nl.rows.map((x: any) => x.full_name)).toEqual(expect.arrayContaining(['Asha Period', 'Bala Period']));
    const b = (await w.admin.get('/api/dashboard/details/batches')).body.data;
    expect(b.rows.length).toBeGreaterThan(0); expect(b.rows[0].link).toMatch(/^\/batches\//);
  });

  it('applies the same permissions as the numbers themselves', async () => {
    expect((await teacher.get('/api/dashboard/details/collected')).status).toBe(403);
    expect((await teacher.get('/api/dashboard/details/outstanding')).status).toBe(403);
    expect((await w.admin.get('/api/dashboard/details/not-a-metric')).status).toBe(404);
    const att = await teacher.get('/api/dashboard/details/attendance?period=month');
    expect(att.status).toBe(200);
  });
});
