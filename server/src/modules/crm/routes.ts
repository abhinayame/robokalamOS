import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, query, queryOne, tx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { notifyUsers } from '../../lib/notify.js';
import { csvList, ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { LEAD_STATUSES } from '../learners/filters.js';
import { ACTIVITY_TYPES, CLOSED_STATUSES, assertAssignable, createFollowUp, ensureLead, logCrmActivity, syncNextFollowUp, tagsOf } from './service.js';
import { scopedLearnerIds } from './tags.js';

const router = Router();
router.use(requireOrg, requirePerm('crm:read'));
const manage = requirePerm('crm:manage');
const TEMPS = ['cold', 'warm', 'hot'] as const;
const label = (s: string) => s.replace(/_/g, ' ');
const dt = z.string().datetime({ offset: true });

async function visibleLearner(req: any, id: string, db?: Db) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const l = await queryOne(`SELECT l.id, l.full_name FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values, db);
  if (!l) throw notFound('Learner');   // 404 for other tenants, other branches, and learners outside the caller's scope
  return l as { id: string; full_name: string };
}

async function checkInterests(db: Db, orgId: string, b: { interested_program_id?: string | null; interested_course_id?: string | null; interested_batch_id?: string | null }) {
  const chk = async (table: string, id: string | null | undefined, field: string, what: string) => {
    if (id && !(await queryOne(`SELECT 1 FROM ${table} WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId], db))) throw badRequest(`That ${what} does not exist.`, [{ field, message: `Unknown ${what}.` }]);
  };
  await chk('programs', b.interested_program_id, 'interested_program_id', 'program');
  await chk('courses', b.interested_course_id, 'interested_course_id', 'course');
  await chk('batches', b.interested_batch_id, 'interested_batch_id', 'batch');
}

const leadFields = z.object({
  lead_source: z.string().trim().max(80).nullish(), lead_status: z.enum(LEAD_STATUSES).optional(), lost_reason: z.string().trim().max(255).nullish(),
  interested_program_id: uuid.nullish(), interested_course_id: uuid.nullish(), interested_batch_id: uuid.nullish(),
  counsellor_user_id: uuid.nullish(), temperature: z.enum(TEMPS).nullish(), notes: z.string().trim().max(5000).nullish(),
});

/** Move a lead to a new status: timeline entry, conversion stamp, and open follow-ups close when the pipeline ends. */
export async function changeStatus(db: Db, a: { orgId: string; learnerId: string; to: string; actorId: string | null; lostReason?: string | null }) {
  const cur = await queryOne(`SELECT lead_status FROM crm_leads WHERE learner_id = $1 FOR UPDATE`, [a.learnerId], db);
  if (!cur) throw badRequest('This learner is not in the CRM yet.');
  if (cur.lead_status === a.to) return false;
  if (a.to === 'lost' && !a.lostReason) throw badRequest('Say why the lead was lost.', [{ field: 'lost_reason', message: 'This is required for a lost lead.' }]);
  await exec(`UPDATE crm_leads SET lead_status = $1, lost_reason = $2, converted_at = $3 WHERE learner_id = $4`,
    [a.to, a.to === 'lost' ? a.lostReason : null, a.to === 'converted' ? new Date() : null, a.learnerId], db);
  await logCrmActivity(db, { orgId: a.orgId, learnerId: a.learnerId, type: 'status_changed', description: `${label(cur.lead_status)} → ${label(a.to)}${a.lostReason && a.to === 'lost' ? `: ${a.lostReason}` : ''}`, staffId: a.actorId });
  if (CLOSED_STATUSES.includes(a.to)) {
    await exec(`UPDATE follow_ups SET status = 'cancelled', completed_at = NOW(3), completed_by = $2 WHERE learner_id = $1 AND status = 'open'`, [a.learnerId, a.actorId], db);
    await syncNextFollowUp(db, a.learnerId);
  }
  return true;
}

