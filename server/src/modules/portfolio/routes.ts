import { Router, type Request } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { notifyAbout } from '../../lib/notify.js';
import { recordActivity } from '../../lib/timeline.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { attachFiles, filesFor } from '../files/store.js';

const router = Router(); // mounted at /api/portfolio
router.use(requireOrg);
const view = requireAnyPerm('classroom:read', 'portfolio:review', 'portal:learner', 'portal:parent');
const review = requirePerm('portfolio:review');
const isReviewer = (req: Request) => req.user!.isSuperAdmin || req.user!.permissions.has('portfolio:review');
const isOwnLearner = (req: Request, learnerId: string) => req.user!.roles.includes('learner') && req.user!.access.ownLearnerIds.includes(learnerId);
const MAX_FILES = 6;

async function visibleLearner(req: Request, id: string) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const l = await queryOne(`SELECT l.id, l.full_name FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!l) throw notFound('Learner');
  return l;
}
async function shape(rows: any[]) {
  const files = await filesFor('portfolio' as any, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, files: files.get(r.id) ?? [] }));
}
const COLS = `i.id, i.learner_id, i.batch_id, i.title, i.description, i.video_url, i.status, i.reject_reason, i.feedback, i.created_at, i.reviewed_at, b.name AS batch_name, l.full_name AS learner_name, fb.full_name AS feedback_by_name`;
const FROM = `portfolio_items i JOIN learners l ON l.id = i.learner_id LEFT JOIN batches b ON b.id = i.batch_id LEFT JOIN users fb ON fb.id = i.feedback_by`;

/** A learner's items. Parents and classmates' families see only what a teacher has published; the learner also sees their own pending and rejected ones. */
router.get('/learners/:id', view, wrap(async (req, res) => {
  const l = await visibleLearner(req, parse(uuid, req.params.id));
  const all = isReviewer(req) || isOwnLearner(req, l.id);
  ok(res, await shape(await query(`SELECT ${COLS} FROM ${FROM} WHERE i.learner_id = $1 AND i.org_id = $2 AND i.deleted_at IS NULL ${all ? '' : `AND i.status = 'published'`} ORDER BY i.created_at DESC LIMIT 200`, [l.id, orgIdOf(req)])));
}));

const videoUrl = z.string().trim().max(500).url().refine((u) => /^https:\/\//i.test(u), 'Use a link that starts with https://');
const addBody = z.object({
  learner_id: uuid.optional(), batch_id: uuid.nullish(), title: z.string().trim().min(2, 'Give the project a title.').max(120), description: z.string().trim().max(1000).nullish(),
  video_url: videoUrl.nullish().or(z.literal('').transform(() => null)), file_ids: z.array(uuid).max(MAX_FILES).default([]),
});
router.post('/', requireAnyPerm('classroom:interact', 'portfolio:review'), limit('portfolio add', 30), wrap(async (req, res) => {
  const b = parse(addBody, req.body); const orgId = orgIdOf(req); const reviewer = isReviewer(req);
  const learnerId = reviewer ? b.learner_id : (req.user!.access.ownLearnerIds.length === 1 ? req.user!.access.ownLearnerIds[0] : b.learner_id);
  if (!learnerId) throw badRequest('Choose the learner.', [{ field: 'learner_id', message: 'Required.' }]);
  const l = await visibleLearner(req, learnerId);
  if (!reviewer && !isOwnLearner(req, l.id)) throw forbidden('Only the learner can add their own project.');
  if (!b.file_ids.length && !b.video_url) throw badRequest('Add at least one photo or a video link.', [{ field: 'file_ids', message: 'A project needs a photo or a video link.' }]);
  const id = newId(); const status = reviewer ? 'published' : 'pending';
  await tx(async (db) => {
    if (b.batch_id && !(await queryOne(`SELECT 1 FROM learner_batch_memberships WHERE learner_id = $1 AND batch_id = $2`, [l.id, b.batch_id], db))) throw badRequest('That batch does not include this learner.');
    if (b.file_ids.length) {
      const fp = new Params();
      const bad = await query(`SELECT id FROM files WHERE id IN ${fp.in(b.file_ids)} AND org_id = ${fp.add(orgId)} AND mime_type NOT LIKE 'image/%' AND mime_type <> 'application/pdf'`, fp.values, db);
      if (bad.length) throw badRequest('Portfolio files must be pictures or a PDF.', [{ field: 'file_ids', message: 'Use JPG, PNG, GIF, WebP or PDF files.' }]);
    }
    await exec(`INSERT INTO portfolio_items (id, org_id, learner_id, batch_id, title, description, video_url, status, submitted_by, reviewed_by, reviewed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, orgId, l.id, b.batch_id ?? null, b.title, b.description ?? null, b.video_url ?? null, status, req.user!.id, reviewer ? req.user!.id : null, reviewer ? new Date() : null], db);
    await attachFiles(db, { orgId, userId: req.user!.id, ownerType: 'portfolio' as any, ownerId: id, fileIds: b.file_ids, max: MAX_FILES });
    if (reviewer) {
      await recordActivity(db, { orgId, learnerId: l.id, type: 'portfolio.published', title: `Project added to the portfolio: ${b.title}`, meta: { item_id: id }, actorUserId: req.user!.id });
      await notifyAbout(db, { orgId, learnerIds: [l.id], kind: 'portfolio.published', title: `New project in ${l.full_name.split(' ')[0]}'s portfolio`, body: b.title, link: '/my-portfolio', excludeUserId: req.user!.id });
    }
    await audit({ orgId, actor: req.user, action: 'portfolio.item_added', entityType: 'portfolio_item', entityId: id, next: { learner_id: l.id, status }, req }, db);
  });
  ok(res, { id, status }, undefined, 201);
}));

