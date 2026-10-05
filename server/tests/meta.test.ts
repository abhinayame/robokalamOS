import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { env } from '../src/config/env.js';
import { queryOne } from '../src/db/pool.js';
import { app, ensureMigrated, uniq } from './helpers.js';
import { MetaProvider, parseMetaWebhook } from '../src/modules/comms/aisensy.js';

let server: http.Server; let seen: { url: string; auth: string | undefined; body: any }[] = []; let reply: { status: number; body: any } = { status: 200, body: {} };
beforeAll(async () => {
  await ensureMigrated();
  server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { seen.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(b || '{}') }); res.writeHead(reply.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply.body)); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  (env as any).META_API_BASE = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.close(); });

describe('Meta WhatsApp Cloud API provider', () => {
  const m = { destination: '919876543210', campaignName: 'fee_due_v1', userName: 'Ravi', templateParams: ['Ravi Parent', 'Line1\nLine2   x', ''] };
  it('sends an approved template with body parameters and the bearer token', async () => {
    seen = []; reply = { status: 200, body: { messages: [{ id: 'wamid.ABC' }] } };
    const r = await new MetaProvider().send(m);
    expect(r).toEqual({ ok: true, providerId: 'wamid.ABC' });
    expect(seen[0]!.url).toBe(`/${env.META_API_VERSION}/${env.META_PHONE_NUMBER_ID}/messages`); expect(seen[0]!.auth).toBe(`Bearer ${env.META_WA_TOKEN}`);
    expect(seen[0]!.body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'template', template: { name: 'fee_due_v1', language: { code: 'en' } } });
    expect(seen[0]!.body.template.components[0].parameters.map((p: any) => p.text)).toEqual(['Ravi Parent', 'Line1 Line2 x', '-']);   // no newlines, never empty
  });
  it('classifies failures and never leaks the token', async () => {
    reply = { status: 400, body: { error: { code: 132001, message: `Template does not exist ${env.META_WA_TOKEN}` } } };
    const bad = await new MetaProvider().send(m); expect(bad).toMatchObject({ ok: false, retriable: false, code: 'META_132001' }); expect(JSON.stringify(bad)).not.toContain(env.META_WA_TOKEN!);
    reply = { status: 400, body: { error: { code: 130429, message: 'Rate limit hit' } } }; expect(await new MetaProvider().send(m)).toMatchObject({ retriable: true });
    reply = { status: 503, body: {} }; expect(await new MetaProvider().send(m)).toMatchObject({ retriable: true });
    reply = { status: 200, body: {} }; expect(await new MetaProvider().send(m)).toMatchObject({ ok: false });                       // 200 without a message id is not a success
  });
});

describe('Meta webhook', () => {
  const body = (id: string, status: string) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id, status, recipient_id: '919876543210', ...(status === 'failed' ? { errors: [{ code: 131026, title: 'Undeliverable' }] } : {}) }] } }] }] });
  const post = (b: object, sig?: string) => { const raw = JSON.stringify(b); return request(app).post('/api/webhooks/meta').set('Content-Type', 'application/json').set('x-hub-signature-256', sig ?? `sha256=${crypto.createHmac('sha256', env.META_APP_SECRET!).update(raw).digest('hex')}`).send(raw); };
  it('parses statuses and ignores customer messages', () => {
    expect(parseMetaWebhook(body('wamid.1', 'delivered'))).toEqual([{ eventKey: 'meta:wamid.1:delivered', providerId: 'wamid.1', status: 'delivered', error: null }]);
    expect(parseMetaWebhook(body('wamid.2', 'failed'))[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('131026') });
    expect(parseMetaWebhook({ entry: [{ changes: [{ value: { messages: [{ id: 'x', text: { body: 'hi' } }] } }] }] })).toEqual([]);
    expect(parseMetaWebhook(null)).toEqual([]);
  });
  it('answers the subscription check only with our verify token', async () => {
    const ok = await request(app).get('/api/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': env.META_VERIFY_TOKEN, 'hub.challenge': '12345' }); expect(ok.status).toBe(200); expect(ok.text).toBe('12345');
    expect((await request(app).get('/api/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token-0', 'hub.challenge': '1' })).status).toBe(403);
    expect((await request(app).get('/api/webhooks/meta')).status).toBe(403);
  });
  it('accepts only correctly signed calls, records them once', async () => {
    const id = `wamid.${uniq()}`; const b = body(id, 'delivered');
    expect((await post(b, 'sha256=deadbeef')).status).toBe(404);
    expect((await request(app).post('/api/webhooks/meta').send(b)).status).toBe(404);                       // no signature at all
    const first = await post(b); expect(first.status).toBe(200); expect(first.body.data).toMatchObject({ received: 1, unmatched: 1 });
    expect((await queryOne(`SELECT provider FROM webhook_events WHERE event_key = $1`, [`meta:${id}:delivered`]))!.provider).toBe('meta');
    expect((await post(b)).body.data).toMatchObject({ duplicate: 1 });                                      // a replay changes nothing
  });
});
