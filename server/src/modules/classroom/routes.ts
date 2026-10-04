import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { batchScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { filesFor } from '../files/store.js';
import { assertManage, assertWritable, assignmentState, openRoom, viewedLearner } from './access.js';
import classwork from './classwork.js';

const router = Router();
router.use(requireOrg);
router.use(requirePerm('classroom:read'));

const httpUrl = z.string().trim().max(1000).url().refine((u) => /^https?:\/\//i.test(u), 'Use a link that starts with http:// or https://');
const STAFF_ROLES = `('org_admin','branch_admin','teacher','super_admin')`;
const isStaffSql = (col: string) => `EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${col} AND r.code IN ${STAFF_ROLES})`;

// ------------------------------------------------------------------ my classrooms
router.get('/', wrap(async (req, res) => {
  const user = req.user!;
  const orgId = orgIdOf(req);
  const q = parse(z.object({ include_completed: z.coerce.boolean().optional() }), req.query);
  const p = new Params();
  const where = [`b.org_id = ${p.add(orgId)}`, 'b.deleted_at IS NULL', q.include_completed ? `b.status <> 'archived'` : `b.status IN ('active','upcoming')`];
  const scope = batchScope(user, p, 'b');
  if (scope) where.push(scope);
  const own = user.access.ownLearnerIds;
  const pendingWork = own.length
    ? `(SELECT COUNT(*) FROM assignments a WHERE a.batch_id = b.id AND a.deleted_at IS NULL AND EXISTS (SELECT 1 FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active' AND m.learner_id IN ${p.in(own)})
        AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id = a.id AND s.learner_id IN ${p.in(own)} AND s.status IN ('submitted','late','evaluated')))`
    : '0';
  const rows = await query(
    `SELECT b.id, b.name, b.batch_code, b.status, b.schedule, c.name AS course_name, pr.name AS program_name,
            (SELECT COUNT(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS active_learners,
            (SELECT COUNT(*) FROM assignments a WHERE a.batch_id = b.id AND a.deleted_at IS NULL) AS assignments_total,
            (SELECT COUNT(*) FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE a.batch_id = b.id AND a.deleted_at IS NULL AND s.status IN ('submitted','late')) AS pending_review,
            ${pendingWork} AS pending_work,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', u.id, 'full_name', u.full_name, 'role', t.role))
               FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id WHERE t.batch_id = b.id AND t.status = 'active') AS teachers
       FROM batches b JOIN courses c ON c.id = b.course_id JOIN programs pr ON pr.id = b.program_id
      WHERE ${where.join(' AND ')} ORDER BY b.name LIMIT 200`, p.values);
  ok(res, rows.map((r) => ({ ...r, teachers: [...(r.teachers ?? [])].sort((a: any, b: any) => (a.role === b.role ? 0 : a.role === 'lead' ? -1 : 1)) })));
}));

// ------------------------------------------------------------------ overview & people
router.get('/:batchId', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const teachers = await query(
    `SELECT u.id, u.full_name, t.role FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id
      WHERE t.batch_id = $1 AND t.status = 'active' ORDER BY t.role = 'lead' DESC, u.full_name`, [room.batch.id]);
  const counts = await queryOne(
    `SELECT (SELECT COUNT(*) FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active') AS learners,
            (SELECT COUNT(*) FROM assignments WHERE batch_id = $1 AND deleted_at IS NULL) AS assignments,
            (SELECT COUNT(*) FROM materials WHERE batch_id = $1 AND deleted_at IS NULL) AS materials`, [room.batch.id]);
  const course = await queryOne(`SELECT c.name AS course_name, p.name AS program_name FROM courses c JOIN programs p ON p.id = c.program_id WHERE c.id = $1`, [room.batch.course_id]);
  ok(res, { ...room.batch, ...course, teachers, counts, can_manage: room.canManage, can_interact: room.canInteract, writable: room.writable, my_learner_ids: room.learnerIds });
}));

router.get('/:batchId/people', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const teachers = await query(
    `SELECT u.id, u.full_name, t.role FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id
      WHERE t.batch_id = $1 AND t.status = 'active' ORDER BY t.role = 'lead' DESC, u.full_name`, [room.batch.id]);
  // Staff see ids and codes; learners and parents only see classmates' names (no contact details, ever).
  const learners = await query(
    `SELECT l.id, l.full_name, ${room.canManage ? 'l.learner_code,' : ''} 1 AS active FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id
      WHERE m.batch_id = $1 AND m.status = 'active' AND l.deleted_at IS NULL AND l.status = 'active' ORDER BY l.full_name, l.id LIMIT 500`, [room.batch.id]);
  ok(res, { teachers, learners: learners.map(({ active, ...l }) => l), can_manage: room.canManage });
}));

