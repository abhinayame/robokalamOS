/**
 * DEVELOPMENT ONLY. Bulk-inserts synthetic learners into an existing org to test scale and query plans.
 *   npm run seed:large -w server -- robokalam-demo 100000
 */
import { isProd } from '../src/config/env.js';
import { Params, exec, pool, query, queryOne, tx } from '../src/db/pool.js';

if (isProd) { console.error('Refusing to run in production.'); process.exit(1); }
const slug = process.argv[2] ?? 'robokalam-demo';
const count = Number(process.argv[3] ?? 100000);
if (count > 1_000_000) throw new Error('Max 1,000,000 rows per run.');

const FIRST = ['Aarav', 'Aisha', 'Rahul', 'Ananya', 'Vihaan', 'Diya', 'Arjun', 'Meera', 'Kabir', 'Ishita'];
const LAST = ['Kumar', 'Sharma', 'Iyer', 'Reddy', 'Nair', 'Khan', 'Patel', 'Singh', 'Menon', 'Das'];
const CITY = ['Chennai', 'Bengaluru', 'Coimbatore'];

async function main() {
  const org = await queryOne(`SELECT id, code_prefix FROM organizations WHERE slug = $1`, [slug]);
  if (!org) throw new Error(`Organization ${slug} not found. Run seed:demo first.`);
  const branches = (await query(`SELECT id FROM branches WHERE org_id = $1 ORDER BY code`, [org.id])).map((b) => b.id as string);
  if (!branches.length) throw new Error('Create at least one branch first.');
  const batchCount = Number((await queryOne(`SELECT COUNT(*) AS n FROM batches WHERE org_id = $1 AND status IN ('active','upcoming')`, [org.id]))!.n);
  const t0 = Date.now();
  await tx(async (db) => {
    await exec(`INSERT INTO org_counters (org_id, counter_key, value) VALUES ($1,'learner',$2) ON DUPLICATE KEY UPDATE value = value + $2`, [org.id, count], db);
    const start = Number((await queryOne(`SELECT value FROM org_counters WHERE org_id = $1 AND counter_key = 'learner'`, [org.id], db))!.value) - count;
    const p = new Params();
    // numbers 1..count from a cross join of digit tables (works on MySQL and MariaDB without recursion limits)
    const digits = '(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';
    const nums = `(SELECT a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d + 1 AS g FROM ${digits} a, ${digits} b, ${digits} c, ${digits} d, ${digits} e, ${digits} f) n`;
    const elt = (arr: string[], idx: string) => `ELT(1 + MOD(${idx}, ${arr.length}), ${arr.map((x) => p.add(x)).join(', ')})`;
    await exec(
      `INSERT INTO learners (id, org_id, branch_id, learner_code, full_name, mobile, school, location, enrolled_on, status)
       SELECT UUID(), ${p.add(org.id)}, ${elt(branches, 'n.g')},
              CONCAT(${p.add(org.code_prefix)}, '-LRN-', LPAD(n.g + ${p.add(start)}, 6, '0')),
              CONCAT(${elt(FIRST, 'n.g')}, ' ', ${elt(LAST, 'FLOOR(n.g / 10)')}, ' ', n.g),
              CONCAT('+91', 6000000000 + n.g + ${p.add(start)} * 7), CONCAT('School ', MOD(n.g, 200)), ${elt(CITY, 'n.g')},
              DATE_SUB(CURDATE(), INTERVAL MOD(n.g, 700) DAY), IF(MOD(n.g, 40) = 0, 'inactive', 'active')
         FROM ${nums} WHERE n.g <= ${p.add(count)}`, p.values, db);
    if (batchCount) {
      await exec(
        `INSERT IGNORE INTO learner_batch_memberships (id, org_id, learner_id, batch_id, status)
         SELECT UUID(), l.org_id, l.id, b.id, 'active'
           FROM (SELECT id, org_id, ROW_NUMBER() OVER (ORDER BY learner_code) AS rn FROM learners WHERE org_id = $1) l
           JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY batch_code) - 1 AS bn FROM batches WHERE org_id = $1 AND status IN ('active','upcoming')) b
             ON b.bn = MOD(l.rn, $2)`, [org.id, batchCount], db);
    }
  });
  await pool.query('ANALYZE TABLE learners, learner_batch_memberships');
  console.log(`Inserted ${count} learners in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
