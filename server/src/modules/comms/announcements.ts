import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, tx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { openRoom } from '../classroom/access.js';
import { resolveLearnerIds, selectorSchema, summarizeAudience } from '../selection/resolver.js';

const router = Router();
router.use(requireOrg, requirePerm('comms:announce'));
const MAX = 50_000;

const body = z.object({ title: z.string().trim().min(2, 'Add a title.').max(200), body: z.string().trim().min(2, 'Write the announcement.').max(5000), selector: selectorSchema, post_to_stream: z.boolean().default(false) });

/** Preview: how many unique learners, and how many people will be notified. Sends nothing. */
router.post('/preview', wrap(async (req, res) => {
  const b = parse(z.object({ selector: selectorSchema }), req.body); const orgId = orgIdOf(req);
  const s = await summarizeAudience(req.user!, orgId, b.selector);
  ok(res, { ...s, people: (await peopleFor(await resolveLearnerIds(req.user!, orgId, b.selector, undefined, MAX + 1))).size });
}));

async function peopleFor(ids: string[], db?: Db): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const p = new Params();
    for (const r of await query(`SELECT l.user_id AS u, l.id AS learner_id FROM learners l WHERE l.id IN ${p.in(ids.slice(i, i + 1000))} AND l.user_id IS NOT NULL
        UNION ALL SELECT pa.user_id, lp.learner_id FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL AND pa.user_id IS NOT NULL WHERE lp.learner_id IN ${p.in(ids.slice(i, i + 1000))}`, p.values, db)) if (!out.has(r.u)) out.set(r.u, r.learner_id);
  }
  return out;
}

/**
 * In-app announcement. The audience comes from the selection engine (scoped to the sender, one row per learner);
 * every person who can log in gets ONE notification even if they follow several selected learners.
 * Optionally posts to the Stream of the selected batches the sender manages.
 */
router.post('/', wrap(async (req, res) => {
  const b = parse(body.extend({ confirm: z.literal(true, { message: 'Review the audience and confirm to send.' }) }), req.body); const orgId = orgIdOf(req);
  const summary = await summarizeAudience(req.user!, orgId, b.selector);
  if (!summary.unique_learners) throw badRequest('No learners match this selection.');
  if (summary.unique_learners > MAX) throw badRequest(`An announcement can reach at most ${MAX.toLocaleString('en-IN')} learners. Narrow the audience.`);
  if (b.post_to_stream && !b.selector.batch_ids?.length) throw badRequest('Posting to the Stream needs batches selected.', [{ field: 'post_to_stream', message: 'Select batches, or turn this off.' }]);
  const id = newId();
  const out = await tx(async (db) => {
    const ids = await resolveLearnerIds(req.user!, orgId, b.selector, db, MAX + 1);
    // One notification per PERSON: a parent following three selected children is told once.
    const people = await peopleFor(ids, db);
    people.delete(req.user!.id);
    let notified = 0;
    const entries = [...people.entries()];
    for (let i = 0; i < entries.length; i += 500) {
      const p = new Params();
      const rows = entries.slice(i, i + 500).map(([uid, lid]) => `(${p.add(newId())},${p.add(orgId)},${p.add(uid)},${p.add(lid)},'announcement',${p.add(b.title)},${p.add(b.body.slice(0, 1000))},'/notifications')`);
      await exec(`INSERT INTO notifications (id, org_id, user_id, learner_id, kind, title, body, link) VALUES ${rows.join(',')}`, p.values, db);
      notified += rows.length;
    }
    let streams = 0;
    if (b.post_to_stream) {
      for (const batchId of b.selector.batch_ids!) {
        const room = await openRoom(req, batchId, db);
        if (!room.canManage) throw badRequest('You can only post to the Stream of batches you teach or manage.', [{ field: 'post_to_stream', message: `No access to post in ${room.batch.name}.` }]);
        await exec(`INSERT INTO classroom_posts (id, org_id, batch_id, author_user_id, kind, title, body, comments_enabled) VALUES ($1,$2,$3,$4,'announcement',$5,$6,TRUE)`, [newId(), orgId, room.batch.id, req.user!.id, b.title, b.body], db);
        streams++;
      }
    }
    await exec(`INSERT INTO announcements (id, org_id, title, body, selector, post_to_stream, unique_learners, notified_users, streams_posted, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, orgId, b.title, b.body, JSON.stringify(b.selector), b.post_to_stream, ids.length, notified, streams, req.user!.id], db);
    return { id, unique_learners: ids.length, duplicates_removed: summary.duplicates_removed, notified_users: notified, streams_posted: streams };
  });
  await audit({ orgId, actor: req.user, action: 'announcement.sent', entityType: 'announcement', entityId: id, next: out, req });
  ok(res, out, undefined, 201);
}));

router.get('/', wrap(async (req, res) => {
  const p = new Params(); const admin = req.user!.isSuperAdmin || req.user!.access.orgWide;
  const rows = await query(`SELECT a.id, a.title, a.body, a.post_to_stream, a.unique_learners, a.notified_users, a.streams_posted, a.created_at, u.full_name AS created_by_name
      FROM announcements a JOIN users u ON u.id = a.created_by WHERE a.org_id = ${p.add(orgIdOf(req))} ${admin ? '' : `AND a.created_by = ${p.add(req.user!.id)}`} ORDER BY a.created_at DESC LIMIT 100`, p.values);
  ok(res, rows);
}));

export default router;
