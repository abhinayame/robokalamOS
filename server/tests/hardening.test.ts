import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { env } from '../src/config/env.js';
import { exec, query } from '../src/db/pool.js';
import { preflight } from '../src/lib/preflight.js';
import { runMaintenance } from '../src/modules/system/maintenance.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';

const SRC = path.resolve(__dirname, '../src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const walk = (d: string): string[] => fs.readdirSync(path.join(SRC, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe('every route says who may call it', () => {
  it('nothing is mounted before authentication except sign-in, health and webhooks', () => {
    const src = read('app.ts');
    const authAt = src.indexOf("app.use('/api', authenticate)");
    expect(authAt).toBeGreaterThan(0);
    const before = [...src.slice(0, authAt).matchAll(/app\.use\('(\/api[^']*)'/g)].map((m) => m[1]);
    expect([...new Set(before)].sort()).toEqual(['/api/auth', '/api/health', '/api/public', '/api/webhooks'].sort());
    const publicRoutes = [...src.slice(0, authAt).matchAll(/app\.(get|post)\('(\/api[^']*)'/g)].map((m) => m[2]);
    expect(publicRoutes).toEqual(['/api/health']);
  });

  // Self-service or open-by-design routes. Everything else must carry a permission check, or reach data only through the classroom gate.
  const ALLOW: Record<string, string> = {
    'modules/auth/routes.ts': 'sign-in, refresh, logout, me and change-password act only on the caller\'s own account',
    'modules/notifications/routes.ts': 'a user can only ever read and change their own notifications',
    'modules/comms/webhook.ts': 'guarded by the secret in the URL',
    'modules/live/webhook.ts': 'guarded by the Zoom HMAC signature (and timestamp) over the raw body',
    'modules/fees/webhook.ts': 'guarded by the Razorpay HMAC signature over the raw body',
    'modules/system/routes.ts': 'health/ready is public by design; the system status router carries system:read',
    'modules/dashboard/routes.ts': 'dashboard:view on the route',
    'modules/classroom/classwork.ts': 'mounted inside classroom/routes.ts, which applies classroom:read; every write calls assertManage on the batch',
    'modules/branding/routes.ts: GET /branding': 'public by design (sign-in page): public branding fields only',
    'modules/branding/routes.ts: GET /orgs/:slug/logo': 'public by design: serves only the file the organization chose as its logo',
    'modules/branding/routes.ts: GET /orgs/:slug/manifest.webmanifest': 'public by design: the installable-app manifest',
    'modules/organizations/routes.ts: GET /current': 'returns only the caller\'s own organization',
  };
  it('each route file applies requirePerm / requireAnyPerm / requireSuperAdmin to every handler (or is on the reviewed allow-list)', () => {
    const offenders: string[] = [];
    for (const file of walk('modules').filter((f) => f.endsWith('.ts'))) {
      const rel = file.replace(/\\/g, '/');
      if (ALLOW[rel]) continue;
      const src = read(file);
      const routers = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*Router\(\)/g)].map((m) => m[1]);
      for (const r of routers) {
        if (new RegExp(`${r}\\.use\\([^;]*(requirePerm|requireAnyPerm|requireSuperAdmin)`).test(src)) continue;       // gated for the whole router
        for (const m of src.matchAll(new RegExp(`${r}\\.(get|post|put|patch|delete)\\(\\s*['"\`]([^'"\`]*)['"\`]([\\s\\S]*?)(?:wrap\\(|async\\s*\\()`, 'g'))) {
          if (ALLOW[`${rel}: ${m[1].toUpperCase()} ${m[2]}`]) continue;
          // a gate is requirePerm(...) etc. written inline, or a const in this file that was assigned one (e.g. const manage = requirePerm('x'))
          const gates = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:requirePerm|requireAnyPerm|requireSuperAdmin)\(/g)].map((g) => g[1]);
          const gated = /(requirePerm|requireAnyPerm|requireSuperAdmin)/.test(m[3]) || gates.some((g) => new RegExp(`\\b${g}\\b`).test(m[3]));
          if (!gated) offenders.push(`${rel}: ${m[1].toUpperCase()} ${m[2]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('configuration checks', () => {
  const base = { ...env, NODE_ENV: 'production', JWT_SECRET: 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0', CORS_ORIGINS: 'https://os.example.in', TRUST_PROXY: 'true', BCRYPT_COST: 12, SUPER_ADMIN_PASSWORD: undefined } as typeof env;
  const run = (e: Partial<typeof env>, cors = ['https://os.example.in']) => preflight({ env: { ...base, ...e } as typeof env, isProd: true, corsOrigins: cors });
  it('a clean production config has no findings; development has none by design', () => {
    expect(run({}).filter((f) => f.code !== 'DB_NO_TLS')).toEqual([]);
    expect(preflight({ env: base, isProd: false, corsOrigins: ['http://localhost:5173'] })).toEqual([]);
  });
  it('flags the mistakes that matter, by name, never by value', () => {
    expect(run({ JWT_SECRET: 'x'.repeat(40) }).map((f) => f.code)).toContain('WEAK_JWT_SECRET');
    expect(run({ JWT_SECRET: 'x'.repeat(40) }).find((f) => f.code === 'WEAK_JWT_SECRET')!.level).toBe('error');
    expect(run({ JWT_SECRET: 'change-this-secret-' + 'q8w7e6r5t4y3u2i1o0p'.repeat(2) }).find((f) => f.code === 'JWT_SECRET_PLACEHOLDER')!.level).toBe('warn');
    const codes = run({ TRUST_PROXY: 'false', SUPER_ADMIN_PASSWORD: 'Abcdef123456' }, ['http://localhost:5173', 'http://x.in']).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['TRUST_PROXY_OFF', 'OWNER_PASSWORD_IN_ENV', 'CORS_LOCALHOST', 'CORS_HTTP']));
    expect(JSON.stringify(run({ SUPER_ADMIN_PASSWORD: 'Abcdef123456' }))).not.toContain('Abcdef123456');
    expect(run({ AISENSY_API_KEY: 'k', AISENSY_WEBHOOK_SECRET: undefined }).map((f) => f.code)).toContain('WEBHOOK_SECRET_MISSING');
  });
});

describe('web security behaviour', () => {
  let w: World, other: World; let ravi: any;
  let rv: ReturnType<typeof client>;
  beforeAll(async () => {
    w = await buildWorld(); other = await buildWorld();
    ravi = await newLearner(w, { full_name: 'Ravi Child', email: `ravi-${uniq()}@kids.test` });
    await w.admin.post(`/api/learners/${ravi.id}/login`, { password: PASSWORD });
    rv = client(await login(ravi.email));
  });
  afterAll(() => { delete process.env.TEST_LIMITS; });

  it('every API answer is uncacheable, traceable and carries the security headers', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const a = await w.admin.get('/api/learners');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.headers['x-content-type-options']).toBe('nosniff'); expect(a.headers['x-powered-by']).toBeUndefined();
    expect(a.headers['permissions-policy']).toContain('camera=()'); expect(a.headers['referrer-policy']).toBeTruthy(); expect(a.headers['content-security-policy']).toContain("default-src 'self'");
    // a hostile request id is replaced, a sane one is kept
    expect((await request(app).get('/api/health').set('X-Request-Id', 'bad id with spaces <script>')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await request(app).get('/api/health').set('X-Request-Id', 'client-trace-12345')).headers['x-request-id']).toBe('client-trace-12345');
  });

  it('readiness reports database and migrations; the system page is for admins only', async () => {
    const r = await request(app).get('/api/health/ready');
    expect(r.status).toBe(200); expect(r.body.data.checks).toEqual({ database: true, migrations: true });
    expect((await rv.get('/api/system/status')).status).toBe(403);
    const s = await w.admin.get('/api/system/status');
    expect(s.status).toBe(200);
    expect(s.body.data.migrations.pending).toEqual([]); expect(s.body.data.integrity_ok).toBe(true); expect(s.body.data.integrity.length).toBeGreaterThanOrEqual(8);
    expect(s.body.data.traffic.requests).toBeGreaterThan(0); expect(s.body.data.database.reachable).toBe(true);
    expect(JSON.stringify(s.body)).not.toMatch(/password|secret_key|AISENSY_API_KEY|test-aisensy-key|JWT/i);
  });

  it('the integrity checks really detect a broken invariant', async () => {
    const [{ id: batchId }] = await query(`SELECT id FROM batches WHERE org_id = $1 LIMIT 1`, [w.orgId]);
    await exec(`UPDATE batches SET capacity = 1 WHERE id = $1`, [batchId]);
    const l2 = await newLearner(w, { batch_ids: [] }); const l3 = await newLearner(w, { batch_ids: [] });
    for (const l of [l2, l3]) await exec(`INSERT INTO learner_batch_memberships (id, org_id, learner_id, batch_id, status) VALUES (UUID(), $1, $2, $3, 'active')`, [w.orgId, l.id, batchId]);
    const s = (await w.admin.get('/api/system/status')).body.data;
    expect(s.integrity_ok).toBe(false); expect(s.integrity.find((c: any) => c.id === 'capacity').count).toBeGreaterThanOrEqual(1);
    expect((await other.admin.get('/api/system/status')).body.data.integrity_ok).toBe(true);        // other tenant is unaffected
    await exec(`DELETE FROM learner_batch_memberships WHERE batch_id = $1`, [batchId]);
  });

  it('sign-in does not reveal whether an account exists, and locks after repeated failures', async () => {
    const unknown = await request(app).post('/api/auth/login').send({ email: `nobody-${uniq()}@x.dev`, password: 'whatever-123' });
    const wrong = await request(app).post('/api/auth/login').send({ email: ravi.email, password: 'wrong-password-1' });
    expect(unknown.status).toBe(401); expect(wrong.status).toBe(401); expect(unknown.body.error.message).toBe(wrong.body.error.message);
    for (let i = 0; i < env.MAX_FAILED_LOGINS; i++) await request(app).post('/api/auth/login').send({ email: ravi.email, password: `wrong-${i}-password` });
    const locked = await request(app).post('/api/auth/login').send({ email: ravi.email, password: PASSWORD });
    expect(locked.status).toBeGreaterThanOrEqual(400); expect(locked.status).not.toBe(200);
    await exec(`UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = $1`, [ravi.email]);
    expect((await request(app).post('/api/auth/login').send({ email: ravi.email, password: PASSWORD })).status).toBe(200);
  });

  it('cookie sessions need the CSRF token; bearer clients do not; refresh tokens are single-use; logout ends token-only sessions', async () => {
    const agent = request.agent(app);
    const li = await agent.post('/api/auth/login').send({ email: ravi.email, password: PASSWORD });
    expect(li.status).toBe(200);
    const csrf = li.body.data.csrf_token;
    expect((await agent.post('/api/auth/change-password').send({ current_password: PASSWORD, new_password: PASSWORD + 'x' })).status).toBe(403);   // no CSRF header
    expect((await agent.post('/api/auth/change-password').set('X-CSRF-Token', 'not-the-token').send({ current_password: PASSWORD, new_password: PASSWORD + 'x' })).status).toBe(403);
    const refreshCookie = (li.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rk_rt='))!.split(';')[0].slice(6);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: refreshCookie })).status).toBe(200);
    expect((await request(app).post('/api/auth/refresh').send({ refresh_token: refreshCookie })).status).toBe(401);           // already used
    void csrf;
    const t = (await request(app).post('/api/auth/login').send({ email: ravi.email, password: PASSWORD })).body.data.access_token;
    expect((await request(app).get('/api/dashboard').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${t}`).send({})).status).toBe(200);
    expect((await request(app).get('/api/dashboard').set('Authorization', `Bearer ${t}`)).status).toBe(401);                    // token dies with the session
    expect((await request(app).get('/api/dashboard').set('Authorization', 'Bearer not.a.jwt')).status).toBe(401);
  });

  it('secrets never appear in responses', async () => {
    for (const url of ['/api/users', '/api/teachers', `/api/learners/${ravi.id}`, '/api/auth/me', '/api/audit?page_size=100']) {
      const r = await w.admin.get(url); expect(JSON.stringify(r.body), url).not.toMatch(/password_hash|\$2[aby]\$|refresh_token_hash/);
    }
  });

  it('unknown fields are ignored (no mass assignment) and injection strings are just text', async () => {
    const before = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data;
    const r = await w.admin.patch(`/api/learners/${ravi.id}`, { school: 'DAV', org_id: other.orgId, learner_code: 'HACKED', status: 'archived-ish', deleted_at: '2000-01-01' });
    expect([200, 400]).toContain(r.status);
    const after = (await w.admin.get(`/api/learners/${ravi.id}`)).body.data;
    expect(after.org_id).toBe(before.org_id); expect(after.learner_code).toBe(before.learner_code); expect(after.deleted_at ?? null).toBeNull();
    const inj = await w.admin.get(`/api/learners?q=${encodeURIComponent("' OR 1=1; DROP TABLE learners; --")}`);
    expect(inj.status).toBe(200); expect(inj.body.data).toHaveLength(0);
    expect((await w.admin.get('/api/learners?sort=password_hash')).status).toBe(400);
    expect((await w.admin.get('/api/learners?page=abc')).status).toBe(400);
    expect((await w.admin.get('/api/learners/not-a-uuid')).status).toBe(400);
    expect((await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json')).status).toBe(400);
  });

  it('the expensive endpoints are rate limited per user', async () => {
    process.env.TEST_LIMITS = '1';
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await w.admin.post('/api/reports/batch/export', { format: 'csv' })).status);
    delete process.env.TEST_LIMITS;
    expect(codes.slice(0, 12).every((c) => c === 200)).toBe(true); expect(codes.slice(12)).toEqual([429, 429]);
    expect((await client(await login(other.adminEmail)).post('/api/reports/batch/export', { format: 'csv' })).status).toBe(200);   // another user is not throttled by this one
  });

  it('housekeeping removes only what has no business value', async () => {
    const f = await exec(`INSERT INTO files (id, org_id, uploader_user_id, original_name, mime_type, size_bytes, sha256, data, created_at) SELECT UUID(), $1, id, 'old.pdf', 'application/pdf', 4, 'x', 'abcd', DATE_SUB(NOW(3), INTERVAL 5 DAY) FROM users WHERE org_id = $1 LIMIT 1`, [w.orgId]);
    expect(f.affectedRows).toBe(1);
    await exec(`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) SELECT UUID(), id, SHA2(UUID(), 256), DATE_SUB(NOW(3), INTERVAL 40 DAY) FROM users WHERE org_id = $1 LIMIT 1`, [w.orgId]);
    const learnersBefore = Number((await query(`SELECT COUNT(*) AS n FROM learners WHERE org_id = $1`, [w.orgId]))[0].n);
    const r = await runMaintenance();
    expect(r.orphan_files).toBeGreaterThanOrEqual(1); expect(r.expired_sessions).toBeGreaterThanOrEqual(1);
    expect(Number((await query(`SELECT COUNT(*) AS n FROM learners WHERE org_id = $1`, [w.orgId]))[0].n)).toBe(learnersBefore);
    expect(Number((await query(`SELECT COUNT(*) AS n FROM audit_logs WHERE org_id = $1`, [w.orgId]))[0].n)).toBeGreaterThan(0);
  });
});
