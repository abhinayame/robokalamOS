import { Router } from 'express';
import { z } from 'zod';
import { exec, newId, query, queryOne, tx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { recordActivity } from '../../lib/timeline.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { assertManage, assertWritable, openRoom, viewedLearner } from '../classroom/access.js';
import { recordScore, removeScore, round2 } from './scoring.js';

export const quizzesRouter = Router();
quizzesRouter.use(requireOrg, requirePerm('classroom:read'));

const GRACE_MS = 30_000;
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// ------------------------------------------------------------------ question validation & grading
const questionSchema = z.object({
  kind: z.enum(['single', 'multiple', 'short']),
  prompt: z.string().trim().min(1, 'Write the question.').max(2000),
  options: z.array(z.string().trim().min(1).max(500)).min(2).max(8).optional(),
  answer_key: z.union([z.number().int(), z.array(z.number().int()), z.array(z.string().trim().min(1).max(200))]),
  marks: z.number().positive().max(1000).default(1),
});
type Q = z.infer<typeof questionSchema>;

function checkQuestion(q: Q, i: number) {
  const at = (m: string) => badRequest(`Question ${i + 1}: ${m}`, [{ field: `questions.${i}`, message: m }]);
  if (q.kind === 'short') {
    if (!Array.isArray(q.answer_key) || !q.answer_key.length || (q.answer_key as unknown[]).some((x) => typeof x !== 'string')) throw at('add at least one accepted answer.');
    return { options: null, key: [...new Set((q.answer_key as unknown[]).map(norm))].filter(Boolean) };
  }
  if (!q.options || q.options.length < 2) throw at('add at least two options.');
  const n = q.options.length;
  if (q.kind === 'single') {
    if (typeof q.answer_key !== 'number' || q.answer_key < 0 || q.answer_key >= n) throw at('choose the correct option.');
    return { options: q.options, key: q.answer_key };
  }
  const k = q.answer_key as unknown[];
  if (!Array.isArray(k) || !k.length || k.some((x) => typeof x !== 'number' || x < 0 || x >= n) || new Set(k).size !== k.length) throw at('choose at least one correct option.');
  return { options: q.options, key: [...(k as number[])].sort((a, b) => a - b) };
}

function grade(questions: any[], answers: Record<string, unknown>) {
  let score = 0; let max = 0; const detail: Record<string, boolean> = {};
  for (const q of questions) {
    const marks = Number(q.marks); max += marks;
    const a = answers?.[q.id]; let right = false;
    if (q.kind === 'single') right = typeof a === 'number' && a === q.answer_key;
    else if (q.kind === 'multiple') right = Array.isArray(a) && new Set(a).size === a.length && a.length === q.answer_key.length && [...a].sort((x: number, y: number) => x - y).every((x: number, i: number) => x === q.answer_key[i]);
    else right = typeof a === 'string' && q.answer_key.includes(norm(a));
    detail[q.id] = right; if (right) score += marks;
  }
  return { score: round2(score), max: round2(max), detail };
}

const publicQuestions = (qs: any[]) => qs.map(({ answer_key, ...q }) => ({ ...q, marks: Number(q.marks) }));

// ------------------------------------------------------------------ authoring
const metaBody = z.object({
  title: z.string().trim().min(1, 'Give the quiz a title.').max(255),
  instructions: z.string().trim().max(10_000).nullish(),
  time_limit_minutes: z.number().int().min(1).max(600).nullish(),
  max_attempts: z.number().int().min(1).max(20).default(1),
  opens_at: z.string().datetime({ offset: true }).nullish(),
  closes_at: z.string().datetime({ offset: true }).nullish(),
  reveal_answers: z.boolean().default(false),
  topic_id: uuid.nullish(),
});
const toDate = (s?: string | null) => (s ? new Date(s) : null);
function checkWindow(b: { opens_at?: string | null; closes_at?: string | null }) {
  if (b.opens_at && b.closes_at && new Date(b.closes_at) <= new Date(b.opens_at)) throw badRequest('The quiz must close after it opens.', [{ field: 'closes_at', message: 'Pick a time after the opening time.' }]);
}

async function loadQuiz(id: string, orgId: string, db?: Db) {
  const q = await queryOne(`SELECT * FROM quizzes WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgId], db);
  if (!q) throw notFound('Quiz');
  return q;
}
const attemptCount = async (quizId: string, db?: Db) => Number((await queryOne(`SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = $1`, [quizId], db))!.n);

quizzesRouter.post('/', wrap(async (req, res) => {
  const b = parse(metaBody.extend({ batch_id: uuid }), req.body);
  const room = await openRoom(req, b.batch_id);
  assertManage(room); assertWritable(room); checkWindow(b);
  const id = newId(); const orgId = orgIdOf(req);
  if (b.topic_id && !(await queryOne(`SELECT 1 FROM topics WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [b.topic_id, room.batch.id]))) throw badRequest('That topic does not exist in this batch.');
  await exec(`INSERT INTO quizzes (id, org_id, batch_id, topic_id, title, instructions, time_limit_minutes, max_attempts, opens_at, closes_at, reveal_answers, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, orgId, room.batch.id, b.topic_id ?? null, b.title, b.instructions ?? null, b.time_limit_minutes ?? null, b.max_attempts, toDate(b.opens_at), toDate(b.closes_at), b.reveal_answers, req.user!.id]);
  await audit({ orgId, actor: req.user, action: 'quiz.created', entityType: 'quiz', entityId: id, next: { title: b.title, batch: room.batch.batch_code }, req });
  ok(res, { id }, undefined, 201);
}));

quizzesRouter.get('/', wrap(async (req, res) => {
  const q = parse(z.object({ batch_id: uuid }), req.query);
  const room = await openRoom(req, q.batch_id);
  const rows = await query(
    `SELECT z.id, z.title, z.time_limit_minutes, z.max_attempts, z.opens_at, z.closes_at, z.published, z.topic_id,
            (SELECT COUNT(*) FROM questions x WHERE x.quiz_id = z.id) AS question_count,
            (SELECT COALESCE(SUM(marks), 0) FROM questions x WHERE x.quiz_id = z.id) AS total_marks,
            (SELECT COUNT(DISTINCT learner_id) FROM quiz_attempts a WHERE a.quiz_id = z.id AND a.status <> 'in_progress') AS taken
       FROM quizzes z WHERE z.batch_id = $1 AND z.deleted_at IS NULL ${room.canManage ? '' : 'AND z.published = TRUE'} ORDER BY z.created_at DESC LIMIT 200`, [room.batch.id]);
  const learnerId = room.canManage ? null : viewedLearner(room);
  const mine = new Map<string, any>();
  if (learnerId && rows.length) for (const a of await query(`SELECT quiz_id, COUNT(*) AS attempts, MAX(score) AS best, MAX(max_score) AS max_score FROM quiz_attempts WHERE learner_id = $1 AND status <> 'in_progress' GROUP BY quiz_id`, [learnerId])) mine.set(a.quiz_id, a);
  ok(res, rows.map((r) => ({ ...r, published: !!r.published, question_count: Number(r.question_count), total_marks: Number(r.total_marks), taken: room.canManage ? Number(r.taken) : undefined,
    ...(room.canManage ? {} : { my: mine.get(r.id) ? { attempts: Number(mine.get(r.id).attempts), best: num(mine.get(r.id).best), max: num(mine.get(r.id).max_score) } : { attempts: 0, best: null, max: null } }) })), { can_manage: room.canManage });
}));
const num = (v: unknown) => (v == null ? null : Number(v));

quizzesRouter.get('/:id', wrap(async (req, res) => {
  const quiz = await loadQuiz(parse(uuid, req.params.id), orgIdOf(req));
  const room = await openRoom(req, quiz.batch_id);
  if (!room.canManage && !quiz.published) throw notFound('Quiz');
  const qs = await query(`SELECT id, kind, prompt, options, answer_key, marks, position FROM questions WHERE quiz_id = $1 ORDER BY position, id`, [quiz.id]);
  const meta = { id: quiz.id, batch_id: quiz.batch_id, batch_name: room.batch.name, title: quiz.title, instructions: quiz.instructions, time_limit_minutes: quiz.time_limit_minutes, max_attempts: quiz.max_attempts,
    opens_at: quiz.opens_at, closes_at: quiz.closes_at, published: !!quiz.published, reveal_answers: !!quiz.reveal_answers, topic_id: quiz.topic_id, question_count: qs.length, total_marks: round2(qs.reduce((s, x) => s + Number(x.marks), 0)),
    can_manage: room.canManage, writable: room.writable };
  if (room.canManage) return ok(res, { ...meta, questions: qs.map((x) => ({ ...x, marks: Number(x.marks) })), has_attempts: (await attemptCount(quiz.id)) > 0 });
  const learnerId = viewedLearner(room);
  const attempts = learnerId ? await query(`SELECT id, attempt_no, status, started_at, deadline_at, submitted_at, score, max_score FROM quiz_attempts WHERE quiz_id = $1 AND learner_id = $2 ORDER BY attempt_no`, [quiz.id, learnerId]) : [];
  const now = Date.now();
  const opens = quiz.opens_at ? new Date(quiz.opens_at).getTime() : null; const closes = quiz.closes_at ? new Date(quiz.closes_at).getTime() : null;
  const done = attempts.filter((a) => a.status !== 'in_progress').length;
  const active = attempts.find((a) => a.status === 'in_progress');
  const availability = opens && now < opens ? 'not_open' : closes && now > closes ? 'closed' : done >= quiz.max_attempts ? 'no_attempts_left' : 'open';
  ok(res, { ...meta, my_attempts: attempts.map((a) => ({ ...a, score: num(a.score), max_score: num(a.max_score) })), in_progress_attempt: active?.id ?? null, availability,
    can_start: room.canInteract && room.writable && (availability === 'open' || !!active), learner_id: learnerId });
}));

quizzesRouter.patch('/:id', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const quiz = await loadQuiz(parse(uuid, req.params.id), orgId);
  const room = await openRoom(req, quiz.batch_id);
  assertManage(room); assertWritable(room);
  const b = parse(metaBody.partial(), req.body);
  checkWindow({ opens_at: b.opens_at === undefined ? quiz.opens_at?.toISOString?.() : b.opens_at, closes_at: b.closes_at === undefined ? quiz.closes_at?.toISOString?.() : b.closes_at });
  const started = (await attemptCount(quiz.id)) > 0;
  if (started && (b.time_limit_minutes !== undefined || b.max_attempts !== undefined)) throw conflict('Learners have already attempted this quiz, so the time limit and attempts cannot change.', 'QUIZ_LOCKED');
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of ['title', 'instructions', 'time_limit_minutes', 'max_attempts', 'reveal_answers', 'topic_id'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 1}`); }
  for (const k of ['opens_at', 'closes_at'] as const) if (b[k] !== undefined) { vals.push(toDate(b[k])); sets.push(`${k} = $${vals.length + 1}`); }
  if (sets.length) await exec(`UPDATE quizzes SET ${sets.join(', ')} WHERE id = $1`, [quiz.id, ...vals]);
  if (b.title) await exec(`UPDATE scores SET activity_name = $1 WHERE source_type = 'quiz' AND source_id = $2`, [b.title, quiz.id]);
  await audit({ orgId, actor: req.user, action: 'quiz.updated', entityType: 'quiz', entityId: quiz.id, next: b, req });
  ok(res, { id: quiz.id });
}));

