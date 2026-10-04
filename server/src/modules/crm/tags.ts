import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import type { Request } from 'express';

export const tagsRouter = Router();
tagsRouter.use(requireOrg, requirePerm('tag:read'));
const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
const tagBody = z.object({ name: z.string().trim().min(1, 'Name the tag.').max(80), color: z.enum(COLORS).default('gray'), description: z.string().trim().max(200).nullish() });
const dup = (e: any) => { if (e?.errno === 1062) throw conflict('A tag with that name already exists.', 'DUPLICATE_TAG'); throw e; };

/** Learners of the caller's scope among `ids`; anything else is 404 (never reveal other learners). */
export async function scopedLearnerIds(req: Request, ids: string[], db?: Db): Promise<string[]> {
  const uniq = [...new Set(ids)];
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const ok2 = new Set((await query(`SELECT l.id FROM learners l WHERE l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL AND l.id IN ${p.in(uniq)} ${sc ? `AND ${sc}` : ''}`, p.values, db)).map((r) => r.id as string));
  if (uniq.some((i) => !ok2.has(i))) throw notFound('Learner');
  return uniq;
}

/** Add or remove tags for learners. De-duplicated, idempotent; returns how many rows really changed. */
export async function applyTags(db: Db, req: Request, a: { learnerIds: string[]; add?: string[]; remove?: string[] }) {
  const orgId = orgIdOf(req); let added = 0; let removed = 0;
  const all = [...(a.add ?? []), ...(a.remove ?? [])];
  if (all.length) {
    const p = new Params();
    const found = await query(`SELECT id FROM tags WHERE org_id = ${p.add(orgId)} AND id IN ${p.in([...new Set(all)])}`, p.values, db);
    if (found.length !== new Set(all).size) throw notFound('Tag');
  }
  for (const tag of new Set(a.add ?? [])) {
    for (let i = 0; i < a.learnerIds.length; i += 500) {
      const p = new Params();
      const r = await exec(`INSERT IGNORE INTO learner_tags (learner_id, tag_id, org_id, added_by) SELECT l.id, ${p.add(tag)}, ${p.add(orgId)}, ${p.add(req.user!.id)} FROM learners l WHERE l.id IN ${p.in(a.learnerIds.slice(i, i + 500))} AND l.org_id = ${p.add(orgId)}`, p.values, db);
      added += r.affectedRows;
    }
  }
  for (const tag of new Set(a.remove ?? [])) {
    for (let i = 0; i < a.learnerIds.length; i += 500) {
      const p = new Params();
      const r = await exec(`DELETE FROM learner_tags WHERE tag_id = ${p.add(tag)} AND org_id = ${p.add(orgId)} AND learner_id IN ${p.in(a.learnerIds.slice(i, i + 500))}`, p.values, db);
      removed += r.affectedRows;
    }
  }
  return { added, removed };
}

tagsRouter.get('/', wrap(async (req, res) => {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const rows = await query(
    `SELECT t.id, t.name, t.color, t.description,
            (SELECT COUNT(*) FROM learner_tags lt JOIN learners l ON l.id = lt.learner_id AND l.deleted_at IS NULL WHERE lt.tag_id = t.id ${sc ? `AND ${sc}` : ''}) AS learners
       FROM tags t WHERE t.org_id = ${p.add(orgIdOf(req))} ORDER BY t.name LIMIT 500`, p.values);
  ok(res, rows.map((r) => ({ ...r, learners: Number(r.learners) })));
}));

tagsRouter.post('/', requirePerm('tag:manage'), wrap(async (req, res) => {
  const b = parse(tagBody, req.body); const id = newId();
  await exec(`INSERT INTO tags (id, org_id, name, color, description, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, orgIdOf(req), b.name, b.color, b.description ?? null, req.user!.id]).catch(dup);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'tag.created', entityType: 'tag', entityId: id, next: b, req });
  ok(res, { id }, undefined, 201);
}));

tagsRouter.patch('/:id', requirePerm('tag:manage'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const b = parse(tagBody.partial(), req.body);
  if (!(await queryOne(`SELECT 1 FROM tags WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req)]))) throw notFound('Tag');
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of ['name', 'color', 'description'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 2}`); }
  if (sets.length) await exec(`UPDATE tags SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req), ...vals]).catch(dup);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'tag.updated', entityType: 'tag', entityId: id, next: b, req });
  ok(res, { id });
}));

tagsRouter.delete('/:id', requirePerm('tag:manage'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  const t = await queryOne(`SELECT name, (SELECT COUNT(*) FROM learner_tags WHERE tag_id = tags.id) AS n FROM tags WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!t) throw notFound('Tag');
  await exec(`DELETE FROM tags WHERE id = $1 AND org_id = $2`, [id, orgId]);   // learner_tags rows cascade
  await audit({ orgId, actor: req.user, action: 'tag.deleted', entityType: 'tag', entityId: id, previous: { name: t.name, learners: Number(t.n) }, req });
  ok(res, { id, deleted: true, learners_untagged: Number(t.n) });
}));

/** Add/remove tags on one or several learners at once (the same call serves single and manual multi-select). */
tagsRouter.post('/apply', requirePerm('tag:apply'), wrap(async (req, res) => {
  const b = parse(z.object({ learner_ids: z.array(uuid).min(1).max(500), add: z.array(uuid).max(20).default([]), remove: z.array(uuid).max(20).default([]) }), req.body);
  const out = await tx(async (db) => applyTags(db, req, { learnerIds: await scopedLearnerIds(req, b.learner_ids, db), add: b.add, remove: b.remove }));
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'tag.applied', entityType: 'learner', entityId: b.learner_ids.length === 1 ? b.learner_ids[0] : null, next: { ...out, learners: b.learner_ids.length, add: b.add, remove: b.remove }, req });
  ok(res, out);
}));
