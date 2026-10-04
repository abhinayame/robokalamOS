/**
 * DEVELOPMENT ONLY. Times the hot endpoints against a RUNNING server holding the large dataset (seed:large + seed:perf).
 *   BASE_URL=http://localhost:4300 PERF_EMAIL=admin@demo.robokalam.test PERF_PASSWORD=... npx tsx dev/perf-check.ts
 */
const base = process.env.BASE_URL ?? 'http://localhost:4300';
const email = process.env.PERF_EMAIL ?? 'admin@demo.robokalam.test';
const password = process.env.PERF_PASSWORD ?? '';
if (!password) { console.error('Set PERF_PASSWORD.'); process.exit(1); }

let token = '';
async function call(method: string, path: string, body?: unknown) {
  const t = performance.now();
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); const ms = performance.now() - t;
  let json: any = null; try { json = JSON.parse(text); } catch { /* csv etc. */ }
  return { status: r.status, ms, json, bytes: text.length };
}
async function main() {
  const l = await call('POST', '/api/auth/login', { email, password });
  if (l.status !== 200) throw new Error(`login failed ${l.status}`);
  token = l.json.data.access_token;
  const batches = (await call('GET', '/api/batches?page_size=100&status=active')).json.data as any[];
  const perf = batches.filter((b) => b.name?.startsWith('Perf Batch'));
  const ids = perf.slice(0, 5).map((b) => b.id); const one = perf[0].id;
  const learner = (await call('GET', '/api/learners?page_size=1&search=Aarav')).json.data[0].id;
  await call('PUT', '/api/gamification/settings', { leaderboard_enabled: true });
  const cases: [string, string, string, unknown?][] = [
    ['learners list p1', 'GET', '/api/learners?page=1&page_size=25&sort=name&order=asc'],
    ['learners list deep page', 'GET', '/api/learners?page=3000&page_size=25&sort=name&order=asc'],
    ['learners search (name)', 'GET', '/api/learners?search=Aarav%20Kumar&page_size=25'],
    ['learners filter by 5 batches', 'GET', `/api/learners?batch_id=${ids.join(',')}&page_size=25`],
    ['batches list', 'GET', '/api/batches?page_size=50'],
    ['batch people', 'GET', `/api/batches/${one}/learners`],
    ['dashboard (org admin)', 'GET', '/api/dashboard'],
    ['selection resolve: 100 batches', 'POST', '/api/selection/resolve', { batch_ids: perf.slice(0, 100).map((b) => b.id) }],
    ['selection resolve: all 1,000+ batches', 'POST', '/api/selection/resolve', { batch_ids: batches.map((b) => b.id) }],
    ['bulk dry run (100 batches)', 'POST', '/api/bulk/learners', { action: 'change_status', status: 'inactive', dry_run: true, selection: { batch_ids: perf.slice(0, 100).map((b) => b.id) } }],
    ['learner 360', 'GET', `/api/learners/${learner}`],
    ['gradebook (one batch)', 'GET', `/api/classrooms/${one}/gradebook`],
    ['attendance summary', 'GET', `/api/attendance/summary?learner_id=${learner}`],
    ['leaderboard (batch)', 'GET', `/api/gamification/leaderboard?scope=batch&id=${one}`],
    ['leaderboard (whole org)', 'GET', '/api/gamification/leaderboard?scope=all'],
    ['gamification overview', 'GET', `/api/gamification/overview?learner_id=${learner}`],
    ['batch insights', 'GET', `/api/analytics/batch/${one}`],
    ['compare 10 batches', 'GET', `/api/analytics/compare?batch_ids=${perf.slice(0, 10).map((b) => b.id).join(',')}`],
    ['CRM leads list', 'GET', '/api/crm/leads?page_size=25'],
    ['CRM summary', 'GET', '/api/crm/summary'],
    ...['learner', 'batch', 'teacher', 'attendance', 'score', 'achievement', 'xp', 'crm', 'communication'].map((r) => [`report: ${r}`, 'GET', `/api/reports/${r}`] as [string, string, string]),
  ];
  console.log('| Endpoint | Median | Max | Status | Size |\n|---|---:|---:|---:|---:|');
  let slow = 0;
  for (const [name, m, p, b] of cases) {
    const runs = []; for (let i = 0; i < 3; i++) runs.push(await call(m, p, b));
    const t = runs.map((x) => x.ms).sort((a, b2) => a - b2);
    const bad = runs.some((x) => x.status >= 400);
    if (t[1] > 1000 || bad) slow++;
    console.log(`| ${name} | ${t[1].toFixed(0)} ms | ${t[2].toFixed(0)} ms | ${runs[0].status}${bad ? ' ⚠' : ''} | ${(runs[0].bytes / 1024).toFixed(0)} KB |`);
  }
  console.log(`\n${slow ? `${slow} endpoint(s) over 1000 ms or failing` : 'All endpoints under 1000 ms'}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
