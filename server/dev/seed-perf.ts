/**
 * DEVELOPMENT ONLY. Adds realistic Phase 2-8 volume on top of `seed:large` so hot endpoints can be measured at scale:
 * ~N batches, 2 batch memberships per learner, sessions + attendance, assignments + submissions + scores + XP, badges, CRM leads.
 *   npm run seed:perf -w server -- robokalam-demo 1500
 */
import { isProd } from '../src/config/env.js';
import { exec, pool, query, queryOne } from '../src/db/pool.js';

if (isProd) { console.error('Refusing to run in production.'); process.exit(1); }
const slug = process.argv[2] ?? 'robokalam-demo';
const N = Number(process.argv[3] ?? 1500);
if (N < 1 || N > 20000) throw new Error('Batch count must be 1..20000.');

const digits = '(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';
const nums = (limit: number) => `(SELECT a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d AS g FROM ${digits} a, ${digits} b, ${digits} c, ${digits} d, ${digits} e WHERE a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d < ${limit}) n`;

async function step<T>(label: string, fn: () => Promise<T>) { const t = Date.now(); const r = await fn(); console.log(`${label}: ${((Date.now() - t) / 1000).toFixed(1)}s`); return r; }

async function main() {
  const org = await queryOne(`SELECT id FROM organizations WHERE slug = $1`, [slug]);
  if (!org) throw new Error(`Organization ${slug} not found.`);
  const admin = await queryOne(`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.org_id = $1 AND r.code = 'org_admin' LIMIT 1`, [org.id]);
  if (!admin) throw new Error('No org admin found.');
  const have = Number((await queryOne(`SELECT COUNT(*) AS n FROM batches WHERE org_id = $1 AND name LIKE 'Perf Batch %'`, [org.id]))!.n);
  if (have) { console.log(`Already seeded (${have} perf batches). Nothing to do.`); return; }
  const O = org.id as string; const A = admin.id as string;

  await step(`${N} batches`, () => exec(
    `INSERT INTO batches (id, org_id, branch_id, program_id, course_id, batch_code, name, academic_year, start_date, capacity, status, created_by)
     SELECT UUID(), $1, br.id, c.program_id, c.id, CONCAT('PERF-', LPAD(n.g + 1, 5, '0')), CONCAT('Perf Batch ', n.g + 1), '2026-27',
            DATE_SUB(CURDATE(), INTERVAL 60 DAY), NULL, IF(MOD(n.g, 10) = 0, 'upcoming', 'active'), $2
       FROM ${nums(N)}
       JOIN (SELECT id, program_id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS cn FROM courses WHERE org_id = $1 AND deleted_at IS NULL) c ON c.cn = MOD(n.g, (SELECT COUNT(*) FROM courses WHERE org_id = $1 AND deleted_at IS NULL))
       JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS bn FROM branches WHERE org_id = $1) br ON br.bn = MOD(n.g, (SELECT COUNT(*) FROM branches WHERE org_id = $1))`, [O, A]));

  await step('memberships (2 per learner)', () => exec(
    `INSERT IGNORE INTO learner_batch_memberships (id, org_id, learner_id, batch_id, status, enrolled_by)
     SELECT UUID(), $1, l.id, b.id, 'active', $2
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY learner_code) - 1 AS rn FROM learners WHERE org_id = $1) l
       JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY batch_code) - 1 AS bn FROM batches WHERE org_id = $1 AND name LIKE 'Perf Batch %') b
         ON b.bn = MOD(l.rn, $3) OR b.bn = MOD(l.rn * 7 + 3, $3)`, [O, A, N]));

  await step('4 sessions per batch', () => exec(
    `INSERT INTO class_sessions (id, org_id, batch_id, title, starts_at, ends_at, status, created_by)
     SELECT UUID(), $1, b.id, CONCAT('Class ', s.k), DATE_SUB(UTC_TIMESTAMP(3), INTERVAL (s.k * 7) DAY), DATE_ADD(DATE_SUB(UTC_TIMESTAMP(3), INTERVAL (s.k * 7) DAY), INTERVAL 1 HOUR), 'completed', $2
       FROM batches b JOIN (SELECT 1 AS k UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) s
      WHERE b.org_id = $1 AND b.name LIKE 'Perf Batch %'`, [O, A]));

  await step('attendance', () => exec(
    `INSERT INTO attendance (id, org_id, session_id, batch_id, learner_id, status, marked_by)
     SELECT UUID(), $1, cs.id, cs.batch_id, m.learner_id, ELT(1 + MOD(CRC32(CONCAT(m.learner_id, cs.id)), 10), 'present','present','present','present','present','present','present','late','absent','excused'), $2
       FROM class_sessions cs JOIN learner_batch_memberships m ON m.batch_id = cs.batch_id AND m.status = 'active'
      WHERE cs.org_id = $1 AND cs.batch_id IN (SELECT id FROM batches WHERE org_id = $1 AND name LIKE 'Perf Batch %')`, [O, A]));

  await step('2 assignments per batch', () => exec(
    `INSERT INTO assignments (id, org_id, batch_id, title, due_at, max_marks, created_by)
     SELECT UUID(), $1, b.id, CONCAT('Assignment ', s.k), DATE_SUB(UTC_TIMESTAMP(3), INTERVAL (s.k * 10) DAY), 100, $2
       FROM batches b JOIN (SELECT 1 AS k UNION ALL SELECT 2) s WHERE b.org_id = $1 AND b.name LIKE 'Perf Batch %'`, [O, A]));

  await step('submissions (70% evaluated)', () => exec(
    `INSERT INTO submissions (id, org_id, assignment_id, learner_id, status, body, submitted_at, evaluated_at, evaluated_by)
     SELECT UUID(), $1, a.id, m.learner_id, IF(MOD(CRC32(CONCAT(m.learner_id, a.id)), 10) < 7, 'evaluated', 'submitted'), 'Synthetic submission', DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 3 DAY),
            IF(MOD(CRC32(CONCAT(m.learner_id, a.id)), 10) < 7, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY), NULL), IF(MOD(CRC32(CONCAT(m.learner_id, a.id)), 10) < 7, $2, NULL)
       FROM assignments a JOIN learner_batch_memberships m ON m.batch_id = a.batch_id AND m.status = 'active'
      WHERE a.org_id = $1 AND a.batch_id IN (SELECT id FROM batches WHERE org_id = $1 AND name LIKE 'Perf Batch %')`, [O, A]));

  await step('scores for evaluated work', () => exec(
    `INSERT INTO scores (id, org_id, learner_id, batch_id, teacher_user_id, source_type, source_id, activity_name, category, score, max_score)
     SELECT UUID(), $1, s.learner_id, a.batch_id, $2, 'assignment', a.id, a.title, 'Assignment', 40 + MOD(CRC32(CONCAT(s.id, 'x')), 61), 100
       FROM submissions s JOIN assignments a ON a.id = s.assignment_id
      WHERE s.org_id = $1 AND s.status = 'evaluated' AND a.title LIKE 'Assignment %' AND a.batch_id IN (SELECT id FROM batches WHERE org_id = $1 AND name LIKE 'Perf Batch %')`, [O, A]));

  await step('XP for each score', () => exec(
    `INSERT INTO xp_transactions (org_id, learner_id, batch_id, points, reason, source_type, source_id, dedupe_key, created_by)
     SELECT $1, sc.learner_id, sc.batch_id, FLOOR(sc.score / 10), CONCAT('Scored in ', sc.activity_name), 'score', sc.id, CONCAT('perf:', sc.id), $2
       FROM scores sc WHERE sc.org_id = $1 AND sc.batch_id IN (SELECT id FROM batches WHERE org_id = $1 AND name LIKE 'Perf Batch %')`, [O, A]));

  await step('badges (1 in 10 learners)', async () => {
    await exec(`INSERT IGNORE INTO badges (id, org_id, name, icon, xp_reward, created_by) VALUES (UUID(), $1, 'Perf Star', '⭐', 0, $2)`, [O, A]);
    await exec(
      `INSERT IGNORE INTO learner_badges (id, org_id, learner_id, badge_id, awarded_by, reason)
       SELECT UUID(), $1, l.id, (SELECT id FROM badges WHERE org_id = $1 AND name = 'Perf Star'), $2, 'Synthetic' FROM learners l WHERE l.org_id = $1 AND MOD(CRC32(l.id), 10) = 0`, [O, A]);
  });

  await step('CRM leads (1 in 8 learners)', () => exec(
    `INSERT IGNORE INTO crm_leads (id, org_id, learner_id, lead_source, lead_status, counsellor_user_id, temperature, created_by)
     SELECT UUID(), $1, l.id, ELT(1 + MOD(CRC32(l.id), 4), 'Walk-in','Website','Referral','Social'),
            ELT(1 + MOD(CRC32(CONCAT(l.id,'s')), 6), 'new','contacted','interested','follow_up','converted','lost'), $2, ELT(1 + MOD(CRC32(l.id), 3), 'hot','warm','cold'), $2
       FROM learners l WHERE l.org_id = $1 AND MOD(CRC32(CONCAT(l.id, 'c')), 8) = 0`, [O, A]));

  await pool.query('ANALYZE TABLE learners, batches, learner_batch_memberships, class_sessions, attendance, assignments, submissions, scores, xp_transactions, learner_badges, crm_leads');
  for (const t of ['batches', 'learner_batch_memberships', 'attendance', 'submissions', 'scores', 'xp_transactions', 'learner_badges', 'crm_leads']) {
    console.log(`  ${t}: ${Number((await queryOne(`SELECT COUNT(*) AS n FROM ${t} WHERE org_id = $1`, [O]))!.n).toLocaleString('en-IN')}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
