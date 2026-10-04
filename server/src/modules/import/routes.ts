import express, { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { csvCell } from '../../lib/security.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { actorOf, finish, jobCounts, processJob } from './runner.js';
import { COLUMNS, TEMPLATE_CSV, cleanRow, readCsv, type Clean, type Lookups } from './validate.js';

const router = Router();
router.use(requireOrg, requirePerm('learner:create'));

router.get('/learners/template.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="learners-import-template.csv"');
  res.send('﻿' + TEMPLATE_CSV);
});

const chunk = <T,>(a: T[], n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Step 1: upload. Every row is checked against the rules and the existing data; NOTHING is written to learners. */
router.post('/learners/preview', limit('bulk', 30), express.text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '4mb' }), wrap(async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) throw badRequest('Send the CSV file as the request body (Content-Type: text/csv).');
  const orgId = orgIdOf(req); const user = req.user!;
  const fileName = String(req.query.file_name ?? 'import.csv').replace(/[^\w.\- ]/g, '_').slice(0, 200);
  let file; try { file = readCsv(req.body); } catch (e: any) { throw badRequest(e.message); }

  const lk: Lookups = {
    branches: await query(`SELECT id, name, code FROM branches WHERE org_id = $1 AND deleted_at IS NULL`, [orgId]),
    batches: await query(`SELECT id, name, batch_code, status, branch_id, capacity FROM batches WHERE org_id = $1 AND deleted_at IS NULL`, [orgId]),
  };
  // existing learners by mobile / email (one lookup per 500 rows, not per row)
  const mobiles = new Map<string, any>(); const emails = new Map<string, any>();
  const cleaned = file.rows.map((r) => ({ ...r, ...cleanRow(r.cells, lk, user) }));
  for (const part of chunk(cleaned.filter((r) => r.clean), 400)) {
    const ms = part.map((r) => r.clean!.mobile).filter(Boolean) as string[]; const es = part.map((r) => r.clean!.email).filter(Boolean) as string[];
    if (!ms.length && !es.length) continue;
    const p = new Params(); const w: string[] = [];
    if (ms.length) w.push(`mobile IN ${p.in(ms)}`); if (es.length) w.push(`email IN ${p.in(es)}`);
    for (const l of await query(`SELECT id, learner_code, full_name, mobile, email FROM learners WHERE org_id = ${p.add(orgId)} AND deleted_at IS NULL AND (${w.join(' OR ')})`, p.values)) { if (l.mobile) mobiles.set(l.mobile, l); if (l.email) emails.set(l.email, l); }
  }
  const seenMobile = new Map<string, number>(); const seenEmail = new Map<string, number>();
  const jobId = newId();
  const out: { rowNo: number; status: string; raw: object; clean: object | null; message: string | null }[] = [];
  const perBatch = new Map<string, number>();
  for (const r of cleaned) {
    if (!r.clean) { out.push({ rowNo: r.rowNo, status: 'error', raw: r.cells, clean: null, message: r.errors.join(' ') }); continue; }
    const c = r.clean; let dupMsg: string | null = null; let existing: any = null;
    const fm = c.mobile ? seenMobile.get(c.mobile) : undefined; const fe = c.email ? seenEmail.get(c.email) : undefined;
    if (fm || fe) dupMsg = `Same ${fm ? 'mobile' : 'email'} as row ${fm ?? fe} in this file.`;
    else { existing = (c.mobile && mobiles.get(c.mobile)) || (c.email && emails.get(c.email)) || null; if (existing) dupMsg = `Already in the system: ${existing.full_name} (${existing.learner_code}).`; }
    if (c.mobile && !seenMobile.has(c.mobile)) seenMobile.set(c.mobile, r.rowNo); if (c.email && !seenEmail.has(c.email)) seenEmail.set(c.email, r.rowNo);
    const data = { ...c, existing: existing ? { id: existing.id, learner_code: existing.learner_code, full_name: existing.full_name } : null };
    out.push({ rowNo: r.rowNo, status: dupMsg ? 'duplicate' : 'valid', raw: r.cells, clean: data, message: dupMsg });
    if (!dupMsg) for (const b of c.batch_ids) perBatch.set(b, (perBatch.get(b) ?? 0) + 1);
  }
  await exec(`INSERT INTO import_jobs (id, org_id, kind, file_name, total_rows, created_by) VALUES ($1,$2,'learners',$3,$4,$5)`, [jobId, orgId, fileName, out.length, user.id]);
  for (const part of chunk(out, 300)) {
    const p = new Params();
    await exec(`INSERT INTO import_rows (job_id, org_id, row_no, status, raw, clean, message) VALUES ${part.map((r) => `(${p.add(jobId)},${p.add(orgId)},${p.add(r.rowNo)},${p.add(r.status)},${p.add(JSON.stringify(r.raw))},${p.add(r.clean ? JSON.stringify(r.clean) : null)},${p.add(r.message)})`).join(',')}`, p.values);
  }
  const warnings: string[] = [];
  for (const [bid, n] of perBatch) {
    const b = lk.batches.find((x) => x.id === bid) as any; if (!b?.capacity) continue;
    const cur = Number((await queryOne(`SELECT COUNT(*) AS n FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [bid]))!.n);
    if (cur + n > b.capacity) warnings.push(`${b.name} has ${Math.max(b.capacity - cur, 0)} seat(s) left but this file adds ${n} learner(s): the extra rows will fail with "capacity exceeded".`);
  }
  const counts = await jobCounts(jobId);
  const problems = (await query(`SELECT row_no, status, message, raw FROM import_rows WHERE job_id = $1 AND status IN ('error','duplicate') ORDER BY row_no LIMIT 100`, [jobId]));
  ok(res, { id: jobId, file_name: fileName, total_rows: out.length, counts, warnings, unknown_columns: file.unknownHeaders, problems, sample: (await query(`SELECT row_no, clean FROM import_rows WHERE job_id = $1 AND status = 'valid' ORDER BY row_no LIMIT 8`, [jobId])).map((r) => ({ row_no: r.row_no, ...(r.clean as Clean) })), existing_duplicates: out.filter((r) => r.status === 'duplicate' && (r.clean as any)?.existing).length }, undefined, 201);
}));

async function ownJob(req: any) {
  const j = await queryOne(`SELECT id, org_id, kind, status, file_name, total_rows, options, summary, created_by, created_at, confirmed_at, finished_at FROM import_jobs WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req)]);
  if (!j || (!req.user.isSuperAdmin && !req.user.access.orgWide && j.created_by !== req.user.id)) throw notFound('Import');
  return j;
}

