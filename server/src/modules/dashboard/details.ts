import { Router, type Request } from 'express';
import { z } from 'zod';
import { Params, query, queryOne } from '../../db/pool.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { batchScope, learnerScope } from '../../lib/scope.js';
import { orgIdOf, requirePerm } from '../../middleware/auth.js';
import { attendancePct } from '../attendance/time.js';
import { orgTimezone, periodQuery, publicRange, resolveRange, within, type Range } from './period.js';

/**
 * Dashboard drill-down: GET /api/dashboard/details/:metric?period=month
 * Lists the records behind one dashboard number (e.g. the payments that make up "collected this month"),
 * using the same filters and the same visibility rules (branch / teacher scope) as the number itself.
 */
export const detailsRouter = Router();
detailsRouter.use(requirePerm('dashboard:view'));

type Kind = 'text' | 'money' | 'number' | 'pct' | 'date' | 'datetime' | 'status';
type Col = { key: string; label: string; kind?: Kind };
type Ctx = { req: Request; orgId: string; r: Range; today: string };
type Out = { rows: any[]; summary: { label: string; value: number | string | null; kind?: Kind }[]; total_rows?: number };
type Def = { title: string; perm?: string; ranged: boolean; columns: Col[]; open?: { label: string; to: string }; run: (c: Ctx) => Promise<Out> };

const LIMIT = 500;
const n = (v: unknown) => Number(v ?? 0);
const money = (v: unknown) => Math.round(n(v) * 100) / 100;
const lscope = (c: Ctx, p: Params) => { const s = learnerScope(c.req.user!, p, 'l'); return s ? `AND ${s}` : ''; };
const bscope = (c: Ctx, p: Params) => { const s = batchScope(c.req.user!, p, 'b'); return s ? `AND ${s}` : ''; };
const learnerLink = (r: any) => ({ ...r, link: `/learners/${r.learner_id}` });

