import { Router, type Request } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { appUrl } from '../../lib/appurl.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { assertManage, openRoom } from '../classroom/access.js';
import { queueMessage, validEmail } from '../email/outbox.js';
import { isConfigured as emailConfigured } from '../email/provider.js';
import { orgInfo } from '../fees/service.js';
import { todayIn } from '../fees/money.js';
import { resolveLearnerIds, selectorSchema } from '../selection/resolver.js';
import { buildReport, monthOk, prevMonth, type Report } from './report.js';

const router = Router(); // mounted at /api/progress
router.use(requireOrg);
const view = requireAnyPerm('classroom:read', 'report:read', 'portal:learner', 'portal:parent');
const manage = requirePerm('classroom:manage');
const monthQ = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.');

async function visibleLearner(req: Request, id: string) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const l = await queryOne(`SELECT l.id, l.full_name, l.learner_code FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!l) throw notFound('Learner');
  return l;
}
const thisMonth = (tz: string) => todayIn(tz).slice(0, 7);

router.get('/me', view, wrap(async (req, res) => {
  const ids = req.user!.access.ownLearnerIds; if (!ids.length) return ok(res, []);
  const p = new Params();
  ok(res, await query(`SELECT id, full_name FROM learners WHERE org_id = ${p.add(orgIdOf(req))} AND deleted_at IS NULL AND id IN ${p.in(ids)} ORDER BY full_name`, p.values));
}));

router.get('/learners/:id/report', view, wrap(async (req, res) => {
  const l = await visibleLearner(req, parse(uuid, req.params.id)); const org = await orgInfo(orgIdOf(req));
  const month = req.query.month === undefined ? prevMonth(thisMonth(org.tz)) : parse(monthQ, req.query.month);
  ok(res, await buildReport(orgIdOf(req), l.id, month, org.tz));
}));

router.get('/learners/:id/report.pdf', view, limit('report pdf', 30), wrap(async (req, res) => {
  const orgId = orgIdOf(req); const l = await visibleLearner(req, parse(uuid, req.params.id)); const org = await orgInfo(orgId);
  const month = parse(monthQ, req.query.month); const r = (await buildReport(orgId, l.id, month, org.tz))!;
  const brand = await queryOne(`SELECT COALESCE(brand_app_name, name) AS name, brand_color, brand_logo_file_id FROM organizations WHERE id = $1`, [orgId]);
  const color = /^#[0-9a-f]{6}$/i.test(brand?.brand_color ?? '') ? brand!.brand_color : '#12263f';
  const logo = brand?.brand_logo_file_id ? (await queryOne(`SELECT data FROM files WHERE id = $1 AND org_id = $2 AND owner_type = 'branding' AND deleted_at IS NULL`, [brand.brand_logo_file_id, orgId]))?.data : null;
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Progress report ${month} - ${l.full_name}`, Author: brand?.name ?? '' } });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="progress-${month}-${l.learner_code}.pdf"`); res.setHeader('Cache-Control', 'private, no-store');
  doc.pipe(res); pdfReport(doc, r, brand?.name ?? '', color, logo, new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
  doc.end();
}));

function pdfReport(doc: PDFKit.PDFDocument, r: Report, orgName: string, color: string, logo: Buffer | null | undefined, label: string) {
  const W = doc.page.width - 96;
  if (logo) { try { doc.image(logo, 48, 40, { fit: [44, 44] }); } catch { /* skip unreadable logo */ } }
  doc.fillColor(color).font('Helvetica-Bold').fontSize(18).text(orgName, logo ? 100 : 48, 46, { width: W - 60 });
  doc.fillColor('#555').font('Helvetica').fontSize(11).text('Monthly progress report', logo ? 100 : 48, 70);
  doc.moveTo(48, 98).lineTo(48 + W, 98).lineWidth(2).strokeColor(color).stroke();
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(20).text(r.learner.full_name, 48, 112); doc.font('Helvetica').fontSize(11).fillColor('#555').text(`${label}  ·  ${r.learner.learner_code}`, 48, 138);
  let y = 168;
  const h = (t: string) => { doc.fillColor(color).font('Helvetica-Bold').fontSize(13).text(t, 48, y); y += 22; doc.fillColor('#222').font('Helvetica').fontSize(11); };
  const line = (t: string, bold = false) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(t, 58, y, { width: W - 20 }); y = doc.y + 4; };
  const tile = (x: number, big: string, small: string) => { doc.roundedRect(x, y, 118, 54, 6).fillColor('#f3f6fa').fill(); doc.fillColor(color).font('Helvetica-Bold').fontSize(18).text(big, x + 8, y + 8, { width: 102 }); doc.fillColor('#555').font('Helvetica').fontSize(9).text(small, x + 8, y + 33, { width: 102 }); };
  tile(48, r.attendance.overall_pct == null ? '—' : `${r.attendance.overall_pct}%`, 'Attendance'); tile(176, r.scores.average_pct == null ? '—' : `${r.scores.average_pct}%`, 'Average score');
  tile(304, r.assignments.due ? `${r.assignments.done}/${r.assignments.due}` : '—', 'Assignments done'); tile(432, `${r.xp_earned >= 0 ? '+' : ''}${r.xp_earned}`, 'XP earned'); y += 74;
  h('Attendance');
  if (!r.attendance.batches.length) line('No classes were marked this month.'); for (const b of r.attendance.batches) line(`${b.batch_name}: present ${b.present}, late ${b.late}, absent ${b.absent}${b.excused ? `, excused ${b.excused}` : ''}${b.pct == null ? '' : `  (${b.pct}%)`}`);
  y += 6; h('Scores');
  if (!r.scores.items.length) line('No scores were recorded this month.'); for (const s of r.scores.items.slice(0, 12)) line(`${s.name} (${s.batch_name}): ${s.score}/${s.max_score}`);
  if (r.scores.change !== null) line(`Compared with last month: ${r.scores.change >= 0 ? '+' : ''}${r.scores.change} points.`, true);
  y += 6; h('Badges earned'); line(r.badges.length ? r.badges.join(', ') : 'No badges this month.');
  y += 6; h('Teacher notes');
  if (!r.notes.length) line('No notes from teachers this month.'); for (const n of r.notes) { line(`${n.teacher} (${n.batch_name}):`, true); line(n.body); }
  doc.fillColor('#888').fontSize(8).text('Generated from the attendance, score and activity records of the learning platform.', 48, doc.page.height - 56, { width: W, align: 'center' });
}

// ---- teacher notes
router.get('/batches/:batchId/notes', manage, wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId)); assertManage(room);
  const org = await orgInfo(orgIdOf(req)); const month = req.query.month === undefined ? prevMonth(thisMonth(org.tz)) : parse(monthQ, req.query.month);
  const rows = await query(`SELECT l.id AS learner_id, l.full_name, l.learner_code,
      (SELECT n.body FROM progress_notes n WHERE n.learner_id = l.id AND n.batch_id = $1 AND n.month = $2 AND n.author_user_id = $3) AS my_note,
      (SELECT COUNT(*) FROM progress_notes n WHERE n.learner_id = l.id AND n.batch_id = $1 AND n.month = $2 AND n.author_user_id <> $3) AS others
    FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id AND l.deleted_at IS NULL WHERE m.batch_id = $1 AND m.status = 'active' ORDER BY l.full_name`, [room.batch.id, month, req.user!.id]);
  ok(res, { batch: { id: room.batch.id, name: room.batch.name }, month, learners: rows.map((r) => ({ ...r, others: Number(r.others) })) });
}));

router.put('/notes', manage, limit('progress note', 120), wrap(async (req, res) => {
  const b = parse(z.object({ learner_id: uuid, batch_id: uuid, month: monthQ, body: z.string().trim().max(1000) }), req.body); const orgId = orgIdOf(req);
  const room = await openRoom(req, b.batch_id); assertManage(room);
  const org = await orgInfo(orgId); if (b.month > thisMonth(org.tz)) throw badRequest('That month has not started yet.', [{ field: 'month', message: 'Pick this month or an earlier one.' }]);
  if (!(await queryOne(`SELECT 1 FROM learner_batch_memberships WHERE batch_id = $1 AND learner_id = $2`, [b.batch_id, b.learner_id]))) throw notFound('Learner');
  if (!b.body) await exec(`DELETE FROM progress_notes WHERE learner_id = $1 AND batch_id = $2 AND month = $3 AND author_user_id = $4`, [b.learner_id, b.batch_id, b.month, req.user!.id]);
  else await exec(`INSERT INTO progress_notes (id, org_id, learner_id, batch_id, month, body, author_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON DUPLICATE KEY UPDATE body = VALUES(body)`, [newId(), orgId, b.learner_id, b.batch_id, b.month, b.body, req.user!.id]);
  await audit({ orgId, actor: req.user, action: b.body ? 'progress.note_saved' : 'progress.note_removed', entityType: 'learner', entityId: b.learner_id, next: { batch_id: b.batch_id, month: b.month }, req });
  ok(res, { saved: !!b.body });
}));

// ---- send reports to parents
const MAX_SEND = 1000;
router.post('/send', requirePerm('comms:announce'), limit('progress send', 10), wrap(async (req, res) => {
  const b = parse(z.object({ month: monthQ, selector: selectorSchema, dry_run: z.boolean().default(false), confirm: z.boolean().optional() }), req.body); const orgId = orgIdOf(req);
  if (!b.dry_run && b.confirm !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Review who will get the report and confirm.');
  if (!b.dry_run && !emailConfigured()) throw new AppError(409, 'NOT_CONFIGURED', 'E-mail is not connected yet. An admin needs to set the SMTP details on the server.');
  const org = await orgInfo(orgId); if (b.month > thisMonth(org.tz)) throw badRequest('That month has not started yet.');
  const ids = await resolveLearnerIds(req.user!, orgId, b.selector, undefined, MAX_SEND + 1);
  if (ids.length > MAX_SEND) throw badRequest(`That selects more than ${MAX_SEND} learners. Narrow it down.`);
  if (!ids.length) throw badRequest('Nobody matches that selection.');
  const brand = await queryOne(`SELECT COALESCE(brand_app_name, name) AS name, brand_color FROM organizations WHERE id = $1`, [orgId]);
  const out = { selected: ids.length, to_send: 0, sent: 0, no_activity: 0, no_email: 0, already_sent: 0, opted_out: 0, emailing: emailConfigured() };
  const label = new Date(`${b.month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  for (const id of ids) {
    const r = await buildReport(orgId, id, b.month, org.tz); if (!r) continue;
    if (!r.has_data) { out.no_activity++; continue; }
    const parent = await queryOne(`SELECT pa.full_name, pa.email FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL WHERE lp.learner_id = $1 AND pa.email IS NOT NULL ORDER BY lp.is_primary DESC, lp.created_at LIMIT 1`, [id]);
    const learner = await queryOne(`SELECT email FROM learners WHERE id = $1`, [id]);
    const to = [parent?.email, learner?.email].find((e) => validEmail(e)) as string | undefined;
    if (!to) { out.no_email++; continue; }
    const key = `progress:${id}:${b.month}`;
    if (await queryOne(`SELECT 1 FROM email_outbox WHERE dedupe_key = $1`, [key])) { out.already_sent++; continue; }
    if (b.dry_run) { out.to_send++; continue; }
    const first = r.learner.full_name.split(/\s+/)[0];
    const facts = [r.attendance.overall_pct == null ? null : `Attendance ${r.attendance.overall_pct}%`, r.scores.average_pct == null ? null : `average score ${r.scores.average_pct}%`, r.assignments.due ? `${r.assignments.done} of ${r.assignments.due} assignments done` : null, r.xp_earned ? `${r.xp_earned > 0 ? '+' : ''}${r.xp_earned} XP` : null, r.badges.length ? `${r.badges.length} new badge(s)` : null].filter(Boolean);
    const qid = await queueMessage({ orgId, orgName: brand?.name ?? org.name, color: brand?.brand_color ?? undefined, to, toName: parent?.full_name, learnerId: id, category: 'notification', dedupeKey: key,
      subject: `${first}'s progress report for ${label}`, title: `${first}'s progress in ${label}`,
      paragraphs: [`Hi ${parent?.full_name ?? 'there'}, here is how ${r.learner.full_name} did in ${label}.`, `${facts.join(' · ')}.`, ...(r.notes[0] ? [`Teacher note (${r.notes[0].teacher}): ${r.notes[0].body}`] : []), 'Open the full report, with every class and score, from the link below.'],
      button: { label: 'View the full report', url: `${appUrl()}/my-report?learner=${id}&month=${b.month}` } });
    if (qid) out.sent++; else out.opted_out++;
  }
  if (!b.dry_run) await audit({ orgId, actor: req.user, action: 'progress.reports_sent', entityType: 'organization', entityId: orgId, next: { month: b.month, ...out }, req });
  ok(res, { dry_run: b.dry_run, month: b.month, ...out }, undefined, b.dry_run ? 200 : 201);
}));

export default router;