// ------------------------------------------------------------------ pipeline list
const listQ = z.object({
  status: csvList(z.enum(LEAD_STATUSES)), counsellor_id: z.string().optional(), temperature: z.enum(TEMPS).optional(), source: z.string().trim().max(80).optional(),
  q: z.string().trim().max(100).optional(), tag_id: uuid.optional(), follow_up: z.enum(['overdue', 'today', 'week', 'none']).optional(),
  sort: z.enum(['follow_up', 'newest', 'name', 'updated']).default('follow_up'),
  page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(25),
});
router.get('/leads', wrap(async (req, res) => {
  const user = req.user!; const orgId = orgIdOf(req);
  const q = parse(listQ, req.query);
  const build = (withStatus: boolean) => {
    const p = new Params();
    const w = [`l.org_id = ${p.add(orgId)}`, 'l.deleted_at IS NULL'];
    const sc = learnerScope(user, p, 'l'); if (sc) w.push(sc);
    if (withStatus && q.status?.length) w.push(`cl.lead_status IN ${p.in(q.status)}`);
    if (q.counsellor_id === 'me') w.push(`cl.counsellor_user_id = ${p.add(user.id)}`);
    else if (q.counsellor_id === 'none') w.push('cl.counsellor_user_id IS NULL');
    else if (q.counsellor_id) w.push(`cl.counsellor_user_id = ${p.add(parse(uuid, q.counsellor_id))}`);
    if (q.temperature) w.push(`cl.temperature = ${p.add(q.temperature)}`);
    if (q.source) w.push(`cl.lead_source = ${p.add(q.source)}`);
    if (q.tag_id) w.push(`EXISTS (SELECT 1 FROM learner_tags lt WHERE lt.learner_id = l.id AND lt.tag_id = ${p.add(q.tag_id)})`);
    if (q.follow_up === 'overdue') w.push('cl.next_follow_up_at < NOW(3)');
    else if (q.follow_up === 'today') w.push('cl.next_follow_up_at >= NOW(3) AND cl.next_follow_up_at < DATE_ADD(DATE(NOW(3)), INTERVAL 1 DAY)');
    else if (q.follow_up === 'week') w.push('cl.next_follow_up_at >= NOW(3) AND cl.next_follow_up_at < DATE_ADD(NOW(3), INTERVAL 7 DAY)');
    else if (q.follow_up === 'none') w.push(`cl.next_follow_up_at IS NULL AND cl.lead_status NOT IN ('converted','not_interested','lost')`);
    if (q.q) { const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`; w.push(`(l.full_name LIKE ${p.add(like)} OR l.mobile LIKE ${p.add(like)} OR l.email LIKE ${p.add(like)} OR l.learner_code LIKE ${p.add(like)} OR EXISTS (SELECT 1 FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id WHERE lp.learner_id = l.id AND (pa.full_name LIKE ${p.add(like)} OR pa.mobile LIKE ${p.add(like)})))`); }
    return { p, where: w.join(' AND ') };
  };
  const { p, where } = build(true);
  const order = { follow_up: '(cl.next_follow_up_at IS NULL), cl.next_follow_up_at, l.full_name', newest: 'cl.created_at DESC', name: 'l.full_name', updated: 'cl.updated_at DESC' }[q.sort];
  const base = `FROM crm_leads cl JOIN learners l ON l.id = cl.learner_id WHERE ${where}`;
  const total = Number((await queryOne(`SELECT COUNT(*) AS n ${base}`, p.values))!.n);
  const rows = await query(
    `SELECT l.id AS learner_id, l.learner_code, l.full_name, l.mobile, l.email, cl.lead_source, cl.lead_status, cl.temperature, cl.next_follow_up_at, cl.counsellor_user_id, cl.created_at, cl.updated_at,
            cu.full_name AS counsellor_name, c.name AS interested_course, pr.name AS interested_program,
            (SELECT pa.full_name FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id WHERE lp.learner_id = l.id AND pa.deleted_at IS NULL ORDER BY lp.is_primary DESC LIMIT 1) AS parent_name
       ${base.replace('WHERE', `LEFT JOIN users cu ON cu.id = cl.counsellor_user_id LEFT JOIN courses c ON c.id = cl.interested_course_id LEFT JOIN programs pr ON pr.id = cl.interested_program_id WHERE`)}
      ORDER BY ${order}, l.id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  const tags = new Map<string, any[]>();
  if (rows.length) { const tp = new Params(); for (const t of await query(`SELECT lt.learner_id, t.id, t.name, t.color FROM learner_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.learner_id IN ${tp.in(rows.map((r) => r.learner_id))} ORDER BY t.name`, tp.values)) tags.set(t.learner_id, [...(tags.get(t.learner_id) ?? []), { id: t.id, name: t.name, color: t.color }]); }
  const { p: p2, where: where2 } = build(false);
  const counts: Record<string, number> = {};
  for (const r of await query(`SELECT cl.lead_status AS s, COUNT(*) AS n FROM crm_leads cl JOIN learners l ON l.id = cl.learner_id WHERE ${where2} GROUP BY cl.lead_status`, p2.values)) counts[r.s] = Number(r.n);
  ok(res, rows.map((r) => ({ ...r, tags: tags.get(r.learner_id) ?? [], overdue: !!r.next_follow_up_at && new Date(r.next_follow_up_at).getTime() < Date.now() && !CLOSED_STATUSES.includes(r.lead_status) })),
    { page: q.page, page_size: q.page_size, total, total_pages: Math.ceil(total / q.page_size), status_counts: counts });
}));

router.get('/summary', wrap(async (req, res) => {
  const user = req.user!;
  const p = new Params(); const sc = learnerScope(user, p, 'l');
  const where = `l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`;
  const base = `FROM crm_leads cl JOIN learners l ON l.id = cl.learner_id WHERE ${where}`;
  const by = async (col: string) => (await query(`SELECT ${col} AS k, COUNT(*) AS n ${base} GROUP BY ${col} ORDER BY n DESC LIMIT 20`, p.values));
  const status = Object.fromEntries((await by('cl.lead_status')).map((r) => [r.k, Number(r.n)]));
  const total = Object.values(status).reduce((a: number, b) => a + (b as number), 0);
  const converted = (status.converted as number) ?? 0;
  const fp = new Params(); const fsc = learnerScope(user, fp, 'l');
  const fu = await queryOne(`SELECT COALESCE(SUM(f.due_at < NOW(3)), 0) AS overdue, COALESCE(SUM(f.due_at >= NOW(3) AND f.due_at < DATE_ADD(DATE(NOW(3)), INTERVAL 1 DAY)), 0) AS today FROM follow_ups f JOIN learners l ON l.id = f.learner_id WHERE f.status = 'open' AND f.org_id = ${fp.add(orgIdOf(req))} AND l.deleted_at IS NULL ${fsc ? `AND ${fsc}` : ''}`, fp.values);
  const mine = await queryOne(`SELECT COALESCE(SUM(due_at < NOW(3)), 0) AS overdue, COUNT(*) AS open FROM follow_ups WHERE status = 'open' AND assigned_to = $1 AND org_id = $2`, [user.id, orgIdOf(req)]);
  ok(res, {
    total, status, converted, conversion_rate: total ? Math.round((converted / total) * 10000) / 100 : null,
    by_source: (await by('COALESCE(cl.lead_source, \'Unknown\')')).map((r) => ({ source: r.k, count: Number(r.n) })),
    by_counsellor: (await query(`SELECT cu.full_name AS name, COUNT(*) AS n ${base.replace('WHERE', 'LEFT JOIN users cu ON cu.id = cl.counsellor_user_id WHERE')} GROUP BY cu.full_name ORDER BY n DESC LIMIT 20`, p.values)).map((r) => ({ counsellor: r.name ?? 'Unassigned', count: Number(r.n) })),
    follow_ups: { overdue: Number(fu?.overdue ?? 0), today: Number(fu?.today ?? 0), mine_open: Number(mine!.open), mine_overdue: Number(mine!.overdue) },
  });
}));

router.get('/counsellors', wrap(async (req, res) => {
  ok(res, await query(
    `SELECT u.id, u.full_name FROM users u WHERE u.org_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code IN ('counsellor','org_admin','branch_admin')) ORDER BY u.full_name LIMIT 200`, [orgIdOf(req)]));
}));

// ------------------------------------------------------------------ one learner's CRM view
router.get('/learners/:id', wrap(async (req, res) => {
  const l = await visibleLearner(req, parse(uuid, req.params.id));
  const lead = await queryOne(
    `SELECT cl.*, cu.full_name AS counsellor_name, pr.name AS program_name, c.name AS course_name, b.name AS batch_name
       FROM crm_leads cl LEFT JOIN users cu ON cu.id = cl.counsellor_user_id LEFT JOIN programs pr ON pr.id = cl.interested_program_id
       LEFT JOIN courses c ON c.id = cl.interested_course_id LEFT JOIN batches b ON b.id = cl.interested_batch_id WHERE cl.learner_id = $1`, [l.id]);
  const activities = await query(
    `SELECT a.id, a.type, a.description, a.occurred_at, a.next_follow_up_at, u.full_name AS staff_name FROM crm_activities a LEFT JOIN users u ON u.id = a.staff_user_id
      WHERE a.learner_id = $1 ORDER BY a.occurred_at DESC, a.id DESC LIMIT 100`, [l.id]);
  const follow_ups = await query(
    `SELECT f.id, f.due_at, f.note, f.status, f.completed_at, f.assigned_to, u.full_name AS assigned_name FROM follow_ups f JOIN users u ON u.id = f.assigned_to
      WHERE f.learner_id = $1 AND (f.status = 'open' OR f.completed_at > DATE_SUB(NOW(3), INTERVAL 60 DAY)) ORDER BY (f.status <> 'open'), f.due_at LIMIT 50`, [l.id]);
  ok(res, { learner: l, lead, activities, follow_ups, tags: await tagsOf(l.id), types: ACTIVITY_TYPES });
}));

// ------------------------------------------------------------------ lead create / update / remove
router.post('/leads', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(leadFields.extend({ learner_id: uuid }), req.body);
  const l = await visibleLearner(req, b.learner_id);
  const out = await tx(async (db) => {
    await checkInterests(db, orgId, b);
    if (b.counsellor_user_id) await assertAssignable(db, orgId, b.counsellor_user_id);
    if (b.lead_status === 'lost' && !b.lost_reason) throw badRequest('Say why the lead was lost.', [{ field: 'lost_reason', message: 'This is required for a lost lead.' }]);
    const created = await ensureLead(db, { orgId, learnerId: l.id, actorId: req.user!.id, fields: b });
    if (!created) throw badRequest('This learner is already in the CRM.');
    await exec(`UPDATE crm_leads SET interested_program_id = $1, interested_course_id = $2, interested_batch_id = $3, notes = $4, lost_reason = $5, converted_at = $6 WHERE learner_id = $7`,
      [b.interested_program_id ?? null, b.interested_course_id ?? null, b.interested_batch_id ?? null, b.notes ?? null, b.lead_status === 'lost' ? b.lost_reason : null, b.lead_status === 'converted' ? new Date() : null, l.id], db);
    await logCrmActivity(db, { orgId, learnerId: l.id, type: 'note', description: `Added to the CRM${b.lead_source ? ` (source: ${b.lead_source})` : ''}`, staffId: req.user!.id });
    if (b.counsellor_user_id && b.counsellor_user_id !== req.user!.id) await notifyUsers(db, { orgId, userIds: [b.counsellor_user_id], kind: 'lead.assigned', title: `New lead assigned: ${l.full_name}`, link: `/learners/${l.id}` });
    return { learner_id: l.id };
  });
  await audit({ orgId, actor: req.user, action: 'crm.lead_created', entityType: 'learner', entityId: l.id, next: b, req });
  ok(res, out, undefined, 201);
}));