router.get('/', wrap(async (req, res) => {
  const mine = req.user!.isSuperAdmin || req.user!.access.orgWide ? '' : ' AND j.created_by = $2';
  const rows = await query(`SELECT j.id, j.file_name, j.status, j.total_rows, j.summary, j.created_at, j.finished_at, u.full_name AS created_by_name FROM import_jobs j JOIN users u ON u.id = j.created_by WHERE j.org_id = $1${mine} ORDER BY j.created_at DESC LIMIT 30`, mine ? [orgIdOf(req), req.user!.id] : [orgIdOf(req)]);
  ok(res, rows);
}));

router.get('/:id', wrap(async (req, res) => {
  const j = await ownJob(req); const counts = await jobCounts(j.id);
  const pending = counts.valid + counts.processing + (j.status === 'running' ? counts.duplicate : 0);
  ok(res, { ...j, options: undefined, on_duplicate: (j.options as any)?.on_duplicate ?? null, counts, progress_pct: j.status === 'previewed' ? 0 : j.total_rows ? Math.round(((j.total_rows - pending - counts.error - (j.status === 'running' ? 0 : counts.duplicate)) / Math.max(j.total_rows - counts.error, 1)) * 100) : 100 });
}));

router.get('/:id/rows', wrap(async (req, res) => {
  const j = await ownJob(req);
  const q = parse(paging.extend({ status: z.enum(['valid', 'error', 'duplicate', 'created', 'merged', 'skipped', 'failed']).optional() }), req.query);
  const p = new Params(); const w = [`job_id = ${p.add(j.id)}`]; if (q.status) w.push(`status = ${p.add(q.status)}`);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM import_rows WHERE ${w.join(' AND ')}`, p.values))!.n);
  const rows = await query(`SELECT row_no, status, message, learner_id, raw FROM import_rows WHERE ${w.join(' AND ')} ORDER BY row_no LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows, { page: q.page, page_size: q.page_size, total, total_pages: Math.ceil(total / q.page_size) });
}));

