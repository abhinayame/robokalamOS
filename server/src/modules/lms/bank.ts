import { Router } from 'express';
import { z } from 'zod';
import { exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';

/** The question bank: write a question once, reuse it in any quiz. A quiz gets a COPY, so editing the bank never changes a quiz people are already taking. */
const router = Router(); // mounted at /api/bank
router.use(requireOrg, requirePerm('qbank:manage'));
const body = z.object({
  topic: z.string().trim().min(2, 'Give it a topic.').max(80), difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'), q: z.string().trim().min(2).max(300),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(6), answer: z.number().int().min(0),
}).refine((x) => x.answer < x.options.length, { message: 'The correct answer must be one of the options.', path: ['answer'] });
const fmt = (r: any) => ({ id: r.id, topic: r.topic, difficulty: r.difficulty, q: r.q, options: r.options, answer: r.answer, created_at: r.created_at });

router.get('/', wrap(async (req, res) => {
  const q = parse(z.object({ topic: z.string().max(80).optional(), difficulty: z.enum(['easy', 'medium', 'hard']).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
  const w = ['org_id = $1', 'deleted_at IS NULL']; const v: any[] = [orgIdOf(req)];
  if (q.topic) { v.push(q.topic); w.push(`topic = $${v.length}`); } if (q.difficulty) { v.push(q.difficulty); w.push(`difficulty = $${v.length}`); }
  if (q.q) { v.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`); w.push(`q LIKE $${v.length}`); }
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM qb_questions WHERE ${w.join(' AND ')}`, v))!.n);
  const rows = await query(`SELECT * FROM qb_questions WHERE ${w.join(' AND ')} ORDER BY topic, created_at DESC, id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, v);
  ok(res, rows.map(fmt), { page: q.page, page_size: q.page_size, total });
}));
router.get('/topics', wrap(async (req, res) => { ok(res, await query(`SELECT topic, COUNT(*) AS questions FROM qb_questions WHERE org_id = $1 AND deleted_at IS NULL GROUP BY topic ORDER BY topic`, [orgIdOf(req)])); }));
router.post('/', wrap(async (req, res) => {
  const b = parse(body, req.body); const id = newId();
  await exec(`INSERT INTO qb_questions (id, org_id, topic, difficulty, q, options, answer, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, orgIdOf(req), b.topic, b.difficulty, b.q, JSON.stringify(b.options), b.answer, req.user!.id]);
  ok(res, { id }, undefined, 201);
}));
/** Save many at once (for example the questions of a quiz you just wrote). */
router.post('/bulk', wrap(async (req, res) => {
  const b = parse(z.object({ topic: z.string().trim().min(2).max(80), difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'), questions: z.array(z.object({ q: z.string().trim().min(2).max(300), options: z.array(z.string().trim().min(1).max(200)).min(2).max(6), answer: z.number().int().min(0) })).min(1).max(100) }), req.body);
  let added = 0, skipped = 0;
  for (const x of b.questions) {
    if (x.answer >= x.options.length) { skipped++; continue; }
    if (await queryOne(`SELECT 1 FROM qb_questions WHERE org_id = $1 AND topic = $2 AND q = $3 AND deleted_at IS NULL`, [orgIdOf(req), b.topic, x.q])) { skipped++; continue; }
    await exec(`INSERT INTO qb_questions (id, org_id, topic, difficulty, q, options, answer, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [newId(), orgIdOf(req), b.topic, b.difficulty, x.q, JSON.stringify(x.options), x.answer, req.user!.id]); added++;
  }
  ok(res, { added, skipped }, undefined, 201);
}));
router.put('/:id', wrap(async (req, res) => {
  const b = parse(body, req.body); const r = await exec(`UPDATE qb_questions SET topic=$3, difficulty=$4, q=$5, options=$6, answer=$7 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.id), orgIdOf(req), b.topic, b.difficulty, b.q, JSON.stringify(b.options), b.answer]);
  if (!r.affectedRows) throw notFound('Question'); ok(res, { updated: true });
}));
router.delete('/:id', wrap(async (req, res) => {
  const r = await exec(`UPDATE qb_questions SET deleted_at = NOW(3) WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.id), orgIdOf(req)]);
  if (!r.affectedRows) throw notFound('Question'); await audit({ orgId: orgIdOf(req), actor: req.user, action: 'qbank.deleted', entityType: 'qb_question', entityId: String(req.params.id), req }); ok(res, { deleted: true });
}));
/** A random draw for a quiz: N questions, optionally one topic and difficulty. */
router.post('/pick', wrap(async (req, res) => {
  const b = parse(z.object({ topic: z.string().max(80).optional(), difficulty: z.enum(['easy', 'medium', 'hard']).optional(), count: z.number().int().min(1).max(30).default(5), exclude_ids: z.array(uuid).max(100).default([]) }), req.body);
  const w = ['org_id = $1', 'deleted_at IS NULL']; const v: any[] = [orgIdOf(req)];
  if (b.topic) { v.push(b.topic); w.push(`topic = $${v.length}`); } if (b.difficulty) { v.push(b.difficulty); w.push(`difficulty = $${v.length}`); }
  for (const id of b.exclude_ids) { v.push(id); w.push(`id <> $${v.length}`); }
  ok(res, (await query(`SELECT * FROM qb_questions WHERE ${w.join(' AND ')} ORDER BY RAND() LIMIT ${b.count}`, v)).map(fmt));
}));
export default router;