/** Replace the whole question list. Locked once anyone has attempted, so scores stay meaningful. */
quizzesRouter.put('/:id/questions', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ questions: z.array(questionSchema).max(100) }), req.body);
  await tx(async (db) => {
    const quiz = await queryOne(`SELECT id, batch_id, published FROM quizzes WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [parse(uuid, req.params.id), orgId], db);
    if (!quiz) throw notFound('Quiz');
    const room = await openRoom(req, quiz.batch_id, db);
    assertManage(room); assertWritable(room);
    if (await attemptCount(quiz.id, db)) throw conflict('Learners have already attempted this quiz, so its questions are locked.', 'QUIZ_LOCKED');
    if (quiz.published && !b.questions.length) throw badRequest('A published quiz needs at least one question.');
    const checked = b.questions.map((q, i) => ({ q, ...checkQuestion(q, i) }));
    await exec(`DELETE FROM questions WHERE quiz_id = $1`, [quiz.id], db);
    for (const [i, c] of checked.entries()) {
      await exec(`INSERT INTO questions (id, org_id, quiz_id, kind, prompt, options, answer_key, marks, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId(), orgId, quiz.id, c.q.kind, c.q.prompt, c.options ? JSON.stringify(c.options) : null, JSON.stringify(c.key), c.q.marks, i + 1], db);
    }
  });
  ok(res, { saved: b.questions.length });
}));