/** The rows that did not go in, as a CSV in the same layout plus the reason, ready to fix and upload again. */
router.get('/:id/problems.csv', wrap(async (req, res) => {
  const j = await ownJob(req);
  const rows = await query(`SELECT row_no, status, message, raw FROM import_rows WHERE job_id = $1 AND status IN ('error','failed','duplicate','skipped') ORDER BY row_no`, [j.id]);
  const lines = [[...COLUMNS, 'row', 'problem'].map(csvCell).join(','), ...rows.map((r) => [...COLUMNS.map((c) => (r.raw as any)?.[c] ?? ''), r.row_no, r.message ?? r.status].map(csvCell).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="import-problems-${j.id.slice(0, 8)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

/** Step 2: go. The numbers the person reviewed must still be true; duplicates are skipped or merged as chosen. */
router.post('/:id/confirm', limit('bulk', 30), wrap(async (req, res) => {
  const b = parse(z.object({ confirm: z.literal(true, { message: 'Review the preview and confirm to import.' }), on_duplicate: z.enum(['skip', 'merge']).default('skip'), expected_valid: z.number().int().min(0) }), req.body);
  const j = await ownJob(req);
  if (j.status !== 'previewed') throw conflict('This import has already been started.', 'ALREADY_STARTED');
  const counts = await jobCounts(j.id);
  const toWrite = counts.valid + (b.on_duplicate === 'merge' ? counts.duplicate : 0);
  if (!toWrite) throw badRequest('There is nothing to import: every row has a problem or is a duplicate.');
  if (counts.valid !== b.expected_valid) throw new AppError(409, 'PREVIEW_CHANGED', `The preview showed ${b.expected_valid} new learners but this job has ${counts.valid}. Upload the file again.`);
  // duplicates inside the file (not existing people) are never imported; existing ones are skipped unless merging
  for (const r of await query(`SELECT id, clean FROM import_rows WHERE job_id = $1 AND status = 'duplicate'`, [j.id])) {
    const existing = (r.clean as any)?.existing;
    if (b.on_duplicate === 'skip' || !existing) await exec(`UPDATE import_rows SET status = 'skipped' WHERE id = $1`, [r.id]);
  }
  const started = await exec(`UPDATE import_jobs SET status = 'running', confirmed_at = NOW(3), options = $2 WHERE id = $1 AND status = 'previewed'`, [j.id, JSON.stringify({ on_duplicate: b.on_duplicate, actor: actorOf(req.user!) })]);
  if (!started.affectedRows) throw conflict('This import has already been started.', 'ALREADY_STARTED');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'import.started', entityType: 'import_job', entityId: j.id, next: { file: j.file_name, rows: j.total_rows, new_learners: counts.valid, on_duplicate: b.on_duplicate }, req });
  void processJob(j.id);                       // runs in the background; the page polls GET /api/import/:id
  ok(res, { id: j.id, status: 'running', counts: await jobCounts(j.id) }, undefined, 202);
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  const j = await ownJob(req);
  if (j.status === 'previewed') { await exec(`DELETE FROM import_jobs WHERE id = $1`, [j.id]); return void ok(res, { id: j.id, cancelled: true, discarded: true }); }
  if (j.status !== 'running') throw conflict('This import has already finished.', 'ALREADY_FINISHED');
  await exec(`UPDATE import_rows SET status = 'skipped', message = 'Cancelled before this row was imported.' WHERE job_id = $1 AND status IN ('valid','duplicate')`, [j.id]);
  await finish({ id: j.id, org_id: j.org_id, options: j.options }, 'cancelled');
  ok(res, { id: j.id, cancelled: true, counts: await jobCounts(j.id) });
}));

export default router;
