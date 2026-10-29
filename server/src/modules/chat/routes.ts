import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { notifyUsers } from '../../lib/notify.js';
import { learnerScope } from '../../lib/scope.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requirePerm, requireOrg } from '../../middleware/auth.js';

/**
 * Family chat: ONE thread per learner between that learner's parents and the staff who work with them (their teachers, plus admins in scope).
 * The learner's own login never sees it: this is a grown-ups' channel. Messages are plain text, never edited, and can be hidden by a moderator.
 */
const router = Router(); // mounted at /api/chat
router.use(requireOrg, requirePerm('chat:use'));
const moderator = (req: any) => req.user!.permissions.has('chat:moderate');
const isParent = (req: any) => req.user!.roles.includes('parent');
const EDIT_WINDOW_MIN = 10;

/** The learner this person may talk about: a parent's own child, or a learner in a staff member's scope. The learner themself is never allowed. */
async function learnerFor(req: any, learnerId: string, db?: any) {
  const u = req.user!; const p = new Params();
  if (u.roles.includes('learner') && !isParent(req) && !u.access.orgWide && !u.access.branchIds.length && !u.access.teacher) throw forbidden('Family chat is for parents and staff.');
  const sc = isParent(req) ? `l.id IN ${p.in(u.access.ownLearnerIds.length ? u.access.ownLearnerIds : ['-'])}` : learnerScope(u, p, 'l');
  const l = await queryOne(`SELECT l.id, l.full_name FROM learners l WHERE l.id = ${p.add(learnerId)} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values, db);
  if (!l) throw notFound('Learner');
  return l;
}
async function threadFor(req: any, threadId: string, db?: any) {
  const t = await queryOne(`SELECT id, learner_id, status FROM chat_threads WHERE id = $1 AND org_id = $2`, [threadId, orgIdOf(req)], db);
  if (!t) throw notFound('Conversation');
  const l = await learnerFor(req, t.learner_id, db).catch(() => { throw notFound('Conversation'); });
  return { ...t, learner_name: l.full_name as string };
}
/** Who should hear about a new message: the other side of the conversation. */
async function recipients(orgId: string, learnerId: string, senderIsParent: boolean, senderId: string, db: any): Promise<string[]> {
  let ids: string[];
  if (senderIsParent) {
    ids = (await query(`SELECT DISTINCT tm.teacher_user_id AS id FROM learner_batch_memberships m JOIN teacher_batch_memberships tm ON tm.batch_id = m.batch_id AND tm.status = 'active'
        WHERE m.learner_id = $1 AND m.status = 'active'`, [learnerId], db)).map((r) => r.id as string);
    if (!ids.length) ids = (await query(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.org_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL AND r.code IN ('org_admin','counsellor')`, [orgId], db)).map((r) => r.id as string);
  } else {
    ids = (await query(`SELECT DISTINCT pa.user_id AS id FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL AND pa.user_id IS NOT NULL WHERE lp.learner_id = $1`, [learnerId], db)).map((r) => r.id as string);
  }
  return ids.filter((i) => i && i !== senderId);
}

/** Threads I can see, newest first, with the last message and how many I have not read. Parents also see their children who have no thread yet. */
router.get('/threads', wrap(async (req, res) => {
  const orgId = orgIdOf(req); const u = req.user!; const p = new Params();
  const sc = isParent(req) ? `l.id IN ${p.in(u.access.ownLearnerIds.length ? u.access.ownLearnerIds : ['-'])}` : learnerScope(u, p, 'l');
  const rows = await query(`SELECT l.id AS learner_id, l.full_name AS learner_name, t.id AS thread_id, t.status, t.last_message_at,
      (SELECT m.body FROM chat_messages m WHERE m.thread_id = t.id AND m.hidden_at IS NULL ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id AND m.hidden_at IS NULL AND m.sender_id <> ${p.add(u.id)} AND m.created_at > COALESCE((SELECT r.last_read_at FROM chat_reads r WHERE r.thread_id = t.id AND r.user_id = ${p.add(u.id)}), '1970-01-01')) AS unread
    FROM learners l LEFT JOIN chat_threads t ON t.learner_id = l.id AND t.org_id = l.org_id
    WHERE l.org_id = ${p.add(orgId)} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''} ${isParent(req) ? '' : 'AND t.id IS NOT NULL'}
    ORDER BY t.last_message_at IS NULL, t.last_message_at DESC, l.full_name LIMIT 200`, p.values);
  ok(res, rows.map((r) => ({ ...r, unread: Number(r.unread) })));
}));

router.get('/unread', wrap(async (req, res) => {
  const u = req.user!; const p = new Params(); const sc = isParent(req) ? `l.id IN ${p.in(u.access.ownLearnerIds.length ? u.access.ownLearnerIds : ['-'])}` : learnerScope(u, p, 'l');
  const r = await queryOne(`SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id JOIN learners l ON l.id = t.learner_id
      WHERE t.org_id = ${p.add(orgIdOf(req))} ${sc ? `AND ${sc}` : ''} AND m.hidden_at IS NULL AND m.sender_id <> ${p.add(u.id)}
        AND m.created_at > COALESCE((SELECT x.last_read_at FROM chat_reads x WHERE x.thread_id = t.id AND x.user_id = ${p.add(u.id)}), '1970-01-01')`, p.values);
  ok(res, { unread: Number(r!.n) });
}));

/** Open (or create) the thread about one learner. */
router.post('/threads', wrap(async (req, res) => {
  const b = parse(z.object({ learner_id: uuid }), req.body); const orgId = orgIdOf(req);
  const l = await learnerFor(req, b.learner_id);
  const id = await tx(async (db) => {
    const have = await queryOne(`SELECT id FROM chat_threads WHERE org_id = $1 AND learner_id = $2`, [orgId, l.id], db); if (have) return have.id as string;
    const nid = newId(); await exec(`INSERT INTO chat_threads (id, org_id, learner_id, created_by) VALUES ($1,$2,$3,$4)`, [nid, orgId, l.id, req.user!.id], db); return nid;
  });
  ok(res, { id, learner_id: l.id, learner_name: l.full_name });
}));