router.patch('/leads/:learnerId', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(leadFields, req.body);
  const l = await visibleLearner(req, parse(uuid, req.params.learnerId));
  const prev = await queryOne(`SELECT * FROM crm_leads WHERE learner_id = $1`, [l.id]);
  if (!prev) throw notFound('Lead');
  await tx(async (db) => {
    await checkInterests(db, orgId, b);
    if (b.counsellor_user_id) await assertAssignable(db, orgId, b.counsellor_user_id);
    const sets: string[] = []; const vals: unknown[] = [];
    for (const k of ['lead_source', 'interested_program_id', 'interested_course_id', 'interested_batch_id', 'temperature', 'notes'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 1}`); }
    if (b.counsellor_user_id !== undefined) { vals.push(b.counsellor_user_id ?? null); sets.push(`counsellor_user_id = $${vals.length + 1}`); }
    if (sets.length) await exec(`UPDATE crm_leads SET ${sets.join(', ')} WHERE learner_id = $1`, [l.id, ...vals], db);
    if (b.lead_status) await changeStatus(db, { orgId, learnerId: l.id, to: b.lead_status, actorId: req.user!.id, lostReason: b.lost_reason });
    if (b.counsellor_user_id !== undefined && b.counsellor_user_id !== prev.counsellor_user_id) {
      const who = b.counsellor_user_id ? (await queryOne(`SELECT full_name FROM users WHERE id = $1`, [b.counsellor_user_id], db))?.full_name : null;
      await logCrmActivity(db, { orgId, learnerId: l.id, type: 'counsellor_assigned', description: who ? `Assigned to ${who}` : 'Counsellor removed', staffId: req.user!.id });
      if (b.counsellor_user_id && b.counsellor_user_id !== req.user!.id) await notifyUsers(db, { orgId, userIds: [b.counsellor_user_id], kind: 'lead.assigned', title: `Lead assigned to you: ${l.full_name}`, link: `/learners/${l.id}` });
    }
  });
  await audit({ orgId, actor: req.user, action: 'crm.lead_updated', entityType: 'learner', entityId: l.id, previous: { lead_status: prev.lead_status, counsellor: prev.counsellor_user_id, temperature: prev.temperature }, next: b, req });
  ok(res, { learner_id: l.id });
}));

router.delete('/leads/:learnerId', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const l = await visibleLearner(req, parse(uuid, req.params.learnerId));
  const prev = await queryOne(`SELECT lead_status FROM crm_leads WHERE learner_id = $1`, [l.id]);
  if (!prev) throw notFound('Lead');
  await tx(async (db) => {
    await exec(`DELETE FROM crm_leads WHERE learner_id = $1`, [l.id], db);
    await exec(`UPDATE follow_ups SET status = 'cancelled', completed_at = NOW(3), completed_by = $2 WHERE learner_id = $1 AND status = 'open'`, [l.id, req.user!.id], db);
    await logCrmActivity(db, { orgId, learnerId: l.id, type: 'note', description: 'Removed from the CRM pipeline (the learner profile is untouched)', staffId: req.user!.id });
  });
  await audit({ orgId, actor: req.user, action: 'crm.lead_removed', entityType: 'learner', entityId: l.id, previous: prev, req });
  ok(res, { learner_id: l.id, removed: true });
}));

// ------------------------------------------------------------------ activities
router.post('/learners/:id/activities', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ type: z.enum(ACTIVITY_TYPES), description: z.string().trim().max(5000).nullish(), next_follow_up_at: dt.nullish(), assigned_to: uuid.optional(), lead_status: z.enum(LEAD_STATUSES).optional(), lost_reason: z.string().trim().max(255).nullish() }), req.body);
  if (['note', 'other'].includes(b.type) && !b.description) throw badRequest('Write what happened.', [{ field: 'description', message: 'This is required.' }]);
  const l = await visibleLearner(req, parse(uuid, req.params.id));
  if (b.next_follow_up_at && new Date(b.next_follow_up_at) <= new Date(Date.now() - 60_000)) throw badRequest('Pick a follow-up time in the future.', [{ field: 'next_follow_up_at', message: 'Must be in the future.' }]);
  const out = await tx(async (db) => {
    const lead = await queryOne(`SELECT counsellor_user_id FROM crm_leads WHERE learner_id = $1`, [l.id], db);
    const id = await logCrmActivity(db, { orgId, learnerId: l.id, type: b.type, description: b.description, staffId: req.user!.id, nextFollowUpAt: b.next_follow_up_at ? new Date(b.next_follow_up_at) : null });
    if (b.lead_status) await changeStatus(db, { orgId, learnerId: l.id, to: b.lead_status, actorId: req.user!.id, lostReason: b.lost_reason });
    let follow_up_id: string | null = null;
    if (b.next_follow_up_at && !(b.lead_status && CLOSED_STATUSES.includes(b.lead_status))) {
      follow_up_id = await createFollowUp(db, { orgId, learnerId: l.id, learnerName: l.full_name, assignedTo: b.assigned_to ?? lead?.counsellor_user_id ?? req.user!.id, dueAt: new Date(b.next_follow_up_at), note: b.description?.slice(0, 500) ?? null, actorId: req.user!.id });
    }
    return { id, follow_up_id };
  });
  await audit({ orgId, actor: req.user, action: 'crm.activity_logged', entityType: 'learner', entityId: l.id, next: { type: b.type, follow_up: !!out.follow_up_id }, req });
  ok(res, out, undefined, 201);
}));

// ------------------------------------------------------------------ follow-ups
router.get('/follow-ups', wrap(async (req, res) => {
  const user = req.user!;
  const q = parse(z.object({ who: z.enum(['mine', 'all']).default('mine'), bucket: z.enum(['overdue', 'today', 'upcoming', 'done']).optional(), assigned_to: uuid.optional(), page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
  const p = new Params();
  const w = [`f.org_id = ${p.add(orgIdOf(req))}`, 'l.deleted_at IS NULL'];
  const sc = learnerScope(user, p, 'l'); if (sc) w.push(sc);
  if (q.assigned_to) w.push(`f.assigned_to = ${p.add(q.assigned_to)}`); else if (q.who === 'mine') w.push(`f.assigned_to = ${p.add(user.id)}`);
  const b = q.bucket ?? 'overdue';
  if (!q.bucket) w.push(`f.status = 'open'`);
  else if (b === 'done') w.push(`f.status = 'done'`);
  else { w.push(`f.status = 'open'`); w.push(b === 'overdue' ? 'f.due_at < NOW(3)' : b === 'today' ? 'f.due_at >= NOW(3) AND f.due_at < DATE_ADD(DATE(NOW(3)), INTERVAL 1 DAY)' : 'f.due_at >= DATE_ADD(DATE(NOW(3)), INTERVAL 1 DAY)'); }
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM follow_ups f JOIN learners l ON l.id = f.learner_id WHERE ${w.join(' AND ')}`, p.values))!.n);
  const rows = await query(
    `SELECT f.id, f.learner_id, l.full_name, l.mobile, l.learner_code, f.due_at, f.note, f.status, f.completed_at, f.assigned_to, u.full_name AS assigned_name, cl.lead_status
       FROM follow_ups f JOIN learners l ON l.id = f.learner_id JOIN users u ON u.id = f.assigned_to LEFT JOIN crm_leads cl ON cl.learner_id = f.learner_id
      WHERE ${w.join(' AND ')} ORDER BY ${b === 'done' ? 'f.completed_at DESC' : 'f.due_at'}, f.id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows.map((r) => ({ ...r, overdue: r.status === 'open' && new Date(r.due_at).getTime() < Date.now() })), { page: q.page, page_size: q.page_size, total });
}));

router.post('/learners/:id/follow-ups', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ due_at: dt, note: z.string().trim().max(500).nullish(), assigned_to: uuid.optional() }), req.body);
  if (new Date(b.due_at) <= new Date(Date.now() - 60_000)) throw badRequest('Pick a time in the future.', [{ field: 'due_at', message: 'Must be in the future.' }]);
  const l = await visibleLearner(req, parse(uuid, req.params.id));
  const id = await tx(async (db) => createFollowUp(db, { orgId, learnerId: l.id, learnerName: l.full_name, assignedTo: b.assigned_to ?? req.user!.id, dueAt: new Date(b.due_at), note: b.note, actorId: req.user!.id }));
  await audit({ orgId, actor: req.user, action: 'crm.follow_up_created', entityType: 'follow_up', entityId: id, next: { learner_id: l.id, ...b }, req });
  ok(res, { id }, undefined, 201);
}));

async function loadFollowUp(req: any, id: string, db?: Db) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const f = await queryOne(`SELECT f.*, l.full_name FROM follow_ups f JOIN learners l ON l.id = f.learner_id WHERE f.id = ${p.add(id)} AND f.org_id = ${p.add(orgIdOf(req))} ${sc ? `AND ${sc}` : ''} FOR UPDATE`, p.values, db);
  if (!f) throw notFound('Follow-up');
  return f;
}

router.patch('/follow-ups/:id', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ due_at: dt.optional(), note: z.string().trim().max(500).nullish(), assigned_to: uuid.optional() }), req.body);
  await tx(async (db) => {
    const f = await loadFollowUp(req, parse(uuid, req.params.id), db);
    if (f.status !== 'open') throw badRequest('Only open follow-ups can be changed.');
    if (b.assigned_to && b.assigned_to !== f.assigned_to) { await assertAssignable(db, orgId, b.assigned_to); if (b.assigned_to !== req.user!.id) await notifyUsers(db, { orgId, userIds: [b.assigned_to], kind: 'followup.assigned', title: `Follow-up assigned: ${f.full_name}`, link: `/learners/${f.learner_id}` }); }
    const sets: string[] = []; const vals: unknown[] = [];
    if (b.due_at) { vals.push(new Date(b.due_at)); sets.push(`due_at = $${vals.length + 1}`); }
    if (b.note !== undefined) { vals.push(b.note ?? null); sets.push(`note = $${vals.length + 1}`); }
    if (b.assigned_to) { vals.push(b.assigned_to); sets.push(`assigned_to = $${vals.length + 1}`); }
    if (sets.length) await exec(`UPDATE follow_ups SET ${sets.join(', ')} WHERE id = $1`, [f.id, ...vals], db);
    await syncNextFollowUp(db, f.learner_id);
  });
  ok(res, { id: req.params.id });
}));

router.post('/follow-ups/:id/complete', manage, wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ outcome: z.string().trim().max(2000).nullish(), next_follow_up_at: dt.nullish(), assigned_to: uuid.optional() }), req.body);
  const out = await tx(async (db) => {
    const f = await loadFollowUp(req, parse(uuid, req.params.id), db);
    if (f.status !== 'open') throw badRequest('This follow-up is already closed.');
    await exec(`UPDATE follow_ups SET status = 'done', completed_at = NOW(3), completed_by = $2 WHERE id = $1`, [f.id, req.user!.id], db);
    await logCrmActivity(db, { orgId, learnerId: f.learner_id, type: 'follow_up', description: b.outcome ?? `Follow-up done${f.note ? `: ${f.note}` : ''}`, staffId: req.user!.id, nextFollowUpAt: b.next_follow_up_at ? new Date(b.next_follow_up_at) : null });
    let next: string | null = null;
    if (b.next_follow_up_at) {
      if (new Date(b.next_follow_up_at) <= new Date()) throw badRequest('Pick the next follow-up in the future.', [{ field: 'next_follow_up_at', message: 'Must be in the future.' }]);
      next = await createFollowUp(db, { orgId, learnerId: f.learner_id, learnerName: f.full_name, assignedTo: b.assigned_to ?? f.assigned_to, dueAt: new Date(b.next_follow_up_at), note: f.note, actorId: req.user!.id });
    } else await syncNextFollowUp(db, f.learner_id);
    return { id: f.id, next_follow_up_id: next };
  });
  await audit({ orgId, actor: req.user, action: 'crm.follow_up_done', entityType: 'follow_up', entityId: out.id, req });
  ok(res, out);
}));

router.post('/follow-ups/:id/cancel', manage, wrap(async (req, res) => {
  await tx(async (db) => {
    const f = await loadFollowUp(req, parse(uuid, req.params.id), db);
    if (f.status !== 'open') throw badRequest('This follow-up is already closed.');
    await exec(`UPDATE follow_ups SET status = 'cancelled', completed_at = NOW(3), completed_by = $2 WHERE id = $1`, [f.id, req.user!.id], db);
    await syncNextFollowUp(db, f.learner_id);
  });
  ok(res, { id: req.params.id, cancelled: true });
}));

export default router;