// ------------------------------------------------------------------ stream
router.get('/:batchId/stream', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(50).default(20), learner_id: uuid.optional() }), req.query);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM classroom_posts WHERE batch_id = $1 AND deleted_at IS NULL`, [room.batch.id]))!.n);
  const posts = await query(
    `SELECT p.id, p.kind, p.title, p.body, p.url, p.ref_type, p.ref_id, p.pinned, p.comments_enabled, p.created_at, p.author_user_id,
            u.full_name AS author_name, ${isStaffSql('p.author_user_id')} AS author_is_staff,
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
       FROM classroom_posts p JOIN users u ON u.id = p.author_user_id
      WHERE p.batch_id = $1 AND p.deleted_at IS NULL ORDER BY p.pinned DESC, p.created_at DESC, p.id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, [room.batch.id]);

  // Resolve what system posts announce (assignment / material), skipping anything since deleted.
  const aIds = posts.filter((x) => x.ref_type === 'assignment').map((x) => x.ref_id);
  const mIds = posts.filter((x) => x.ref_type === 'material').map((x) => x.ref_id);
  const learnerId = viewedLearner(room, q.learner_id);
  const assignments = new Map<string, any>();
  if (aIds.length) {
    const ap = new Params();
    for (const a of await query(`SELECT id, title, due_at, max_marks FROM assignments WHERE id IN ${ap.in(aIds)} AND deleted_at IS NULL`, ap.values)) assignments.set(a.id, a);
  }
  const subs = new Map<string, any>();
  if (aIds.length && learnerId) {
    const sp = new Params();
    for (const s of await query(`SELECT assignment_id, status FROM submissions WHERE learner_id = ${sp.add(learnerId)} AND assignment_id IN ${sp.in(aIds)}`, sp.values)) subs.set(s.assignment_id, s);
  }
  const materials = new Map<string, any>();
  if (mIds.length) {
    const mp = new Params();
    for (const m of await query(`SELECT id, title, kind, external_url FROM materials WHERE id IN ${mp.in(mIds)} AND deleted_at IS NULL`, mp.values)) materials.set(m.id, m);
  }
  const files = await filesFor('material', [...materials.keys()]);

  const items = posts.map((x) => {
    let ref: any = null;
    if (x.ref_type === 'assignment') {
      const a = assignments.get(x.ref_id);
      ref = a ? { type: 'assignment', ...a, state: learnerId ? assignmentState(a, subs.get(a.id)) : null } : { type: 'removed' };
    } else if (x.ref_type === 'material') {
      const m = materials.get(x.ref_id);
      ref = m ? { type: 'material', ...m, file: files.get(m.id)?.[0] ?? null } : { type: 'removed' };
    }
    const { ref_type, ref_id, author_user_id, author_name, author_is_staff, ...post } = x;
    return { ...post, pinned: !!post.pinned, comments_enabled: !!post.comments_enabled, author: { id: author_user_id, name: author_name, is_staff: !!author_is_staff }, ref, can_edit: room.canManage };
  }).filter((x) => x.ref?.type !== 'removed');
  ok(res, items, { page: q.page, page_size: q.page_size, total });
}));

const postBody = z.object({
  kind: z.enum(['announcement', 'link']),
  title: z.string().trim().max(255).optional(),
  body: z.string().trim().max(10_000).optional(),
  url: httpUrl.optional(),
  comments_enabled: z.boolean().default(true),
  pinned: z.boolean().default(false),
});

