import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { batchScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { zonedToUtc } from '../attendance/time.js';
import { orgInfo } from '../fees/service.js';
import { fromPaise, toPaise } from '../fees/money.js';

const router = Router(); // mounted at /api/payroll
router.use(requireOrg);
const read = requirePerm('payroll:read');
const manage = requirePerm('payroll:manage');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.');

const nextMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y! + 1}-01-01` : `${y}-${String(mm! + 1).padStart(2, '0')}-01`; };

/**
 * One row per teacher for the month. A class counts for every teacher who was on the batch the day it was held (lead or assistant), and only
 * classes marked completed count as taught. Hours come from the class's start and end. This is an ESTIMATE for the accountant, not a payslip.
 */
async function summary(req: any, m: string) {
  const orgId = orgIdOf(req); const org = await orgInfo(orgId);
  const from = zonedToUtc(`${m}-01`, '00:00', org.tz); const to = zonedToUtc(nextMonth(m), '00:00', org.tz);
  const p = new Params(); const sc = batchScope(req.user, p, 'b');
  const rows = await query(`SELECT u.id AS teacher_id, u.full_name, u.email,
      COUNT(DISTINCT CASE WHEN s.status = 'completed' THEN s.id END) AS classes_held,
      COUNT(DISTINCT CASE WHEN s.status = 'cancelled' THEN s.id END) AS classes_cancelled,
      COUNT(DISTINCT CASE WHEN s.status IN ('scheduled','started') AND s.starts_at < NOW(3) THEN s.id END) AS classes_not_closed,
      COALESCE(SUM(CASE WHEN s.status = 'completed' AND s.ends_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, s.starts_at, s.ends_at) ELSE 0 END), 0) AS minutes,
      COUNT(DISTINCT CASE WHEN s.status = 'completed' AND s.ends_at IS NULL THEN s.id END) AS missing_end,
      COUNT(DISTINCT CASE WHEN s.status = 'completed' AND EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = s.id) THEN s.id END) AS attendance_marked,
      COUNT(DISTINCT b.id) AS batches
    FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id AND u.deleted_at IS NULL
      JOIN batches b ON b.id = t.batch_id AND b.org_id = t.org_id
      JOIN class_sessions s ON s.batch_id = t.batch_id AND s.org_id = t.org_id AND s.starts_at >= ${p.add(from)} AND s.starts_at < ${p.add(to)}
        AND t.assigned_at <= s.starts_at AND (t.removed_at IS NULL OR t.removed_at >= s.starts_at)
    WHERE t.org_id = ${p.add(orgId)} ${sc ? `AND ${sc}` : ''} GROUP BY u.id, u.full_name, u.email ORDER BY u.full_name`, p.values);
  const rates = await query(`SELECT teacher_user_id, rate_per_hour FROM teacher_rates r WHERE r.org_id = $1 AND r.effective_from <= $2 AND r.effective_from = (SELECT MAX(effective_from) FROM teacher_rates x WHERE x.teacher_user_id = r.teacher_user_id AND x.effective_from <= $2)`,
    [orgId, `${m}-${new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).getUTCDate()}`]);
  const rate = new Map(rates.map((r) => [r.teacher_user_id as string, Number(r.rate_per_hour).toFixed(2)]));
  const out = rows.map((r) => {
    const minutes = Number(r.minutes); const hours = Math.round((minutes / 60) * 100) / 100; const rt = rate.get(r.teacher_id) ?? null;
    return { teacher_id: r.teacher_id, full_name: r.full_name, email: r.email, batches: Number(r.batches), classes_held: Number(r.classes_held), classes_cancelled: Number(r.classes_cancelled), classes_not_closed: Number(r.classes_not_closed),
      missing_end: Number(r.missing_end), attendance_marked: Number(r.attendance_marked), hours, rate_per_hour: rt, estimated_pay: rt === null ? null : fromPaise(Math.round((minutes * toPaise(rt)) / 60)) };
  });
  const total = out.reduce((s, r) => s + (r.estimated_pay === null ? 0 : toPaise(r.estimated_pay)), 0);
  return { month: m, timezone: org.tz, teachers: out, totals: { classes_held: out.reduce((s, r) => s + r.classes_held, 0), hours: Math.round(out.reduce((s, r) => s + r.hours, 0) * 100) / 100, estimated_pay: fromPaise(total), without_rate: out.filter((r) => r.rate_per_hour === null && r.classes_held > 0).length } };
}

router.get('/summary', read, wrap(async (req, res) => { ok(res, await summary(req, parse(month, req.query.month))); }));

router.get('/summary.csv', read, wrap(async (req, res) => {
  const m = parse(month, req.query.month); const s = await summary(req, m);
  const cell = (v: unknown) => { const t = String(v ?? ''); return /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; };      // never let a spreadsheet run a name as a formula
  const csv = [['Teacher', 'E-mail', 'Batches', 'Classes held', 'Classes cancelled', 'Hours', 'Rate per hour', 'Estimated pay'].join(','),
    ...s.teachers.map((r) => [r.full_name, r.email, r.batches, r.classes_held, r.classes_cancelled, r.hours, r.rate_per_hour ?? '', r.estimated_pay ?? ''].map((v) => `"${cell(v).replace(/"/g, '""')}"`).join(','))].join('\r\n');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'payroll.exported', entityType: 'payroll', entityId: m, req });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="teacher-workload-${m}.csv"`, 'Cache-Control': 'no-store' }).send('﻿' + csv + '\r\n');
}));

router.get('/rates', read, wrap(async (req, res) => {
  const rows = await query(`SELECT u.id AS teacher_id, u.full_name, u.email,
      (SELECT r.rate_per_hour FROM teacher_rates r WHERE r.teacher_user_id = u.id AND r.effective_from <= CURDATE() ORDER BY r.effective_from DESC LIMIT 1) AS rate_per_hour,
      (SELECT r.effective_from FROM teacher_rates r WHERE r.teacher_user_id = u.id AND r.effective_from <= CURDATE() ORDER BY r.effective_from DESC LIMIT 1) AS effective_from
    FROM users u WHERE u.org_id = $1 AND u.deleted_at IS NULL AND u.status = 'active' AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id WHERE ur.user_id = u.id AND ro.code = 'teacher') ORDER BY u.full_name`, [orgIdOf(req)]);
  ok(res, rows.map((r) => ({ ...r, rate_per_hour: r.rate_per_hour === null ? null : Number(r.rate_per_hour).toFixed(2) })));
}));

router.put('/rates/:teacherId', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const tid = parse(uuid, req.params.teacherId);
  const b = parse(z.object({ rate_per_hour: z.number().min(0).max(100000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Use at most 2 decimal places.'), effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
  if (!(await queryOne(`SELECT 1 FROM users WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [tid, orgId]))) throw notFound('Teacher');
  const prev = await queryOne(`SELECT rate_per_hour FROM teacher_rates WHERE teacher_user_id = $1 AND effective_from = $2`, [tid, b.effective_from]);
  await exec(`INSERT INTO teacher_rates (id, org_id, teacher_user_id, rate_per_hour, effective_from, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON DUPLICATE KEY UPDATE rate_per_hour = VALUES(rate_per_hour), created_by = VALUES(created_by)`, [newId(), orgId, tid, b.rate_per_hour, b.effective_from, req.user!.id]);
  await audit({ orgId, actor: req.user, action: 'payroll.rate_set', entityType: 'user', entityId: tid, previous: prev ?? undefined, next: b, req });
  ok(res, { teacher_id: tid, ...b });
}));
export default router;
