import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { app, buildWorld, client, login, PASSWORD, type World } from './helpers.js';
import { query } from '../src/db/pool.js';

let w: World;
beforeAll(async () => { w = await buildWorld(); });

describe('authentication', () => {
  it('rejects unknown user and wrong password with the same generic message', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'nobody@test.dev', password: 'x' });
    const b = await request(app).post('/api/auth/login').send({ email: w.adminEmail, password: 'wrong' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('requires a token for protected routes and never leaks internals', async () => {
    const r = await request(app).get('/api/learners');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    const bad = await request(app).get('/api/learners').set('Authorization', 'Bearer not.a.jwt');
    expect(bad.status).toBe(401);
  });

  it('login returns profile, permissions and httpOnly cookies', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: w.adminEmail, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.data.user.roles).toContain('org_admin');
    expect(r.body.data.user.permissions).toContain('learner:read');
    const cookies = (r.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookies).toMatch(/rk_at=.*HttpOnly/i);
    expect(cookies).toMatch(/rk_rt=.*HttpOnly/i);
    expect(JSON.stringify(r.body)).not.toContain('password_hash');
  });

  it('refresh tokens rotate and cannot be replayed; logout revokes', async () => {
    const agent = request.agent(app);
    const l = await agent.post('/api/auth/login').send({ email: w.adminEmail, password: PASSWORD });
    const csrf = l.body.data.csrf_token;
    const rt = (l.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rk_rt='))!.split(';')[0];
    const r1 = await agent.post('/api/auth/refresh').set('X-CSRF-Token', csrf);
    expect(r1.status).toBe(200);
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', [rt, 'rk_csrf=abc']).set('X-CSRF-Token', 'abc');
    expect(replay.status).toBe(401);
    const out = await agent.post('/api/auth/logout').set('X-CSRF-Token', r1.body.data.csrf_token);
    expect(out.status).toBe(200);
  });

  it('cookie sessions require a CSRF token for writes; bearer clients do not', async () => {
    const agent = request.agent(app);
    const l = await agent.post('/api/auth/login').send({ email: w.adminEmail, password: PASSWORD });
    const noCsrf = await agent.post('/api/programs').send({ name: 'X Prog', code: 'XP1' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
    const withCsrf = await agent.post('/api/programs').set('X-CSRF-Token', l.body.data.csrf_token).send({ name: 'X Prog', code: 'XP1' });
    expect(withCsrf.status).toBe(201);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
  });

  it('locks the account after repeated failures', async () => {
    const email = `lock-${Date.now()}@test.dev`;
    const t = await w.admin.post('/api/teachers', { full_name: 'Lock Me', email, password: PASSWORD });
    expect(t.status).toBe(201);
    for (let i = 0; i < 8; i++) await request(app).post('/api/auth/login').send({ email, password: 'bad' });
    const r = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(r.status).toBe(423);
  });

  it('disabled users cannot log in and existing sessions stop working', async () => {
    const email = `dis-${Date.now()}@test.dev`;
    const t = await w.admin.post('/api/teachers', { full_name: 'Soon Disabled', email, password: PASSWORD });
    const token = await login(email);
    expect((await client(token, w.orgId).get('/api/batches')).status).toBe(200);
    await w.admin.patch(`/api/users/${t.body.data.id}`, { status: 'disabled' });
    expect((await client(token).get('/api/batches')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(403);
  });

  it('writes login and permission changes to the audit log', async () => {
    const rows = await query(`SELECT action FROM audit_logs WHERE org_id = $1`, [w.orgId]);
    expect(rows.map((r) => r.action)).toContain('auth.login');
  });
});