quizzesRouter.post('/:id/publish', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ published: z.boolean() }), req.body);
  const quiz = await loadQuiz(parse(uuid, req.params.id), orgId);
  const room = await openRoom(req, quiz.batch_id);
  assertManage(room); assertWritable(room);
  if (b.published) {
    if (!Number((await queryOne(`SELECT COUNT(*) AS n FROM questions WHERE quiz_id = $1`, [quiz.id]))!.n)) throw badRequest('Add at least one question before publishing.');
  } else if (await attemptCount(quiz.id)) throw conflict('Learners have attempted this quiz, so it cannot be unpublished.', 'QUIZ_LOCKED');
  await exec(`UPDATE quizzes SET published = $1 WHERE id = $2`, [b.published, quiz.id]);
  await audit({ orgId, actor: req.user, action: b.published ? 'quiz.published' : 'quiz.unpublished', entityType: 'quiz', entityId: quiz.id, req });
  ok(res, { id: quiz.id, published: b.published });
}));

quizzesRouter.delete('/:id', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const quiz = await loadQuiz(parse(uuid, req.params.id), orgId);
  const room = await openRoom(req, quiz.batch_id);
  assertManage(room); assertWritable(room);
  await tx(async (db) => {
    await exec(`UPDATE quizzes SET deleted_at = NOW(3) WHERE id = $1`, [quiz.id], db);
    for (const s of await query(`SELECT id FROM scores WHERE source_type = 'quiz' AND source_id = $1 AND deleted_at IS NULL`, [quiz.id], db)) await removeScore(db, orgId, req.user!.id, s.id);
  });
  await audit({ orgId, actor: req.user, action: 'quiz.deleted', entityType: 'quiz', entityId: quiz.id, req });
  ok(res, { id: quiz.id, deleted: true });
}));

