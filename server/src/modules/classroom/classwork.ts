import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { recordActivity } from '../../lib/timeline.js';
import { orgIdOf } from '../../middleware/auth.js';
import { attachFiles, filesFor, removeOwnerFiles } from '../files/store.js';
import { assertManage, assertWritable, assignmentState, openRoom, viewedLearner } from './access.js';

const router = Router();
const httpUrl = z.string().trim().max(1000).url().refine((u) => /^https?:\/\//i.test(u), 'Use a link that starts with http:// or https://');

async function topicOk(db: Db, topicId: string | null | undefined, batchId: string) {
  if (!topicId) return;
  if (!(await queryOne(`SELECT 1 FROM topics WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [topicId, batchId], db))) throw badRequest('That topic does not exist in this batch.', [{ field: 'topic_id', message: 'Unknown topic.' }]);
}
async function nextPosition(db: Db, table: 'materials' | 'assignments' | 'topics', batchId: string) {
  const r = await queryOne(`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM ${table} WHERE batch_id = $1 AND deleted_at IS NULL`, [batchId], db);
  return Number(r!.n);
}

// ------------------------------------------------------------------ classwork overview
router.get('/:batchId/classwork', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const q = parse(z.object({ learner_id: uuid.optional() }), req.query);
  const learnerId = viewedLearner(room, q.learner_id);
  const topics = await query(`SELECT id, title, position FROM topics WHERE batch_id = $1 AND deleted_at IS NULL ORDER BY position, created_at, id`, [room.batch.id]);
  const materials = await query(
    `SELECT id, topic_id, title, description, kind, external_url, position, created_at FROM materials WHERE batch_id = $1 AND deleted_at IS NULL ORDER BY position, created_at, id`, [room.batch.id]);
  const assignments = await query(
    `SELECT id, topic_id, title, description, due_at, max_marks, allow_resubmit, position, created_at,
            (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = assignments.id AND s.status IN ('submitted','late')) AS to_review,
            (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = assignments.id AND s.status IN ('submitted','late','evaluated','returned')) AS submitted_count
       FROM assignments WHERE batch_id = $1 AND deleted_at IS NULL ORDER BY position, created_at, id`, [room.batch.id]);
  const files = await filesFor('material', materials.map((m) => m.id));
  const subs = new Map<string, any>();
  if (learnerId && assignments.length) {
    const sp = new Params();
    for (const s of await query(`SELECT assignment_id, status FROM submissions WHERE learner_id = ${sp.add(learnerId)} AND assignment_id IN ${sp.in(assignments.map((a) => a.id))}`, sp.values)) subs.set(s.assignment_id, s);
  }
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [room.batch.id]))!.n);
  ok(res, {
    topics,
    materials: materials.map((m) => ({ ...m, files: files.get(m.id) ?? [] })),
    assignments: assignments.map((a) => ({
      ...a, allow_resubmit: !!a.allow_resubmit, max_marks: Number(a.max_marks),
      ...(room.canManage ? { to_review: Number(a.to_review), submitted_count: Number(a.submitted_count), learners_total: total }
        : { to_review: undefined, submitted_count: undefined, my_status: subs.get(a.id)?.status ?? null, state: learnerId ? assignmentState(a, subs.get(a.id)) : null }),
    })),
    can_manage: room.canManage, writable: room.writable,
  });
}));

// ------------------------------------------------------------------ topics
router.post('/:batchId/topics', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(z.object({ title: z.string().trim().min(1, 'Give the topic a name.').max(200) }), req.body);
  const id = newId();
  await exec(`INSERT INTO topics (id, org_id, batch_id, title, position) VALUES ($1,$2,$3,$4,$5)`, [id, orgIdOf(req), room.batch.id, b.title, await nextPosition(undefined as any, 'topics', room.batch.id)]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'classroom.topic_created', entityType: 'topic', entityId: id, next: { title: b.title, batch: room.batch.batch_code }, req });
  ok(res, { id, title: b.title }, undefined, 201);
}));

router.patch('/:batchId/topics/:topicId', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(z.object({ title: z.string().trim().min(1).max(200) }), req.body);
  const r = await exec(`UPDATE topics SET title = $1 WHERE id = $2 AND batch_id = $3 AND deleted_at IS NULL`, [b.title, parse(uuid, req.params.topicId), room.batch.id]);
  if (!r.affectedRows) throw notFound('Topic');
  ok(res, { id: req.params.topicId, title: b.title });
}));

router.delete('/:batchId/topics/:topicId', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const topicId = parse(uuid, req.params.topicId);
  await tx(async (db) => {
    const r = await exec(`UPDATE topics SET deleted_at = NOW(3) WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [topicId, room.batch.id], db);
    if (!r.affectedRows) throw notFound('Topic');
    // Items are never lost with their topic; they fall back to "No topic".
    await exec(`UPDATE materials SET topic_id = NULL WHERE topic_id = $1`, [topicId], db);
    await exec(`UPDATE assignments SET topic_id = NULL WHERE topic_id = $1`, [topicId], db);
  });
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'classroom.topic_deleted', entityType: 'topic', entityId: topicId, req });
  ok(res, { id: topicId, deleted: true });
}));