const DEFS: Record<string, Def> = {
  collected: {
    title: 'Payments received', perm: 'fee:read', ranged: true, open: { label: 'Open fees', to: '/fees' },
    columns: [{ key: 'paid_at', label: 'Paid on', kind: 'datetime' }, { key: 'full_name', label: 'Learner' }, { key: 'learner_code', label: 'Code' }, { key: 'receipt_no', label: 'Receipt' }, { key: 'method', label: 'Method', kind: 'status' }, { key: 'amount', label: 'Amount', kind: 'money' }],
    async run(c) {
      const p = new Params();
      const where = `p.org_id = ${p.add(c.orgId)} AND p.status <> 'voided' AND ${within('p.paid_at', c.r, (v) => p.add(v), true)} ${lscope(c, p)}`;
      const from = `FROM payments p JOIN learners l ON l.id = p.learner_id`;
      const [rows, agg] = await Promise.all([
        query(`SELECT p.id, p.paid_at, p.receipt_no, p.method, p.reference, p.amount - p.refunded_amount AS amount, l.id AS learner_id, l.full_name, l.learner_code ${from} WHERE ${where} ORDER BY p.paid_at DESC, p.created_at DESC LIMIT ${LIMIT}`, p.values),
        queryOne(`SELECT COALESCE(SUM(p.amount - p.refunded_amount), 0) AS total, COUNT(*) AS payments, COUNT(DISTINCT p.learner_id) AS payers ${from} WHERE ${where}`, p.values),
      ]);
      return { rows: rows.map((r) => learnerLink({ ...r, amount: money(r.amount) })), total_rows: n(agg!.payments),
        summary: [{ label: 'Collected', value: money(agg!.total), kind: 'money' }, { label: 'Payments', value: n(agg!.payments) }, { label: 'People who paid', value: n(agg!.payers) }] };
    },
  },
  outstanding: { title: 'Fees still to collect', perm: 'fee:read', ranged: false, open: { label: 'Open dues', to: '/fees' }, columns: dueCols(), run: (c) => dues(c, false) },
  overdue: { title: 'Overdue fees', perm: 'fee:read', ranged: false, open: { label: 'Open dues', to: '/fees' }, columns: dueCols(), run: (c) => dues(c, true) },
  learners: {
    title: 'Learners', perm: 'learner:read', ranged: false, open: { label: 'Open learners', to: '/learners' },
    columns: [{ key: 'full_name', label: 'Learner' }, { key: 'learner_code', label: 'Code' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'batches', label: 'Batches', kind: 'number' }, { key: 'created_at', label: 'Joined', kind: 'date' }],
    run: (c) => learners(c, ''),
  },
  new_learners: {
    title: 'New learners', perm: 'learner:read', ranged: true, open: { label: 'Open learners', to: '/learners' },
    columns: [{ key: 'created_at', label: 'Joined', kind: 'date' }, { key: 'full_name', label: 'Learner' }, { key: 'learner_code', label: 'Code' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'batches', label: 'Batches', kind: 'number' }],
    run: (c) => learners(c, 'ranged'),
  },
  without_batch: {
    title: 'Active learners not in any batch', perm: 'learner:read', ranged: false, open: { label: 'Open learners', to: '/learners?no_batch=true' },
    columns: [{ key: 'full_name', label: 'Learner' }, { key: 'learner_code', label: 'Code' }, { key: 'created_at', label: 'Joined', kind: 'date' }],
    run: (c) => learners(c, 'no_batch'),
  },
  batches: {
    title: 'Batches', perm: 'batch:read', ranged: false, open: { label: 'Open batches', to: '/batches' },
    columns: [{ key: 'name', label: 'Batch' }, { key: 'course_name', label: 'Course' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'learners', label: 'Learners', kind: 'number' }, { key: 'capacity', label: 'Capacity', kind: 'number' }],
    async run(c) {
      const p = new Params();
      const rows = await query(`SELECT b.id, b.name, b.status, b.capacity, c.name AS course_name, (SELECT COUNT(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS learners
          FROM batches b JOIN courses c ON c.id = b.course_id WHERE b.org_id = ${p.add(c.orgId)} AND b.deleted_at IS NULL AND b.status <> 'archived' ${bscope(c, p)} ORDER BY FIELD(b.status, 'active', 'upcoming', 'completed'), b.name LIMIT ${LIMIT}`, p.values);
      return { rows: rows.map((r) => ({ ...r, learners: n(r.learners), link: `/batches/${r.id}` })),
        summary: [{ label: 'Batches', value: rows.length }, { label: 'Active', value: rows.filter((r) => r.status === 'active').length }, { label: 'Memberships', value: rows.reduce((s, r) => s + n(r.learners), 0) }] };
    },
  },
  teachers: {
    title: 'Teachers', perm: 'teacher:read', ranged: false, open: { label: 'Open teachers', to: '/teachers' },
    columns: [{ key: 'full_name', label: 'Teacher' }, { key: 'email', label: 'E-mail' }, { key: 'batches', label: 'Active batches', kind: 'number' }, { key: 'learners', label: 'Learners', kind: 'number' }],
    async run(c) {
      const rows = await query(`SELECT u.id, u.full_name, u.email,
            (SELECT COUNT(*) FROM teacher_batch_memberships t JOIN batches b ON b.id = t.batch_id AND b.deleted_at IS NULL AND b.status = 'active' WHERE t.teacher_user_id = u.id AND t.status = 'active') AS batches,
            (SELECT COUNT(DISTINCT m.learner_id) FROM teacher_batch_memberships t JOIN learner_batch_memberships m ON m.batch_id = t.batch_id AND m.status = 'active' WHERE t.teacher_user_id = u.id AND t.status = 'active') AS learners
          FROM users u WHERE u.org_id = $1 AND u.deleted_at IS NULL AND u.status = 'active'
            AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = 'teacher') ORDER BY u.full_name LIMIT ${LIMIT}`, [c.orgId]);
      return { rows: rows.map((r) => ({ ...r, batches: n(r.batches), learners: n(r.learners) })), summary: [{ label: 'Teachers', value: rows.length }] };
    },
  },
  attendance: {
    title: 'Attendance by batch', ranged: true, open: { label: 'Compare batches', to: '/analytics' },
    columns: [{ key: 'name', label: 'Batch' }, { key: 'sessions', label: 'Classes', kind: 'number' }, { key: 'present', label: 'Present or late', kind: 'number' }, { key: 'absent', label: 'Absent', kind: 'number' }, { key: 'pct', label: 'Attendance', kind: 'pct' }],
    async run(c) {
      const p = new Params();
      const rows = await query(`SELECT b.id, b.name, COUNT(DISTINCT s.id) AS sessions, COALESCE(SUM(a.status IN ('present','late')), 0) AS present, COALESCE(SUM(a.status = 'absent'), 0) AS absent
          FROM attendance a JOIN class_sessions s ON s.id = a.session_id AND s.status <> 'cancelled' JOIN batches b ON b.id = a.batch_id
         WHERE b.org_id = ${p.add(c.orgId)} AND b.deleted_at IS NULL ${bscope(c, p)} AND ${within('s.starts_at', c.r, (v) => p.add(v))} GROUP BY b.id, b.name LIMIT ${LIMIT}`, p.values);
      const out = rows.map((r) => ({ ...r, sessions: n(r.sessions), present: n(r.present), absent: n(r.absent), pct: attendancePct({ present: n(r.present), late: 0, absent: n(r.absent) }), link: `/batches/${r.id}` }))
        .sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101));
      const P = out.reduce((s, r) => s + r.present, 0); const A = out.reduce((s, r) => s + r.absent, 0);
      return { rows: out, summary: [{ label: 'Attendance', value: attendancePct({ present: P, late: 0, absent: A }), kind: 'pct' }, { label: 'Classes', value: out.reduce((s, r) => s + r.sessions, 0) }, { label: 'Absences', value: A }] };
    },
  },
  scores: {
    title: 'Scores by batch', ranged: true, open: { label: 'Compare batches', to: '/analytics' },
    columns: [{ key: 'name', label: 'Batch' }, { key: 'scores', label: 'Scores', kind: 'number' }, { key: 'learners', label: 'Learners', kind: 'number' }, { key: 'pct', label: 'Average', kind: 'pct' }],
    async run(c) {
      const p = new Params();
      const rows = await query(`SELECT b.id, b.name, COUNT(*) AS scores, COUNT(DISTINCT s.learner_id) AS learners, AVG(s.score / s.max_score * 100) AS pct
          FROM scores s JOIN batches b ON b.id = s.batch_id WHERE s.deleted_at IS NULL AND b.org_id = ${p.add(c.orgId)} AND b.deleted_at IS NULL ${bscope(c, p)} AND ${within('s.created_at', c.r, (v) => p.add(v))}
         GROUP BY b.id, b.name ORDER BY pct LIMIT ${LIMIT}`, p.values);
      const out = rows.map((r) => ({ ...r, scores: n(r.scores), learners: n(r.learners), pct: r.pct == null ? null : Math.round(n(r.pct) * 10) / 10, link: `/batches/${r.id}` }));
      const total = out.reduce((s, r) => s + r.scores, 0);
      return { rows: out, summary: [{ label: 'Scores recorded', value: total }, { label: 'Average', value: total ? Math.round(out.reduce((s, r) => s + (r.pct ?? 0) * r.scores, 0) / total * 10) / 10 : null, kind: 'pct' }] };
    },
  },
  pending_evaluations: {
    title: 'Work waiting for evaluation', ranged: false, open: { label: 'Open classroom', to: '/classroom' },
    columns: [{ key: 'submitted_at', label: 'Handed in', kind: 'datetime' }, { key: 'full_name', label: 'Learner' }, { key: 'title', label: 'Assignment' }, { key: 'batch_name', label: 'Batch' }, { key: 'status', label: 'Status', kind: 'status' }],
    async run(c) {
      const p = new Params();
      const where = `s.status IN ('submitted','late') AND b.org_id = ${p.add(c.orgId)} AND b.deleted_at IS NULL ${bscope(c, p)}`;
      const from = `FROM submissions s JOIN assignments a ON a.id = s.assignment_id AND a.deleted_at IS NULL JOIN batches b ON b.id = a.batch_id JOIN learners l ON l.id = s.learner_id`;
      const [rows, agg] = await Promise.all([
        query(`SELECT s.id, s.status, s.submitted_at, a.id AS assignment_id, a.title, b.name AS batch_name, l.full_name ${from} WHERE ${where} ORDER BY s.submitted_at LIMIT ${LIMIT}`, p.values),
        queryOne(`SELECT COUNT(*) AS n ${from} WHERE ${where}`, p.values),
      ]);
      return { rows: rows.map((r) => ({ ...r, link: `/assignments/${r.assignment_id}` })), total_rows: n(agg!.n), summary: [{ label: 'Waiting', value: n(agg!.n) }] };
    },
  },
  xp: {
    title: 'XP earned', ranged: true, open: { label: 'Open gamification', to: '/gamification' },
    columns: [{ key: 'full_name', label: 'Learner' }, { key: 'learner_code', label: 'Code' }, { key: 'xp', label: 'XP', kind: 'number' }, { key: 'events', label: 'Awards', kind: 'number' }],
    async run(c) {
      const p = new Params();
      const rows = await query(`SELECT l.id AS learner_id, l.full_name, l.learner_code, SUM(x.points) AS xp, COUNT(*) AS events
          FROM xp_transactions x JOIN batches b ON b.id = x.batch_id JOIN learners l ON l.id = x.learner_id
         WHERE b.org_id = ${p.add(c.orgId)} AND b.deleted_at IS NULL ${bscope(c, p)} AND ${within('x.created_at', c.r, (v) => p.add(v))} GROUP BY l.id, l.full_name, l.learner_code ORDER BY xp DESC LIMIT ${LIMIT}`, p.values);
      const out = rows.map((r) => learnerLink({ ...r, xp: n(r.xp), events: n(r.events) }));
      return { rows: out, summary: [{ label: 'Total XP', value: out.reduce((s, r) => s + r.xp, 0) }, { label: 'Learners', value: out.length }] };
    },
  },
  badges: {
    title: 'Badges awarded', ranged: true, open: { label: 'Open gamification', to: '/gamification' },
    columns: [{ key: 'awarded_at', label: 'Awarded', kind: 'datetime' }, { key: 'full_name', label: 'Learner' }, { key: 'badge', label: 'Badge' }, { key: 'awarded_by_name', label: 'By' }],
    async run(c) {
      const p = new Params();
      const rows = await query(`SELECT lb.id, lb.awarded_at, bd.name AS badge, u.full_name AS awarded_by_name, l.id AS learner_id, l.full_name
          FROM learner_badges lb JOIN badges bd ON bd.id = lb.badge_id JOIN learners l ON l.id = lb.learner_id LEFT JOIN users u ON u.id = lb.awarded_by
         WHERE lb.revoked_at IS NULL AND l.org_id = ${p.add(c.orgId)} AND l.deleted_at IS NULL ${lscope(c, p)} AND ${within('lb.awarded_at', c.r, (v) => p.add(v))} ORDER BY lb.awarded_at DESC LIMIT ${LIMIT}`, p.values);
      return { rows: rows.map(learnerLink), summary: [{ label: 'Badges', value: rows.length }, { label: 'Learners', value: new Set(rows.map((r) => r.learner_id)).size }] };
    },
  },
  leads: {
    title: 'Leads added', perm: 'crm:read', ranged: true, open: { label: 'Open CRM', to: '/crm' },
    columns: [{ key: 'created_at', label: 'Added', kind: 'date' }, { key: 'full_name', label: 'Name' }, { key: 'lead_status', label: 'Status', kind: 'status' }, { key: 'lead_source', label: 'Source' }, { key: 'counsellor', label: 'Counsellor' }, { key: 'next_follow_up_at', label: 'Next follow-up', kind: 'datetime' }],
    async run(c) {
      const p = new Params();
      const rows = await query(`SELECT cl.id, cl.created_at, cl.lead_status, cl.lead_source, cl.next_follow_up_at, u.full_name AS counsellor, l.id AS learner_id, l.full_name
          FROM crm_leads cl JOIN learners l ON l.id = cl.learner_id LEFT JOIN users u ON u.id = cl.counsellor_user_id
         WHERE l.org_id = ${p.add(c.orgId)} AND l.deleted_at IS NULL ${lscope(c, p)} AND ${within('cl.created_at', c.r, (v) => p.add(v))} ORDER BY cl.created_at DESC LIMIT ${LIMIT}`, p.values);
      return { rows: rows.map(learnerLink), summary: [{ label: 'Leads', value: rows.length }, { label: 'Converted', value: rows.filter((r) => r.lead_status === 'converted').length }] };
    },
  },
  classes: {
    title: 'Classes in the next 7 days', ranged: false, open: { label: 'Open timetable', to: '/timetable' },
    columns: [{ key: 'starts_at', label: 'Starts', kind: 'datetime' }, { key: 'batch_name', label: 'Batch' }, { key: 'title', label: 'Class' }, { key: 'status', label: 'Status', kind: 'status' }],
    async run(c) {
      const p = new Params();
      const rows = await query(`SELECT s.id, s.starts_at, s.title, s.status, b.id AS batch_id, b.name AS batch_name FROM class_sessions s JOIN batches b ON b.id = s.batch_id
         WHERE s.status IN ('scheduled','started') AND s.starts_at > NOW(3) AND s.starts_at < DATE_ADD(NOW(3), INTERVAL 7 DAY) AND b.org_id = ${p.add(c.orgId)} AND b.deleted_at IS NULL ${bscope(c, p)} ORDER BY s.starts_at LIMIT ${LIMIT}`, p.values);
      return { rows: rows.map((r) => ({ ...r, link: `/classroom/${r.batch_id}` })), summary: [{ label: 'Classes', value: rows.length }] };
    },
  },
};