router.get('/review', review, wrap(async (req, res) => {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  ok(res, await shape(await query(`SELECT ${COLS} FROM ${FROM} WHERE i.org_id = ${p.add(orgIdOf(req))} AND i.status = 'pending' AND i.deleted_at IS NULL ${sc ? `AND ${sc}` : ''} ORDER BY i.created_at LIMIT 200`, p.values)));
}));

async function loadItem(req: Request, id: string) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const it = await queryOne(`SELECT i.id, i.learner_id, i.title, i.status, i.submitted_by, l.full_name FROM portfolio_items i JOIN learners l ON l.id = i.learner_id WHERE i.id = ${p.add(id)} AND i.org_id = ${p.add(orgIdOf(req))} AND i.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!it) throw notFound('Portfolio item');
  return it;
}

router.post('/:id/review', review, wrap(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(300).nullish() }), req.body); const orgId = orgIdOf(req);
  const it = await loadItem(req, parse(uuid, req.params.id));
  if (b.decision === 'reject' && !b.reason) throw badRequest('Say why, so the learner can fix it.', [{ field: 'reason', message: 'Required when rejecting.' }]);
  await tx(async (db) => {
    const r = await exec(`UPDATE portfolio_items SET status = $2, reviewed_by = $3, reviewed_at = NOW(3), reject_reason = $4 WHERE id = $1 AND status = 'pending'`, [it.id, b.decision === 'approve' ? 'published' : 'rejected', req.user!.id, b.decision === 'reject' ? b.reason : null], db);
    if (!r.affectedRows) throw conflict('This item was already reviewed.', 'ALREADY_REVIEWED');
    if (b.decision === 'approve') {
      await recordActivity(db, { orgId, learnerId: it.learner_id, type: 'portfolio.published', title: `Project added to the portfolio: ${it.title}`, meta: { item_id: it.id }, actorUserId: req.user!.id });
      await notifyAbout(db, { orgId, learnerIds: [it.learner_id], kind: 'portfolio.published', title: `New project in ${it.full_name.split(' ')[0]}'s portfolio`, body: it.title, link: '/my-portfolio', excludeUserId: req.user!.id });
    } else {
      await notifyAbout(db, { orgId, learnerIds: [it.learner_id], kind: 'portfolio.rejected', title: `Your project "${it.title}" needs a change`, body: b.reason ?? null, link: '/my-portfolio', excludeUserId: req.user!.id });
    }
    await audit({ orgId, actor: req.user, action: `portfolio.item_${b.decision === 'approve' ? 'approved' : 'rejected'}`, entityType: 'portfolio_item', entityId: it.id, next: { reason: b.reason ?? null }, req }, db);
  });
  ok(res, { id: it.id, status: b.decision === 'approve' ? 'published' : 'rejected' });
}));

router.put('/:id/feedback', review, wrap(async (req, res) => {
  const b = parse(z.object({ feedback: z.string().trim().max(500) }), req.body); const it = await loadItem(req, parse(uuid, req.params.id));
  await tx(async (db) => {
    await exec(`UPDATE portfolio_items SET feedback = $2, feedback_by = $3 WHERE id = $1`, [it.id, b.feedback || null, req.user!.id], db);
    if (b.feedback) await notifyAbout(db, { orgId: orgIdOf(req), learnerIds: [it.learner_id], kind: 'portfolio.feedback', title: `Your teacher commented on "${it.title}"`, body: b.feedback.slice(0, 200), link: '/my-portfolio', excludeUserId: req.user!.id });
  });
  ok(res, { id: it.id });
}));

router.delete('/:id', view, wrap(async (req, res) => {
  const it = await loadItem(req, parse(uuid, req.params.id));
  if (!isReviewer(req) && !(isOwnLearner(req, it.learner_id))) throw forbidden('Only the learner or a teacher can remove a project.');
  await exec(`UPDATE portfolio_items SET deleted_at = NOW(3) WHERE id = $1`, [it.id]);
  await exec(`UPDATE files SET deleted_at = NOW(3) WHERE owner_type = 'portfolio' AND owner_id = $1 AND deleted_at IS NULL`, [it.id]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'portfolio.item_removed', entityType: 'portfolio_item', entityId: it.id, req });
  ok(res, { id: it.id, deleted: true });
}));

export default router;