// Reorder topics and/or move classwork between topics in one call.
router.post('/:batchId/classwork/reorder', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(z.object({
    topics: z.array(uuid).max(200).optional(),
    items: z.array(z.object({ type: z.enum(['material', 'assignment']), id: uuid, topic_id: uuid.nullable().optional(), position: z.number().int().min(0).max(100000) })).max(500).optional(),
  }), req.body);
  await tx(async (db) => {
    for (const [i, id] of (b.topics ?? []).entries()) await exec(`UPDATE topics SET position = $1 WHERE id = $2 AND batch_id = $3 AND deleted_at IS NULL`, [i + 1, id, room.batch.id], db);
    for (const it of b.items ?? []) {
      if (it.topic_id !== undefined) await topicOk(db, it.topic_id, room.batch.id);
      const table = it.type === 'material' ? 'materials' : 'assignments';
      const r = it.topic_id !== undefined
        ? await exec(`UPDATE ${table} SET position = $1, topic_id = $2 WHERE id = $3 AND batch_id = $4 AND deleted_at IS NULL`, [it.position, it.topic_id, it.id, room.batch.id], db)
        : await exec(`UPDATE ${table} SET position = $1 WHERE id = $2 AND batch_id = $3 AND deleted_at IS NULL`, [it.position, it.id, room.batch.id], db);
      if (!r.affectedRows) throw notFound(it.type === 'material' ? 'Material' : 'Assignment');
    }
  });
  ok(res, { reordered: true });
}));

// ------------------------------------------------------------------ materials
const materialBody = z.object({
  title: z.string().trim().min(1, 'Give the material a title.').max(255),
  description: z.string().trim().max(5000).nullish(),
  kind: z.enum(['pdf', 'ppt', 'doc', 'image', 'link', 'video', 'other']),
  external_url: httpUrl.nullish(),
  file_ids: z.array(uuid).max(1).default([]),
  topic_id: uuid.nullish(),
  post_to_stream: z.boolean().default(true),
});

router.post('/:batchId/materials', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(materialBody, req.body);
  if (!b.external_url && !b.file_ids.length) throw badRequest('Upload a file or add a link.', [{ field: 'external_url', message: 'Add a link or upload a file.' }]);
  if (['link', 'video'].includes(b.kind) && !b.external_url) throw badRequest('Add the link.', [{ field: 'external_url', message: 'This is required.' }]);
  const id = newId(); const orgId = orgIdOf(req);
  await tx(async (db) => {
    await topicOk(db, b.topic_id, room.batch.id);
    await exec(`INSERT INTO materials (id, org_id, batch_id, topic_id, title, description, kind, external_url, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, orgId, room.batch.id, b.topic_id ?? null, b.title, b.description ?? null, b.kind, b.external_url ?? null, await nextPosition(db, 'materials', room.batch.id), req.user!.id], db);
    await attachFiles(db, { orgId, userId: req.user!.id, ownerType: 'material', ownerId: id, fileIds: b.file_ids, max: 1 });
    if (b.file_ids[0]) await exec(`UPDATE materials SET file_id = $1 WHERE id = $2`, [b.file_ids[0], id], db);
    if (b.post_to_stream) {
      await exec(`INSERT INTO classroom_posts (id, org_id, batch_id, author_user_id, kind, title, ref_type, ref_id) VALUES ($1,$2,$3,$4,'material',$5,'material',$6)`,
        [newId(), orgId, room.batch.id, req.user!.id, b.title, id], db);
    }
  });
  await audit({ orgId, actor: req.user, action: 'classroom.material_created', entityType: 'material', entityId: id, next: { title: b.title, kind: b.kind, batch: room.batch.batch_code }, req });
  ok(res, { id }, undefined, 201);
}));

router.patch('/:batchId/materials/:id', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const id = parse(uuid, req.params.id);
  const b = parse(materialBody.partial().omit({ post_to_stream: true }), req.body);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    const cur = await queryOne(`SELECT id, external_url FROM materials WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, room.batch.id], db);
    if (!cur) throw notFound('Material');
    if (b.topic_id !== undefined) await topicOk(db, b.topic_id, room.batch.id);
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of ['title', 'description', 'kind', 'external_url', 'topic_id'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 1}`); }
    if (sets.length) await exec(`UPDATE materials SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals], db);
    if (b.file_ids) {
      await attachFiles(db, { orgId, userId: req.user!.id, ownerType: 'material', ownerId: id, fileIds: b.file_ids, replace: true, max: 1 });
      await exec(`UPDATE materials SET file_id = $1 WHERE id = $2`, [b.file_ids[0] ?? null, id], db);
    }
    if (b.title) await exec(`UPDATE classroom_posts SET title = $1 WHERE ref_type = 'material' AND ref_id = $2`, [b.title, id], db);
  });
  await audit({ orgId, actor: req.user, action: 'classroom.material_updated', entityType: 'material', entityId: id, next: { ...b, file_ids: undefined }, req });
  ok(res, { id });
}));