function dueCols(): Col[] {
  return [{ key: 'full_name', label: 'Learner' }, { key: 'learner_code', label: 'Code' }, { key: 'installments', label: 'Instalments', kind: 'number' }, { key: 'oldest_due', label: 'Oldest due date', kind: 'date' }, { key: 'days_overdue', label: 'Days late', kind: 'number' }, { key: 'due', label: 'Amount due', kind: 'money' }];
}

async function dues(c: Ctx, overdueOnly: boolean): Promise<Out> {
  const p = new Params();
  const t = p.add(c.today);
  const where = `i.org_id = ${p.add(c.orgId)} AND i.status IN ('pending','partial') ${overdueOnly ? `AND i.due_date < ${p.add(c.today)}` : ''} ${lscope(c, p)}`;
  const from = `FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id AND f.status = 'active' JOIN learners l ON l.id = i.learner_id AND l.deleted_at IS NULL`;
  const [rows, agg] = await Promise.all([
    query(`SELECT l.id AS learner_id, l.full_name, l.learner_code, COUNT(*) AS installments, SUM(i.amount - i.paid_amount) AS due, MIN(i.due_date) AS oldest_due, GREATEST(DATEDIFF(${t}, MIN(i.due_date)), 0) AS days_overdue
        ${from} WHERE ${where} GROUP BY l.id, l.full_name, l.learner_code ORDER BY due DESC LIMIT ${LIMIT}`, p.values),
    queryOne(`SELECT COALESCE(SUM(i.amount - i.paid_amount), 0) AS due, COUNT(DISTINCT i.learner_id) AS learners ${from} WHERE ${where}`, p.values),
  ]);
  return { rows: rows.map((r) => learnerLink({ ...r, installments: n(r.installments), due: money(r.due), days_overdue: n(r.days_overdue) })), total_rows: n(agg!.learners),
    summary: [{ label: overdueOnly ? 'Overdue' : 'Outstanding', value: money(agg!.due), kind: 'money' }, { label: 'Learners', value: n(agg!.learners) }] };
}

