import express, { Router, type Request } from 'express';
import { env } from '../../config/env.js';
import { Params, exec, newId, queryOne } from '../../db/pool.js';
import { learnerScope } from '../../lib/scope.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg } from '../../middleware/auth.js';
import { openRoom } from '../classroom/access.js';
import { ALLOWED, inspectFile, sanitizeName, sha256 } from './store.js';

const router = Router();
router.use(requireOrg);

/**
 * Raw upload: `POST /api/files?name=report.pdf` with the file bytes as the body
 * (Content-Type: application/octet-stream). Type is verified from content; size is capped.
 */
router.post('/',
  limit('upload', 40),
  requireAnyPerm('classroom:manage', 'classroom:interact', 'lms:learn'),
  express.raw({ type: () => true, limit: `${env.UPLOAD_MAX_MB}mb` }),
  wrap(async (req, res) => {
    const name = sanitizeName(String(req.query.name ?? ''));
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw badRequest('Send the file bytes as the request body.');
    const info = inspectFile(name, buf);
    const id = newId();
    await exec(
      `INSERT INTO files (id, org_id, uploader_user_id, original_name, mime_type, size_bytes, sha256, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, orgIdOf(req), req.user!.id, name, info.mime, buf.length, sha256(buf), buf]);
    await audit({ orgId: orgIdOf(req), actor: req.user, action: 'file.uploaded', entityType: 'file', entityId: id, next: { name, size: buf.length, mime: info.mime }, req });
    ok(res, { id, name, size: buf.length, mime: info.mime, kind: info.kind }, undefined, 201);
  }));

router.get('/allowed', requireAnyPerm('classroom:read', 'classroom:manage', 'classroom:interact', 'lms:learn'), (_req, res) => ok(res, { extensions: Object.keys(ALLOWED), max_mb: env.UPLOAD_MAX_MB }));

/** Can this caller read the file? Derived from the thing it is attached to, never from the file id alone. */
async function canRead(req: Request, f: { uploader_user_id: string; owner_type: string | null; owner_id: string | null }): Promise<boolean> {
  if (f.uploader_user_id === req.user!.id) return true;
  if (!f.owner_type || !f.owner_id) return false;
  if (f.owner_type === 'portfolio') {
    // visible to anyone who may see the learner, but a pending or rejected item only to the learner and reviewers
    const it = await queryOne(`SELECT learner_id, status FROM portfolio_items WHERE id = $1 AND deleted_at IS NULL`, [f.owner_id]);
    if (!it) return false;
    const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
    if (!(await queryOne(`SELECT 1 FROM learners l WHERE l.id = ${p.add(it.learner_id)} AND l.org_id = ${p.add(orgIdOf(req))} ${sc ? `AND ${sc}` : ''}`, p.values))) return false;
    return it.status === 'published' || req.user!.isSuperAdmin || req.user!.permissions.has('portfolio:review') || (req.user!.roles.includes('learner') && req.user!.access.ownLearnerIds.includes(it.learner_id));
  }
  if (f.owner_type === 'lms_lesson' || f.owner_type === 'lms_submission') {
    const u = req.user!; const orgId = orgIdOf(req);
    const course = f.owner_type === 'lms_lesson'
      ? await queryOne(`SELECT course_id FROM lms_lessons WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [f.owner_id, orgId])
      : await queryOne(`SELECT l.course_id FROM lms_submissions s JOIN lms_lessons l ON l.id = s.lesson_id WHERE s.id = $1 AND s.org_id = $2`, [f.owner_id, orgId]);
    if (!course) return false;
    if (u.isSuperAdmin || u.permissions.has('lms:manage')) return true;                       // authors and reviewers see everything in their courses
    if (f.owner_type === 'lms_submission') return false;                                       // a submission is for its author (the uploader, handled above) and reviewers
    const own = u.roles.includes('learner') ? u.access.ownLearnerIds : [];
    return !!(await queryOne(`SELECT 1 FROM lms_enrollments e WHERE e.course_id = $1 AND e.status <> 'removed' AND (e.user_id = $2 ${own.length ? `OR e.learner_id IN (${own.map((_, i) => `$${i + 3}`).join(',')})` : ''}) LIMIT 1`, [course.course_id, u.id, ...own]));
  }
  let ctx: { batch_id: string; learner_id?: string } | null = null;
  if (f.owner_type === 'material') ctx = await queryOne(`SELECT batch_id FROM materials WHERE id = $1 AND deleted_at IS NULL`, [f.owner_id]);
  else if (f.owner_type === 'assignment') ctx = await queryOne(`SELECT batch_id FROM assignments WHERE id = $1 AND deleted_at IS NULL`, [f.owner_id]);
  else if (f.owner_type === 'submission') ctx = await queryOne(`SELECT a.batch_id, s.learner_id FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = $1`, [f.owner_id]);
  if (!ctx) return false;
  let room;
  try { room = await openRoom(req, ctx.batch_id); } catch { return false; }
  if (f.owner_type === 'submission') return room.canManage || req.user!.access.ownLearnerIds.includes(ctx.learner_id!);
  return true;
}

router.get('/:id', requireAnyPerm('classroom:read', 'classroom:manage', 'classroom:interact', 'lms:learn'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const f = await queryOne(
    `SELECT id, uploader_user_id, owner_type, owner_id, original_name, mime_type, size_bytes, data FROM files WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [id, orgIdOf(req)]);
  if (!f || !(await canRead(req, f))) throw notFound('File');
  const ext = f.original_name.includes('.') ? f.original_name.split('.').pop()!.toLowerCase() : '';
  const inline = req.query.inline === '1' && ALLOWED[ext]?.inline;
  res.setHeader('Content-Type', f.mime_type);
  res.setHeader('Content-Length', String(f.data.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");   // an uploaded file can never run script
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.send(f.data);
}));

/** Remove a file you uploaded that is not attached to anything yet. */
router.delete('/:id', requireAnyPerm('classroom:manage', 'classroom:interact', 'lms:learn'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const r = await exec(`UPDATE files SET deleted_at = NOW(3) WHERE id = $1 AND org_id = $2 AND uploader_user_id = $3 AND owner_type IS NULL AND deleted_at IS NULL`, [id, orgIdOf(req), req.user!.id]);
  if (!r.affectedRows) throw notFound('File');
  ok(res, { id, deleted: true });
}));

export default router;