router.post('/:batchId/posts', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(postBody, req.body);
  if (b.kind === 'announcement' && !b.body) throw badRequest('Write something to announce.', [{ field: 'body', message: 'This is required.' }]);
  if (b.kind === 'link' && !b.url) throw badRequest('Add the link.', [{ field: 'url', message: 'This is required.' }]);
  const id = newId();
  await exec(`INSERT INTO classroom_posts (id, org_id, batch_id, author_user_id, kind, title, body, url, comments_enabled, pinned) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, orgIdOf(req), room.batch.id, req.user!.id, b.kind, b.title ?? null, b.body ?? null, b.url ?? null, b.comments_enabled, b.pinned]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'classroom.post_created', entityType: 'classroom_post', entityId: id, next: { batch: room.batch.batch_code, kind: b.kind }, req });
  ok(res, { id }, undefined, 201);
}));

router.patch('/:batchId/posts/:postId', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room);
  const postId = parse(uuid, req.params.postId);
  const b = parse(postBody.partial().omit({ kind: true }), req.body);
  const post = await queryOne(`SELECT id, kind FROM classroom_posts WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [postId, room.batch.id]);
  if (!post) throw notFound('Post');
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of ['title', 'body', 'url', 'comments_enabled', 'pinned'] as const) {
    if (b[k] !== undefined) { if (['title', 'body', 'url'].includes(k) && post.kind !== 'announcement' && post.kind !== 'link') continue; vals.push(b[k]); sets.push(`${k} = $${vals.length + 1}`); }
  }
  if (sets.length) await exec(`UPDATE classroom_posts SET ${sets.join(', ')} WHERE id = $1`, [postId, ...vals]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'classroom.post_updated', entityType: 'classroom_post', entityId: postId, next: b, req });
  ok(res, { id: postId });
}));

router.delete('/:batchId/posts/:postId', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room);
  const postId = parse(uuid, req.params.postId);
  const r = await exec(`UPDATE classroom_posts SET deleted_at = NOW(3) WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [postId, room.batch.id]);
  if (!r.affectedRows) throw notFound('Post');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'classroom.post_deleted', entityType: 'classroom_post', entityId: postId, req });
  ok(res, { id: postId, deleted: true });
}));

// ------------------------------------------------------------------ comments
router.get('/:batchId/posts/:postId/comments', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const postId = parse(uuid, req.params.postId);
  if (!(await queryOne(`SELECT 1 FROM classroom_posts WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [postId, room.batch.id]))) throw notFound('Post');
  const rows = await query(
    `SELECT c.id, c.parent_comment_id, c.body, c.created_at, c.author_user_id, u.full_name AS author_name, ${isStaffSql('c.author_user_id')} AS author_is_staff
       FROM comments c JOIN users u ON u.id = c.author_user_id WHERE c.post_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at, c.id LIMIT 500`, [postId]);
  ok(res, rows.map((c) => ({ id: c.id, parent_comment_id: c.parent_comment_id, body: c.body, created_at: c.created_at,
    author: { id: c.author_user_id, name: c.author_name, is_staff: !!c.author_is_staff }, can_delete: room.canManage || c.author_user_id === req.user!.id })));
}));

router.post('/:batchId/posts/:postId/comments', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  if (!room.canManage && !room.canInteract) throw badRequest('Only the teachers and learners of this batch can comment.');
  assertWritable(room);
  const postId = parse(uuid, req.params.postId);
  const b = parse(z.object({ body: z.string().trim().min(1, 'Write a comment.').max(2000), parent_comment_id: uuid.optional() }), req.body);
  const post = await queryOne(`SELECT comments_enabled FROM classroom_posts WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [postId, room.batch.id]);
  if (!post) throw notFound('Post');
  if (!post.comments_enabled) throw badRequest('Comments are turned off for this post.');
  if (b.parent_comment_id && !(await queryOne(`SELECT 1 FROM comments WHERE id = $1 AND post_id = $2 AND deleted_at IS NULL`, [b.parent_comment_id, postId]))) throw notFound('Comment');
  const id = newId();
  await exec(`INSERT INTO comments (id, org_id, post_id, parent_comment_id, author_user_id, body) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, orgIdOf(req), postId, b.parent_comment_id ?? null, req.user!.id, b.body]);
  ok(res, { id }, undefined, 201);
}));

router.delete('/:batchId/comments/:commentId', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const commentId = parse(uuid, req.params.commentId);
  const c = await queryOne(`SELECT c.id, c.author_user_id FROM comments c JOIN classroom_posts p ON p.id = c.post_id WHERE c.id = $1 AND p.batch_id = $2 AND c.deleted_at IS NULL`, [commentId, room.batch.id]);
  if (!c) throw notFound('Comment');
  if (!room.canManage && c.author_user_id !== req.user!.id) throw notFound('Comment');
  await exec(`UPDATE comments SET deleted_at = NOW(3) WHERE id = $1`, [commentId]);
  ok(res, { id: commentId, deleted: true });
}));

router.use('/', classwork);
export default router;