async function learners(c: Ctx, mode: '' | 'ranged' | 'no_batch'): Promise<Out> {
  const p = new Params();
  const extra = mode === 'ranged' ? `AND ${within('l.created_at', c.r, (v) => p.add(v))}`
    : mode === 'no_batch' ? `AND l.status = 'active' AND NOT EXISTS (SELECT 1 FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.status = 'active')` : '';
  const where = `l.org_id = ${p.add(c.orgId)} AND l.deleted_at IS NULL AND l.status <> 'archived' ${lscope(c, p)} ${extra}`;
  const [rows, agg] = await Promise.all([
    query(`SELECT l.id AS learner_id, l.full_name, l.learner_code, l.status, l.created_at, (SELECT COUNT(*) FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.status = 'active') AS batches
        FROM learners l WHERE ${where} ORDER BY ${mode === 'ranged' ? 'l.created_at DESC' : 'l.full_name'} LIMIT ${LIMIT}`, p.values),
    queryOne(`SELECT COUNT(*) AS n, COALESCE(SUM(l.status = 'active'), 0) AS active FROM learners l WHERE ${where}`, p.values),
  ]);
  return { rows: rows.map((r) => learnerLink({ ...r, batches: n(r.batches) })), total_rows: n(agg!.n),
    summary: [{ label: 'Learners', value: n(agg!.n) }, ...(mode === 'no_batch' ? [] : [{ label: 'Active', value: n(agg!.active) }])] };
}

detailsRouter.get('/:metric', wrap(async (req, res) => {
  const def = DEFS[req.params.metric as string];
  if (!def) throw notFound('Dashboard detail');
  const u = req.user!;
  if (def.perm && !u.isSuperAdmin && !u.permissions.has(def.perm)) throw forbidden();
  const q = parse(periodQuery, req.query);
  const orgId = orgIdOf(req); const tz = await orgTimezone(orgId);
  const r = resolveRange(q, tz) ?? resolveRange({ period: 'month' }, tz)!;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const out = await def.run({ req, orgId, r, today });
  ok(res, {
    metric: req.params.metric, title: def.title, period: def.ranged ? publicRange(r) : null, columns: def.columns, open: def.open ?? null,
    rows: out.rows, summary: out.summary, total_rows: out.total_rows ?? out.rows.length, truncated: (out.total_rows ?? out.rows.length) > out.rows.length,
  });
}));