quizzesRouter.get('/:id/attempts', wrap(async (req, res) => {
  const quiz = await loadQuiz(parse(uuid, req.params.id), orgIdOf(req));
  const room = await openRoom(req, quiz.batch_id);
  assertManage(room);
  const rows = await query(
    `SELECT a.id, a.learner_id, l.full_name, l.learner_code, a.attempt_no, a.status, a.started_at, a.submitted_at, a.score, a.max_score
       FROM quiz_attempts a JOIN learners l ON l.id = a.learner_id WHERE a.quiz_id = $1 ORDER BY l.full_name, a.attempt_no LIMIT 2000`, [quiz.id]);
  ok(res, rows.map((r) => ({ ...r, score: num(r.score), max_score: num(r.max_score) })));
}));

// ------------------------------------------------------------------ taking a quiz (learner only)
async function finalize(db: Db, attempt: any, quiz: any, answers: Record<string, unknown>, expired: boolean, userId: string) {
  const qs = await query(`SELECT id, kind, answer_key, marks FROM questions WHERE quiz_id = $1`, [quiz.id], db);
  const g = grade(qs, expired ? {} : answers);
  await exec(`UPDATE quiz_attempts SET status = $1, answers = $2, submitted_at = NOW(3), score = $3, max_score = $4 WHERE id = $5`, [expired ? 'expired' : 'submitted', JSON.stringify(expired ? {} : answers), g.score, g.max, attempt.id], db);
  // The gradebook holds the learner's best attempt.
  await recordScore(db, { orgId: quiz.org_id, actorId: quiz.created_by, learnerId: attempt.learner_id, batchId: quiz.batch_id, sourceType: 'quiz', sourceId: quiz.id, name: quiz.title, category: 'Quiz', score: g.score, max: g.max, onlyIfHigher: true });
  await recordActivity(db, { orgId: quiz.org_id, learnerId: attempt.learner_id, batchId: quiz.batch_id, type: 'quiz.submitted', title: `${expired ? 'Quiz timed out' : 'Completed quiz'}: ${quiz.title} (${g.score}/${g.max})`, meta: { quiz_id: quiz.id, attempt_id: attempt.id }, actorUserId: userId });
  return { ...g, qs };
}

