import { Router } from 'express';
import writeXlsx from 'write-excel-file/node';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { csvCell } from '../../lib/security.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { z } from 'zod';
import { REPORTS, filterSchema, findReport, type Column, type ReportDef, type Row } from './registry.js';

const router = Router();
router.use(requireOrg, requirePerm('report:read'));
const PREVIEW = 500; const EXPORT_MAX = 50_000;

const isAdmin = (u: any) => u.isSuperAdmin || u.roles.some((r: string) => ['org_admin', 'branch_admin'].includes(r));
function allowed(u: any, r: ReportDef) {
  if (r.adminOnly && !isAdmin(u)) return false;
  if (r.needs && !u.isSuperAdmin && !u.permissions.has(r.needs)) return false;
  return true;
}
function load(req: any, id: string) {
  const r = findReport(id);
  if (!r || !allowed(req.user!, r)) throw notFound('Report');       // not allowed looks the same as not existing
  return r;
}
const meta = (r: ReportDef) => ({ id: r.id, title: r.title, description: r.description, filters: r.filters, columns: r.columns });

router.get('/', wrap(async (req, res) => ok(res, REPORTS.filter((r) => allowed(req.user!, r)).map(meta))));

async function run(req: any, r: ReportDef, input: unknown, limit: number) {
  const f = parse(filterSchema, input);
  const rows = await r.run({ user: req.user!, orgId: orgIdOf(req), limit }, f);
  return { f, rows };
}

router.get('/:id', wrap(async (req, res) => {
  const r = load(req, String(req.params.id));
  const { f, rows } = await run(req, r, req.query, PREVIEW + 1);
  ok(res, { ...meta(r), rows: rows.slice(0, PREVIEW), truncated: rows.length > PREVIEW, generated_at: new Date().toISOString(), filters_applied: f }, { total_shown: Math.min(rows.length, PREVIEW) });
}));

const cell = (c: Column, v: Row[string]) => (v === null || v === undefined ? '' : c.kind === 'percent' && typeof v === 'number' ? `${v}` : v);
const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

router.post('/:id/export', limit('export', 12), wrap(async (req, res) => {
  const r = load(req, String(req.params.id));
  const body = parse(z.object({ format: z.enum(['csv', 'xlsx']), filters: z.record(z.string(), z.unknown()).default({}) }), req.body);
  const { f, rows } = await run(req, r, body.filters, EXPORT_MAX + 1);
  if (rows.length > EXPORT_MAX) throw badRequest(`This report has more than ${EXPORT_MAX.toLocaleString('en-IN')} rows. Narrow it with the filters.`);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'report.exported', entityType: 'report', entityId: null, next: { report: r.id, format: body.format, rows: rows.length, filters: f }, req });
  const name = `${safeName(r.title)}-${new Date().toISOString().slice(0, 10)}`;
  if (body.format === 'csv') {
    const lines = [r.columns.map((c) => csvCell(c.label)).join(','), ...rows.map((row) => r.columns.map((c) => csvCell(cell(c, row[c.key]))).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return void res.send('﻿' + lines.join('\r\n'));        // BOM so Excel reads Hindi/Tamil names correctly
  }
  const head = r.columns.map((c) => ({ value: c.label, fontWeight: 'bold' as const }));
  const data = [head, ...rows.map((row) => r.columns.map((c) => {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && c.kind !== 'text') return { value: v, type: Number };
    // Typed as a string cell in the file, so a value like =SUM(...) is shown as text and never evaluated.
    return { value: String(v), type: String };
  }))];
  const buf = await writeXlsx(data as never, { sheet: r.title.slice(0, 31) } as never).toBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  res.send(Buffer.from(buf));
}));

export default router;
