/**
 * DEVELOPMENT ONLY. Bulk-inserts synthetic learners into an existing org to test scale and query plans.
 *   npm run seed:large -w server -- robokalam-demo 100000
 */
import { isProd } from '../src/config/env.js';
import { pool, queryOne } from '../src/db/pool.js';

if (isProd) { console.error('Refusing to run in production.'); process.exit(1); }
const slug = process.argv[2] ?? 'robokalam-demo';
const count = Number(process.argv[3] ?? 100000);

async function main() {
  const org = await queryOne(`SELECT id, code_prefix FROM organizations WHERE slug = $1`, [slug]);
  if (!org) throw new Error(`Organization ${slug} not found. Run seed:demo first.`);
  const t0 = Date.now();
  await pool.query('BEGIN');
  const start = (await pool.query(`INSERT INTO org_counters (org_id, counter_key, value) VALUES ($1,'learner',$2)
     ON CONFLICT (org_id, counter_key) DO UPDATE SET value = org_counters.value + $2 RETURNING value`, [org.id, count])).rows[0].value - count;
  await pool.query(
    `INSERT INTO learners (org_id, branch_id, learner_code, full_name, mobile, school, location, enrolled_on, status)
     SELECT $1, (SELECT id FROM branches WHERE org_id = $1 ORDER BY code LIMIT 1 OFFSET (g % 2)),
            $2 || '-LRN-' || lpad((g + $3)::text, 6, '0'),
            (ARRAY['Aarav','Aisha','Rahul','Ananya','Vihaan','Diya','Arjun','Meera','Kabir','Ishita'])[1 + g % 10] || ' ' ||
            (ARRAY['Kumar','Sharma','Iyer','Reddy','Nair','Khan','Patel','Singh','Menon','Das'])[1 + (g / 10) % 10] || ' ' || g,
            '+91' || (6000000000 + g + $3 * 7)::text, 'School ' || (g % 200), (ARRAY['Chennai','Bengaluru','Coimbatore'])[1 + g % 3],
            CURRENT_DATE - (g % 700), CASE WHEN g % 40 = 0 THEN 'inactive' ELSE 'active' END
       FROM generate_series(1, $4) g`, [org.id, org.code_prefix, start, count]);
  await pool.query(
    `INSERT INTO learner_batch_memberships (org_id, learner_id, batch_id, status)
     SELECT l.org_id, l.id, b.id, 'active'
       FROM (SELECT id, org_id, row_number() OVER (ORDER BY learner_code) rn FROM learners WHERE org_id = $1) l
       JOIN (SELECT id, row_number() OVER (ORDER BY batch_code) - 1 AS bn FROM batches WHERE org_id = $1 AND status IN ('active','upcoming')) b
         ON b.bn = l.rn % (SELECT count(*) FROM batches WHERE org_id = $1 AND status IN ('active','upcoming'))
     ON CONFLICT DO NOTHING`, [org.id]);
  await pool.query('COMMIT');
  await pool.query('ANALYZE learners; ANALYZE learner_batch_memberships;');
  console.log(`Inserted ${count} learners in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
main().catch(async (e) => { await pool.query('ROLLBACK').catch(() => {}); console.error(e); process.exitCode = 1; }).finally(() => pool.end());