router.delete('/:batchId/materials/:id', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const id = parse(uuid, req.params.id);
  await tx(async (db) => {
    const r = await exec(`UPDATE materials SET deleted_at = NOW(3) WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [id, room.batch.id], db);
    if (!r.affectedRows) throw notFound('Material');
    await removeOwnerFiles(db, 'material', id);
    await exec(`UPDATE classroom_posts SET deleted_at = NOW(3) WHERE ref_type = 'material' AND ref_id = $1 AND deleted_at IS NULL`, [id], db);
  });
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'classroom.material_deleted', entityType: 'material', entityId: id, req });
  ok(res, { id, deleted: true });
}));

// ------------------------------------------------------------------ assignments (authoring)
const assignmentBody = z.object({
  title: z.string().trim().min(1, 'Give the assignment a title.').max(255),
  description: z.string().trim().max(10_000).nullish(),
  instructions: z.string().trim().max(10_000).nullish(),
  due_at: z.string().datetime({ offset: true }).nullish(),
  max_marks: z.number().positive().max(100000).default(100),
  allow_resubmit: z.boolean().default(false),
  topic_id: uuid.nullish(),
  file_ids: z.array(uuid).max(10).default([]),
  post_to_stream: z.boolean().default(true),
});
const toDb = (iso?: string | null) => (iso ? new Date(iso) : null);

router.post('/:batchId/assignments', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(assignmentBody, req.body);
  const id = newId(); const orgId = orgIdOf(req);
  await tx(async (db) => {
    await topicOk(db, b.topic_id, room.batch.id);
    await exec(`INSERT INTO assignments (id, org_id, batch_id, topic_id, title, description, instructions, due_at, max_marks, allow_resubmit, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, orgId, room.batch.id, b.topic_id ?? null, b.title, b.description ?? null, b.instructions ?? null, toDb(b.due_at), b.max_marks, b.allow_resubmit, await nextPosition(db, 'assignments', room.batch.id), req.user!.id], db);
    await attachFiles(db, { orgId, userId: req.user!.id, ownerType: 'assignment', ownerId: id, fileIds: b.file_ids });
    if (b.post_to_stream) {
      await exec(`INSERT INTO classroom_posts (id, org_id, batch_id, author_user_id, kind, title, ref_type, ref_id) VALUES ($1,$2,$3,$4,'assignment',$5,'assignment',$6)`,
        [newId(), orgId, room.batch.id, req.user!.id, b.title, id], db);
    }
    const members = await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [room.batch.id], db);
    for (const m of members) {
      await recordActivity(db, { orgId, learnerId: m.learner_id, batchId: room.batch.id, type: 'assignment.posted', title: `New assignment: ${b.title}`, meta: { assignment_id: id }, actorUserId: req.user!.id });
    }
  });
  await audit({ orgId, actor: req.user, action: 'assignment.created', entityType: 'assignment', entityId: id, next: { title: b.title, due_at: b.due_at, batch: room.batch.batch_code }, req });
  ok(res, { id }, undefined, 201);
}));

router.patch('/:batchId/assignments/:id', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const id = parse(uuid, req.params.id);
  const b = parse(assignmentBody.partial().omit({ post_to_stream: true }), req.body);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    if (!(await queryOne(`SELECT 1 FROM assignments WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, room.batch.id], db))) throw notFound('Assignment');
    if (b.topic_id !== undefined) await topicOk(db, b.topic_id, room.batch.id);
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of ['title', 'description', 'instructions', 'max_marks', 'allow_resubmit', 'topic_id'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 1}`); }
    if (b.due_at !== undefined) { vals.push(toDb(b.due_at)); sets.push(`due_at = $${vals.length + 1}`); }
    if (sets.length) await exec(`UPDATE assignments SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals], db);
    if (b.file_ids) await attachFiles(db, { orgId, userId: req.user!.id, ownerType: 'assignment', ownerId: id, fileIds: b.file_ids, replace: true });
    if (b.title) await exec(`UPDATE classroom_posts SET title = $1 WHERE ref_type = 'assignment' AND ref_id = $2`, [b.title, id], db);
  });
  await audit({ orgId, actor: req.user, action: 'assignment.updated', entityType: 'assignment', entityId: id, next: { ...b, file_ids: undefined }, req });
  ok(res, { id });
}));

router.delete('/:batchId/assignments/:id', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const id = parse(uuid, req.params.id);
  await tx(async (db) => {
    const r = await exec(`UPDATE assignments SET deleted_at = NOW(3) WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [id, room.batch.id], db);
    if (!r.affectedRows) throw notFound('Assignment');
    await exec(`UPDATE classroom_posts SET deleted_at = NOW(3) WHERE ref_type = 'assignment' AND ref_id = $1 AND deleted_at IS NULL`, [id], db);
  });
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'assignment.deleted', entityType: 'assignment', entityId: id, req });
  ok(res, { id, deleted: true });
}));

export default router;
