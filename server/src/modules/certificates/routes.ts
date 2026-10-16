import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { appUrl } from '../../lib/appurl.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { batchScope, learnerScope } from '../../lib/scope.js';
import { notifyAbout } from '../../lib/notify.js';
import { recordActivity } from '../../lib/timeline.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { resolveLearnerIds, selectorSchema } from '../selection/resolver.js';
import { TEMPLATES, TOKENS, fillBody, fmtDate, issueCertificate, issueForBatch } from './service.js';
import { drawCertificate } from './render.js';

const router = Router(); // mounted at /api/certificates
router.use(requireOrg);
const read = requirePerm('cert:read');
const manage = requirePerm('cert:manage');
const MAX_ISSUE = 2000;
export { fillBody };
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// ------------------------------------------------------------------ designs
const designBody = z.object({
  name: z.string().trim().min(2, 'Name the design.').max(120),
  title_text: z.string().trim().min(2).max(120).default('Certificate of Completion'),
  body_text: z.string().trim().min(5).max(600).refine((s) => [...s.matchAll(/\{(\w+)\}/g)].every((m) => TOKENS.includes(m[1]!)), `Only these placeholders work: ${TOKENS.map((t) => `{${t}}`).join(' ')}`),
  signatory_name: z.string().trim().max(120).nullish().transform((v) => v || null), signatory_title: z.string().trim().max(120).nullish().transform((v) => v || null),
  show_logo: z.boolean().default(true), template: z.enum(TEMPLATES).default('classic'), accent: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #12263f.').nullish().transform((v) => v?.toLowerCase() ?? null),
});
router.get('/designs', read, wrap(async (req, res) => {
  ok(res, await query(`SELECT d.*, (SELECT COUNT(*) FROM certificates c WHERE c.design_id = d.id AND c.revoked_at IS NULL) AS issued FROM certificate_designs d WHERE d.org_id = $1 ORDER BY d.status, d.name`, [orgIdOf(req)]));
}));
router.post('/designs', manage, wrap(async (req, res) => {
  const b = parse(designBody, req.body); const orgId = orgIdOf(req); const id = newId();
  try { await exec(`INSERT INTO certificate_designs (id, org_id, name, title_text, body_text, signatory_name, signatory_title, show_logo, template, accent, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, orgId, b.name, b.title_text, b.body_text, b.signatory_name, b.signatory_title, b.show_logo, b.template, b.accent, req.user!.id]); }
  catch (e: any) { if (e?.errno === 1062) throw conflict('A design with this name already exists.'); throw e; }
  await audit({ orgId, actor: req.user, action: 'certificate.design_created', entityType: 'certificate_design', entityId: id, req });
  ok(res, { id }, undefined, 201);
}));
router.put('/designs/:id', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const b = parse(designBody.extend({ status: z.enum(['active', 'archived']).default('active') }), req.body); const orgId = orgIdOf(req);
  let r; try { r = await exec(`UPDATE certificate_designs SET name=$3, title_text=$4, body_text=$5, signatory_name=$6, signatory_title=$7, show_logo=$8, status=$9, template=$10, accent=$11 WHERE id=$1 AND org_id=$2`, [id, orgId, b.name, b.title_text, b.body_text, b.signatory_name, b.signatory_title, b.show_logo, b.status, b.template, b.accent]); }
  catch (e: any) { if (e?.errno === 1062) throw conflict('A design with this name already exists.'); throw e; }
  if (!r.affectedRows) throw notFound('Design');
  await audit({ orgId, actor: req.user, action: 'certificate.design_updated', entityType: 'certificate_design', entityId: id, req });
  ok(res, { id });                                  // already-issued certificates keep their original wording
}));

// ------------------------------------------------------------------ issue
router.post('/issue', manage, wrap(async (req, res) => {
  const b = parse(z.object({ design_id: uuid, selector: selectorSchema, batch_id: uuid.nullish(), issued_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dry_run: z.boolean().default(false), confirm: z.boolean().optional() }), req.body);
  if (!b.dry_run && b.confirm !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Review who will get a certificate and confirm.');
  const orgId = orgIdOf(req);
  const out = await tx(async (db) => {
    const d = await queryOne(`SELECT * FROM certificate_designs WHERE id = $1 AND org_id = $2 AND status = 'active'`, [b.design_id, orgId], db);
    if (!d) throw notFound('Design');
    const batch = b.batch_id ? await queryOne(`SELECT b.id, b.name, c.name AS course_name FROM batches b JOIN courses c ON c.id = b.course_id WHERE b.id = $1 AND b.org_id = $2`, [b.batch_id, orgId], db) : null;
    if (b.batch_id && !batch) throw notFound('Batch');
    const ids = await resolveLearnerIds(req.user!, orgId, b.selector, db, MAX_ISSUE + 1);
    if (ids.length > MAX_ISSUE) throw badRequest(`That selects more than ${MAX_ISSUE} learners. Narrow it down.`);
    if (!ids.length) throw badRequest('Nobody matches that selection.');
    const p = new Params(); const L = await query(`SELECT id, full_name FROM learners WHERE org_id = ${p.add(orgId)} AND deleted_at IS NULL AND id IN ${p.in(ids)}`, p.values, db);
    const q = new Params(); const have = new Set((await query(`SELECT learner_id FROM certificates WHERE design_id = ${q.add(d.id)} AND revoked_at IS NULL AND batch_id <=> ${q.add(batch?.id ?? null)} AND learner_id IN ${q.in(ids)}`, q.values, db)).map((r) => r.learner_id));
    const todo = L.filter((l) => !have.has(l.id));
    const date = b.issued_on ?? new Date().toISOString().slice(0, 10);
    if (b.dry_run) return { dry_run: true, selected: L.length, to_issue: todo.length, already_have: have.size, sample: todo.slice(0, 8).map((l) => l.full_name) };
    const org = await queryOne(`SELECT name FROM organizations WHERE id = $1`, [orgId], db);
    let issued = 0;
    for (const l of todo) if (await issueCertificate(db, { orgId, orgName: org?.name ?? '', design: d, learner: l, date, issuedBy: req.user!.id, batch })) issued++;
    await audit({ orgId, actor: req.user, action: 'certificate.issued', entityType: 'certificate_design', entityId: d.id, next: { issued, skipped: L.length - issued }, req }, db);
    return { dry_run: false, selected: L.length, issued, already_have: L.length - issued };
  });
  ok(res, out, undefined, out.dry_run ? 200 : 201);
}));

// ------------------------------------------------------------------ list / revoke / pdf
async function visibleCert(req: Request, id: string) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const c = await queryOne(`SELECT c.*, l.learner_code FROM certificates c JOIN learners l ON l.id = c.learner_id WHERE c.id = ${p.add(id)} AND c.org_id = ${p.add(orgIdOf(req))} ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!c) throw notFound('Certificate');
  return c;
}
const LIST_COLS = `c.id, c.code, c.title, c.recipient_name, c.course_name, c.batch_name, c.issued_on, c.revoked_at, c.revoke_reason, c.learner_id, l.learner_code`;
router.get('/', read, wrap(async (req, res) => {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l'); const w = [`c.org_id = ${p.add(orgIdOf(req))}`]; if (sc) w.push(sc);
  if (typeof req.query.learner_id === 'string') w.push(`c.learner_id = ${p.add(parse(uuid, req.query.learner_id))}`);
  if (typeof req.query.design_id === 'string') w.push(`c.design_id = ${p.add(parse(uuid, req.query.design_id))}`);
  if (typeof req.query.q === 'string' && req.query.q.trim()) { const s = `%${req.query.q.trim().replace(/[%_\\]/g, '\\$&')}%`; w.push(`(c.recipient_name LIKE ${p.add(s)} OR c.code LIKE ${p.add(s)})`); }
  const pg = parse(paging, req.query); const lim = pg.page_size; const offset = (pg.page - 1) * lim;
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM certificates c JOIN learners l ON l.id = c.learner_id WHERE ${w.join(' AND ')}`, p.values))!.n);
  ok(res, await query(`SELECT ${LIST_COLS} FROM certificates c JOIN learners l ON l.id = c.learner_id WHERE ${w.join(' AND ')} ORDER BY c.created_at DESC LIMIT ${lim} OFFSET ${offset}`, p.values), { page: pg.page, page_size: lim, total, total_pages: Math.max(1, Math.ceil(total / lim)) });
}));
router.get('/me', requireAnyPerm('portal:learner', 'portal:parent'), wrap(async (req, res) => {
  const ids = req.user!.access.ownLearnerIds; if (!ids.length) return ok(res, []);
  const p = new Params();
  ok(res, await query(`SELECT ${LIST_COLS} FROM certificates c JOIN learners l ON l.id = c.learner_id WHERE c.org_id = ${p.add(orgIdOf(req))} AND c.learner_id IN ${p.in(ids)} ORDER BY c.created_at DESC LIMIT 200`, p.values));
}));
router.post('/:id/revoke', manage, wrap(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(200) }), req.body); const id = parse(uuid, req.params.id);
  const c = await visibleCert(req, id);
  const r = await exec(`UPDATE certificates SET revoked_at = NOW(3), revoked_by = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL`, [c.id, req.user!.id, b.reason]);
  if (!r.affectedRows) throw conflict('This certificate is already revoked.');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'certificate.revoked', entityType: 'certificate', entityId: c.id, next: { reason: b.reason }, req });
  ok(res, { revoked: true });
}));

async function brandFor(orgId: string, showLogo: boolean) {
  const org = await queryOne(`SELECT name, brand_color, brand_logo_file_id FROM organizations WHERE id = $1`, [orgId]);
  const color = /^#[0-9a-f]{6}$/i.test(org?.brand_color ?? '') ? org!.brand_color : '#12263f';
  const logo = showLogo && org?.brand_logo_file_id ? ((await queryOne(`SELECT data FROM files WHERE id = $1 AND org_id = $2 AND owner_type = 'branding' AND deleted_at IS NULL`, [org.brand_logo_file_id, orgId]))?.data as Buffer | undefined) ?? null : null;
  return { name: org?.name ?? '', color, logo };
}
async function sendPdf(res: any, c: any, brand: { name: string; color: string; logo: Buffer | null }, filename: string) {
  const qr = await QRCode.toBuffer(`${appUrl()}/verify/${c.code}`, { margin: 1, width: 220 });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 50, left: 50, right: 50, bottom: 0 }, info: { Title: `${c.title} - ${c.recipient_name}`, Author: brand.name } });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${filename}"`); res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res);
  drawCertificate(doc, { title: c.title, recipient_name: c.recipient_name, body: c.body, signatory_name: c.signatory_name, signatory_title: c.signatory_title, code: c.code, issued_on: String(c.issued_on), template: c.template ?? 'classic', accent: c.accent ?? null, revoked: !!c.revoked_at }, brand, qr, fmtDate(c.issued_on));
  doc.end();
}
router.get('/:id/pdf', requireAnyPerm('cert:read', 'portal:learner', 'portal:parent'), wrap(async (req, res) => {
  const c = await visibleCert(req, parse(uuid, req.params.id));
  const design = await queryOne(`SELECT show_logo FROM certificate_designs WHERE id = $1`, [c.design_id]);
  await sendPdf(res, c, await brandFor(orgIdOf(req), !!design?.show_logo), `${c.code}.pdf`);
}));

// ------------------------------------------------------------------ preview of a design and automatic issue
router.get('/designs/:id/preview.pdf', read, wrap(async (req, res) => {
  const d = await queryOne(`SELECT * FROM certificate_designs WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req)]);
  if (!d) throw notFound('Design');
  const q = parse(z.object({ template: z.enum(TEMPLATES).optional(), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }), req.query);
  const brand = await brandFor(orgIdOf(req), !!d.show_logo);
  const body = fillBody(d.body_text, { name: 'Sample Learner', course_name: 'Robotics', batch_name: 'Saturday Batch A', date: fmtDate(new Date()), org_name: brand.name });
  await sendPdf(res, { title: d.title_text, recipient_name: 'Sample Learner', body, signatory_name: d.signatory_name, signatory_title: d.signatory_title, code: 'RKC-SAMP-LE00', issued_on: new Date().toISOString().slice(0, 10), template: q.template ?? d.template, accent: q.accent ?? d.accent }, brand, 'preview.pdf');
}));

/** Which batches give a certificate by themselves when they are marked completed. */
router.get('/automation', read, wrap(async (req, res) => {
  const p = new Params(); const sc = batchScope(req.user!, p, 'b');
  ok(res, await query(`SELECT b.id, b.name, b.status, b.completion_certificate_design_id AS design_id, b.completion_certificates_issued_at AS issued_at, (SELECT COUNT(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS learners
    FROM batches b WHERE b.org_id = ${p.add(orgIdOf(req))} AND b.deleted_at IS NULL AND b.status <> 'archived' ${sc ? `AND ${sc}` : ''} ORDER BY b.status, b.name LIMIT 300`, p.values));
}));
router.put('/automation/:batchId', manage, wrap(async (req, res) => {
  const b = parse(z.object({ design_id: uuid.nullable() }), req.body); const orgId = orgIdOf(req); const batchId = parse(uuid, req.params.batchId);
  const room = await queryOne(`SELECT id, status FROM batches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [batchId, orgId]);
  if (!room) throw notFound('Batch');
  if (b.design_id && !(await queryOne(`SELECT 1 FROM certificate_designs WHERE id = $1 AND org_id = $2 AND status = 'active'`, [b.design_id, orgId]))) throw notFound('Design');
  await exec(`UPDATE batches SET completion_certificate_design_id = $3 WHERE id = $1 AND org_id = $2`, [batchId, orgId, b.design_id]);
  await audit({ orgId, actor: req.user, action: 'certificate.automation_set', entityType: 'batch', entityId: batchId, next: { design_id: b.design_id }, req });
  ok(res, { batch_id: batchId, design_id: b.design_id, note: room.status === 'completed' ? 'This batch is already completed. Use Issue to give certificates now.' : null });
}));
export { issueForBatch };
export default router;

// ------------------------------------------------------------------ public verification (minimal fields, no contact details)
export const publicVerify = Router();
publicVerify.get('/verify/:code', limit('verify', 30), wrap(async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!/^RKC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw notFound('Certificate');
  const c = await queryOne(`SELECT c.title, c.recipient_name, c.course_name, c.batch_name, c.issued_on, c.revoked_at, o.name AS org_name FROM certificates c JOIN organizations o ON o.id = c.org_id WHERE c.code = $1`, [code]);
  if (!c) throw notFound('Certificate');
  res.set('Cache-Control', 'no-store');
  ok(res, { valid: !c.revoked_at, status: c.revoked_at ? 'revoked' : 'valid', title: c.title, recipient_name: c.recipient_name, course_name: c.course_name, batch_name: c.batch_name, issued_on: iso(c.issued_on), organization: c.org_name });
}));