quizzesRouter.post('/:id/attempts', requirePerm('classroom:interact'), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const out = await tx(async (db) => {
    const quiz = await queryOne(`SELECT * FROM quizzes WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL AND published = TRUE FOR UPDATE`, [parse(uuid, req.params.id), orgId], db);
    if (!quiz) throw notFound('Quiz');
    const room = await openRoom(req, quiz.batch_id, db);
    if (!room.canInteract || !room.learnerIds.length) throw forbidden('Only learners in this batch can take quizzes.');
    if (!room.writable) throw conflict(`This batch is ${room.batch.status}, so quizzes are closed.`, 'BATCH_CLOSED');
    const learnerId = room.learnerIds[0];
    const existing = await queryOne(`SELECT * FROM quiz_attempts WHERE quiz_id = $1 AND learner_id = $2 AND status = 'in_progress'`, [quiz.id, learnerId], db);
    const now = Date.now();
    if (existing && (!existing.deadline_at || new Date(existing.deadline_at).getTime() + GRACE_MS > now)) return { attempt: existing, quiz, resumed: true };
    if (existing) await finalize(db, existing, quiz, {}, true, req.user!.id);    // an abandoned, timed-out attempt is closed first
    if (quiz.opens_at && now < new Date(quiz.opens_at).getTime()) throw conflict('This quiz has not opened yet.', 'QUIZ_NOT_OPEN');
    if (quiz.closes_at && now > new Date(quiz.closes_at).getTime()) throw conflict('This quiz has closed.', 'QUIZ_CLOSED');
    const used = await attemptCount(quiz.id, db);
    const mine = Number((await queryOne(`SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = $1 AND learner_id = $2`, [quiz.id, learnerId], db))!.n);
    void used;
    if (mine >= quiz.max_attempts) throw conflict('You have used all your attempts for this quiz.', 'NO_ATTEMPTS_LEFT');
    const limits = [quiz.time_limit_minutes ? now + quiz.time_limit_minutes * 60_000 : null, quiz.closes_at ? new Date(quiz.closes_at).getTime() : null].filter((x): x is number => x !== null);
    const deadline = limits.length ? new Date(Math.min(...limits)) : null;
    const id = newId();
    await exec(`INSERT INTO quiz_attempts (id, org_id, quiz_id, learner_id, attempt_no, deadline_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, orgId, quiz.id, learnerId, mine + 1, deadline], db);
    return { attempt: await queryOne(`SELECT * FROM quiz_attempts WHERE id = $1`, [id], db), quiz, resumed: false };
  });
  const qs = await query(`SELECT id, kind, prompt, options, marks, position FROM questions WHERE quiz_id = $1 ORDER BY position, id`, [out.quiz.id]);
  ok(res, { attempt_id: out.attempt.id, attempt_no: out.attempt.attempt_no, started_at: out.attempt.started_at, deadline_at: out.attempt.deadline_at, resumed: out.resumed, questions: publicQuestions(qs) }, undefined, out.resumed ? 200 : 201);
}));

quizzesRouter.post('/attempts/:attemptId/submit', requirePerm('classroom:interact'), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ answers: z.record(z.string(), z.union([z.number().int(), z.array(z.number().int()), z.string().max(500), z.null()])).default({}) }), req.body);
  const out = await tx(async (db) => {
    const attempt = await queryOne(`SELECT * FROM quiz_attempts WHERE id = $1 AND org_id = $2 FOR UPDATE`, [parse(uuid, req.params.attemptId), orgId], db);
    if (!attempt || !req.user!.access.ownLearnerIds.includes(attempt.learner_id)) throw notFound('Attempt');
    if (attempt.status !== 'in_progress') throw conflict('This attempt has already been submitted.', 'ALREADY_SUBMITTED');
    const quiz = await queryOne(`SELECT * FROM quizzes WHERE id = $1`, [attempt.quiz_id], db);
    const expired = !!attempt.deadline_at && Date.now() > new Date(attempt.deadline_at).getTime() + GRACE_MS;
    const g = await finalize(db, attempt, quiz, b.answers, expired, req.user!.id);
    return { attempt, quiz, g, expired };
  });
  await audit({ orgId, actor: req.user, action: 'quiz.attempt_submitted', entityType: 'quiz', entityId: out.quiz.id, next: { score: out.g.score, max: out.g.max, expired: out.expired }, req });
  ok(res, resultView(out.quiz, out.g, out.expired, out.attempt.id, b.answers));
}));

function resultView(quiz: any, g: { score: number; max: number; detail: Record<string, boolean>; qs: any[] }, expired: boolean, attemptId: string, answers: Record<string, unknown>) {
  return {
    attempt_id: attemptId, status: expired ? 'expired' : 'submitted', score: g.score, max_score: g.max, percentage: g.max ? Math.round((g.score / g.max) * 10000) / 100 : 0,
    message: expired ? 'Time ran out before this was submitted, so no answers were counted.' : null,
    ...(quiz.reveal_answers && !expired ? { review: g.qs.map((q) => ({ question_id: q.id, correct: g.detail[q.id], your_answer: answers?.[q.id] ?? null, correct_answer: q.answer_key })) } : {}),
  };
}

quizzesRouter.get('/attempts/:attemptId', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const attempt = await queryOne(`SELECT * FROM quiz_attempts WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.attemptId), orgId]);
  if (!attempt) throw notFound('Attempt');
  const quiz = await queryOne(`SELECT * FROM quizzes WHERE id = $1`, [attempt.quiz_id]);
  const room = await openRoom(req, quiz.batch_id);
  if (!room.canManage && !req.user!.access.ownLearnerIds.includes(attempt.learner_id)) throw notFound('Attempt');
  const qs = await query(`SELECT id, kind, prompt, options, answer_key, marks, position FROM questions WHERE quiz_id = $1 ORDER BY position, id`, [quiz.id]);
  if (attempt.status === 'in_progress') {
    if (room.canManage) return ok(res, { attempt_id: attempt.id, status: attempt.status });
    return ok(res, { attempt_id: attempt.id, status: attempt.status, deadline_at: attempt.deadline_at, questions: publicQuestions(qs) });
  }
  const answers = attempt.answers ?? {};
  const g = { ...grade(qs, answers), qs };
  ok(res, { ...resultView(quiz, g, attempt.status === 'expired', attempt.id, answers), ...(room.canManage ? { review: g.qs.map((q) => ({ question_id: q.id, prompt: q.prompt, correct: g.detail[q.id], your_answer: answers[q.id] ?? null, correct_answer: q.answer_key })) } : {}) });
}));