router.get('/threads/:id/messages', wrap(async (req, res) => {
  const t = await threadFor(req, parse(uuid, req.params.id)); const q = parse(z.object({ before: z.string().datetime({ offset: true }).optional() }), req.query);
  const rows = await query(`SELECT m.id, m.sender_id, u.full_name AS sender_name, m.body, m.hidden_at, m.created_at,
      (SELECT GROUP_CONCAT(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code IN ('parent','teacher','counsellor','org_admin','branch_admin','super_admin')) AS roles
    FROM chat_messages m JOIN users u ON u.id = m.sender_id WHERE m.thread_id = $1 ${q.before ? 'AND m.created_at < $2' : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT 60`, q.before ? [t.id, new Date(q.before)] : [t.id]);
  ok(res, { thread: { id: t.id, learner_id: t.learner_id, learner_name: t.learner_name, status: t.status },
    messages: rows.reverse().map((m) => ({ id: m.id, sender_name: m.sender_name, mine: m.sender_id === req.user!.id, role: String(m.roles ?? '').split(',').includes('parent') ? 'parent' : 'staff', created_at: m.created_at,
      hidden: !!m.hidden_at, body: m.hidden_at ? null : m.body, can_hide: moderator(req) || (m.sender_id === req.user!.id && Date.now() - new Date(m.created_at).getTime() < EDIT_WINDOW_MIN * 60_000) })) });
}));

router.post('/threads/:id/messages', limit('chat', 30), wrap(async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1, 'Write a message.').max(2000) }), req.body); const orgId = orgIdOf(req); const me = req.user!;
  const out = await tx(async (db) => {
    const t = await threadFor(req, parse(uuid, req.params.id), db);
    if (t.status === 'closed') throw new AppError(409, 'CLOSED', 'This conversation was closed by the school.');
    const id = newId();
    await exec(`INSERT INTO chat_messages (id, org_id, thread_id, sender_id, body) VALUES ($1,$2,$3,$4,$5)`, [id, orgId, t.id, me.id, b.body], db);
    await exec(`UPDATE chat_threads SET last_message_at = NOW(3) WHERE id = $1`, [t.id], db);
    await exec(`INSERT INTO chat_reads (thread_id, user_id, last_read_at) VALUES ($1,$2,NOW(3)) ON DUPLICATE KEY UPDATE last_read_at = NOW(3)`, [t.id, me.id], db);
    const to = await recipients(orgId, t.learner_id, isParent(req), me.id, db);
    // one unread chat notification per person and thread is enough; a busy conversation should not bury their bell
    const fresh: string[] = [];
    for (const uid of to) if (!(await queryOne(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'chat.message' AND link = $2 AND read_at IS NULL LIMIT 1`, [uid, `/messages/${t.id}`], db))) fresh.push(uid);
    if (fresh.length) await notifyUsers(db, { orgId, userIds: fresh, kind: 'chat.message', title: `New message about ${t.learner_name}`, body: b.body.slice(0, 120), link: `/messages/${t.id}`, learnerId: t.learner_id });
    return { id, thread_id: t.id };
  });
  ok(res, out, undefined, 201);
}));

router.post('/threads/:id/read', wrap(async (req, res) => {
  const t = await threadFor(req, parse(uuid, req.params.id));
  await exec(`INSERT INTO chat_reads (thread_id, user_id, last_read_at) VALUES ($1,$2,NOW(3)) ON DUPLICATE KEY UPDATE last_read_at = NOW(3)`, [t.id, req.user!.id]);
  await exec(`UPDATE notifications SET read_at = COALESCE(read_at, NOW(3)) WHERE user_id = $1 AND kind = 'chat.message' AND link = $2`, [req.user!.id, `/messages/${t.id}`]);
  ok(res, { read: true });
}));

/** Hide a message: its sender within a few minutes (a slip), or a moderator any time. The text is kept for the audit trail, never shown again. */
router.post('/messages/:id/hide', wrap(async (req, res) => {
  const orgId = orgIdOf(req); const m = await queryOne(`SELECT id, thread_id, sender_id, created_at, hidden_at FROM chat_messages WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgId]);
  if (!m) throw notFound('Message'); await threadFor(req, m.thread_id);
  const own = m.sender_id === req.user!.id && Date.now() - new Date(m.created_at).getTime() < EDIT_WINDOW_MIN * 60_000;
  if (!moderator(req) && !own) throw forbidden(`You can only take back your own message in the first ${EDIT_WINDOW_MIN} minutes.`);
  await exec(`UPDATE chat_messages SET hidden_at = COALESCE(hidden_at, NOW(3)), hidden_by = $2 WHERE id = $1`, [m.id, req.user!.id]);
  await audit({ orgId, actor: req.user, action: 'chat.message_hidden', entityType: 'chat_message', entityId: m.id, next: { by_moderator: moderator(req) && !own }, req });
  ok(res, { hidden: true });
}));

router.post('/threads/:id/status', requirePerm('chat:moderate'), wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['open', 'closed']) }), req.body); const orgId = orgIdOf(req); const t = await threadFor(req, parse(uuid, req.params.id));
  await exec(`UPDATE chat_threads SET status = $2 WHERE id = $1`, [t.id, b.status]);
  await audit({ orgId, actor: req.user, action: `chat.thread_${b.status}`, entityType: 'chat_thread', entityId: t.id, req });
  ok(res, { status: b.status });
}));
export default router;
