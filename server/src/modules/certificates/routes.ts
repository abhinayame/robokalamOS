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
import { learnerScope } from '../../lib/scope.js';
import { notifyAbout } from '../../lib/notify.js';
import { recordActivity } from '../../lib/timeline.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { resolveLearnerIds, selectorSchema } from '../selection/resolver.js';

const router = Router(); // mounted at /api/certificates
router.use(requireOrg);
const read = requirePerm('cert:read');
const manage = requirePerm('cert:manage');
const MAX_ISSUE = 2000;
const TOKENS = ['name', 'course_name', 'batch_name', 'date', 'org_name'];

/** A code people can read out over the phone: no 0/O/1/I/L. */
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () => { const b = crypto.randomBytes(8); const c = (i: number) => ALPHA[b[i]! % ALPHA.length]!; return `RKC-${c(0)}${c(1)}${c(2)}${c(3)}-${c(4)}${c(5)}${c(6)}${c(7)}`; };
export const fillBody = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => (TOKENS.includes(k) ? (v[k] ?? '') : m)).replace(/\s+/g, ' ').trim();
const fmtDate = (d: string | Date) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// ------------------------------------------------------------------ designs
const designBody = z.object({
  name: z.string().trim().min(2, 'Name the design.').max(120),
  title_text: z.string().trim().min(2).max(120).default('Certificate of Completion'),
  body_text: z.string().trim().min(5).max(600).refine((s) => [...s.matchAll(/\{(\w+)\}/g)].every((m) => TOKENS.includes(m[1]!)), `Only these placeholders work: ${TOKENS.map((t) => `{${t}}`).join(' ')}`),
  signatory_name: z.string().trim().max(120).nullish().transform((v) => v || null), signatory_title: z.string().trim().max(120).nullish().transform((v) => v || null),
  show_logo: z.boolean().default(true),
});
router.get('/designs', read, wrap(async (req, res) => {
  ok(res, await query(`SELECT d.*, (SELECT COUNT(*) FROM certificates c WHERE c.design_id = d.id AND c.revoked_at IS NULL) AS issued FROM certificate_designs d WHERE d.org_id = $1 ORDER BY d.status, d.name`, [orgIdOf(req)]));
}));
router.post('/designs', manage, wrap(async (req, res) => {
  const b = parse(designBody, req.body); const orgId = orgIdOf(req); const id = newId();
  try { await exec(`INSERT INTO certificate_designs (id, org_id, name, title_text, body_text, signatory_name, signatory_title, show_logo, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, orgId, b.name, b.title_text, b.body_text, b.signatory_name, b.signatory_title, b.show_logo, req.user!.id]); }
  catch (e: any) { if (e?.errno === 1062) throw conflict('A design with this name already exists.'); throw e; }
  await audit({ orgId, actor: req.user, action: 'certificate.design_created', entityType: 'certificate_design', entityId: id, req });
  ok(res, { id }, undefined, 201);
}));
router.put('/designs/:id', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const b = parse(designBody.extend({ status: z.enum(['active', 'archived']).default('active') }), req.body); const orgId = orgIdOf(req);
  let r; try { r = await exec(`UPDATE certificate_designs SET name=$3, title_text=$4, body_text=$5, signatory_name=$6, signatory_title=$7, show_logo=$8, status=$9 WHERE id=$1 AND org_id=$2`, [id, orgId, b.name, b.title_text, b.body_text, b.signatory_name, b.signatory_title, b.show_logo, b.status]); }
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
    for (const l of todo) {
      const body = fillBody(d.body_text, { name: l.full_name, course_name: batch?.course_name ?? '', batch_name: batch?.name ?? '', date: fmtDate(date), org_name: org?.name ?? '' });
      const cid = newId();
      for (let attempt = 0; ; attempt++) {
        try {
          await exec(`INSERT INTO certificates (id, org_id, learner_id, batch_id, design_id, code, title, recipient_name, body, course_name, batch_name, signatory_name, signatory_title, issued_on, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [cid, orgId, l.id, batch?.id ?? null, d.id, newCode(), d.title_text, l.full_name, body, batch?.course_name ?? null, batch?.name ?? null, d.signatory_name, d.signatory_title, date, req.user!.id], db);
          break;
        } catch (e: any) { if (e?.errno === 1062 && String(e.message).includes('uq_cert_code') && attempt < 5) continue; if (e?.errno === 1062) { issued--; break; } throw e; }
      }
      issued++;
      await recordActivity(db, { orgId, learnerId: l.id, type: 'certificate.issued', title: `Certificate issued: ${d.title_text}`, meta: { certificate_id: cid }, actorUserId: req.user!.id });
      await notifyAbout(db, { orgId, learnerIds: [l.id], kind: 'certificate.issued', title: 'You received a certificate', body: d.title_text, link: '/my-certificates', excludeUserId: req.user!.id });
    }
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
  ok(res, await query(`SELECT ${LIST_COLS} FROM certificates c JOIN learners l ON l.id = c.learner_id WHERE ${w.join(' AND ')} ORDER BY c.created_at DESC LIMIT ${lim} OFFSET ${offset}`, p.values));
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

router.get('/:id/pdf', requireAnyPerm('cert:read', 'portal:learner', 'portal:parent'), wrap(async (req, res) => {
  const c = await visibleCert(req, parse(uuid, req.params.id)); const orgId = orgIdOf(req);
  const org = await queryOne(`SELECT name, brand_color, brand_logo_file_id FROM organizations WHERE id = $1`, [orgId]);
  const color = /^#[0-9a-f]{6}$/i.test(org?.brand_color ?? '') ? org!.brand_color : '#12263f';
  const design = await queryOne(`SELECT show_logo FROM certificate_designs WHERE id = $1`, [c.design_id]);
  const logo = design?.show_logo && org?.brand_logo_file_id ? (await queryOne(`SELECT data FROM files WHERE id = $1 AND org_id = $2 AND owner_type = 'branding' AND deleted_at IS NULL`, [org.brand_logo_file_id, orgId]))?.data : null;
  const verifyUrl = `${appUrl()}/verify/${c.code}`;
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 220 });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50, info: { Title: `${c.title} - ${c.recipient_name}`, Author: org?.name ?? '' } });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${c.code}.pdf"`); res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res);
  const W = doc.page.width; const H = doc.page.height;
  doc.rect(24, 24, W - 48, H - 48).lineWidth(3).strokeColor(color).stroke(); doc.rect(32, 32, W - 64, H - 64).lineWidth(0.8).stroke();
  if (logo) { try { doc.image(logo, W / 2 - 32, 56, { fit: [64, 64] }); } catch { /* unreadable logo: skip it */ } }
  doc.fillColor(color).font('Helvetica-Bold').fontSize(14).text(org?.name ?? '', 50, logo ? 126 : 70, { align: 'center', width: W - 100 });
  doc.fontSize(34).text(c.title, 50, 160, { align: 'center', width: W - 100 });
  doc.fillColor('#555').font('Helvetica').fontSize(13).text('This is to certify that', 50, 225, { align: 'center', width: W - 100 });
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(30).text(c.recipient_name, 50, 252, { align: 'center', width: W - 100 });
  doc.font('Helvetica').fontSize(14).fillColor('#222').text(c.body, 120, 305, { align: 'center', width: W - 240 });
  if (c.signatory_name) { doc.moveTo(90, H - 120).lineTo(280, H - 120).lineWidth(0.8).strokeColor('#444').stroke(); doc.fontSize(12).font('Helvetica-Bold').text(c.signatory_name, 90, H - 112, { width: 200, align: 'center' }); if (c.signatory_title) doc.font('Helvetica').fontSize(10).fillColor('#555').text(c.signatory_title, 90, H - 96, { width: 200, align: 'center' }); }
  doc.image(qr, W - 150, H - 150, { width: 80 });
  doc.fillColor('#555').font('Helvetica').fontSize(8).text(`Verify: ${c.code}`, W - 170, H - 66, { width: 120, align: 'center' }).text(`Issued ${fmtDate(c.issued_on)}`, W - 170, H - 56, { width: 120, align: 'center' });
  if (c.revoked_at) { doc.save().rotate(-20, { origin: [W / 2, H / 2] }).fillColor('#b00020').opacity(0.25).fontSize(90).font('Helvetica-Bold').text('REVOKED', 0, H / 2 - 50, { align: 'center', width: W }).restore(); }
  doc.end();
}));
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
