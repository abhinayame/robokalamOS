import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { contrast, pngSize } from '../src/modules/branding/routes.js';
import { runMaintenance } from '../src/modules/system/maintenance.js';

let w: World, other: World; let slug = '';
let teacher: ReturnType<typeof client>, learner: ReturnType<typeof client>, tok = '';
const png = (w0: number, h0: number) => { // a real PNG header + enough bytes; only the header is inspected
  const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w0, 16); b.writeUInt32BE(h0, 20); return b;
};
const upload = (who: string, body: Buffer) => request(app).post('/api/branding/logo').set('Authorization', `Bearer ${who}`).set('Content-Type', 'application/octet-stream').send(body);
const get = (url: string, host?: string) => { const r = request(app).get(url); if (host) r.set('Host', host); return r; };

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  slug = (await w.admin.get('/api/organizations/current')).body.data.slug;
  tok = await login(w.adminEmail);
  teacher = client(await login(w.teachers.t1.email));
  const l = await newLearner(w, { full_name: 'Brand Kid', email: `bk-${uniq()}@kids.test` });
  await w.admin.post(`/api/learners/${l.id}/login`, { password: PASSWORD }); learner = client(await login(l.email));
});

describe('colour maths and png headers', () => {
  it('computes WCAG contrast and reads PNG sizes', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0); expect(contrast('#12263f', '#ffffff')).toBeGreaterThan(12); expect(contrast('#f5f5f5', '#ffffff')).toBeLessThan(1.2);
    expect(pngSize(png(512, 512))).toEqual({ w: 512, h: 512 }); expect(pngSize(Buffer.from('not a png at all, really not a png.....'))).toBeNull();
  });
});

describe('branding settings', () => {
  it('are for organization admins only', async () => {
    expect((await w.admin.get('/api/branding/settings')).status).toBe(200);
    expect((await teacher.get('/api/branding/settings')).status).toBe(403);
    expect((await learner.put('/api/branding/settings', { color: '#112233' })).status).toBe(403);
    expect((await request(app).get('/api/branding/settings')).status).toBe(401);
  });
  it('save, validate and can be cleared', async () => {
    const ok = await w.admin.put('/api/branding/settings', { app_name: 'Bright Minds', tagline: 'Learn. Build. Grow.', color: '#7A1F3D', accent: '#FFC107', support_email: 'Help@Bright.in', support_phone: '+91 98765 43210', custom_domain: 'Learn.BrightMinds.in' });
    expect(ok.status).toBe(200); expect(ok.body.data).toMatchObject({ app_name: 'Bright Minds', color: '#7a1f3d', accent: '#ffc107', support_email: 'help@bright.in', custom_domain: 'learn.brightminds.in' });
    const bad = await w.admin.put('/api/branding/settings', { color: '#f5f5f5' }); expect(bad.status).toBe(400); expect(bad.body.error.message).toContain('too light');
    expect((await w.admin.put('/api/branding/settings', { color: 'red' })).status).toBe(400);
    expect((await w.admin.put('/api/branding/settings', { accent: '#12' })).status).toBe(400);
    expect((await w.admin.put('/api/branding/settings', { custom_domain: 'https://learn.example.in/path' })).status).toBe(400);
    expect((await w.admin.put('/api/branding/settings', { custom_domain: 'localhost' })).status).toBe(400);
    expect((await w.admin.put('/api/branding/settings', { support_email: 'nope' })).status).toBe(400);
    expect((await w.admin.get('/api/branding/settings')).body.data.color).toBe('#7a1f3d');                      // a rejected save changed nothing
    const dom = await other.admin.put('/api/branding/settings', { custom_domain: 'learn.brightminds.in' }); expect(dom.status).toBe(409); expect(dom.body.error.code).toBe('DOMAIN_TAKEN');
    const clear = await other.admin.put('/api/branding/settings', { app_name: '', color: '' }); expect(clear.status).toBe(200); expect(clear.body.data.app_name).toBeNull();
  });
});

describe('the logo', () => {
  it('must be a square PNG of a size that works as an app icon', async () => {
    expect((await upload(tok, Buffer.from('GIF89a....'))).status).toBe(400);
    expect((await upload(tok, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(tok, png(300, 300))).body.error.message).toContain('between 512 and 2048');
    expect((await upload(tok, png(1024, 512))).body.error.message).toContain('square');
    expect((await upload(await login(w.teachers.t1.email), png(512, 512))).status).toBe(403);
    const ok = await upload(tok, png(512, 512)); expect(ok.status).toBe(201); expect(ok.body.data.logo_url).toMatch(new RegExp(`^/api/public/orgs/${slug}/logo\\?v=[0-9a-f]{10}$`));
  });
  it('is served publicly with safe headers, replaced cleanly, never lost to the upload clean-up, and removable', async () => {
    const pub = await get(`/api/public/orgs/${slug}/logo`);
    expect(pub.status).toBe(200); expect(pub.headers['content-type']).toBe('image/png'); expect(pub.headers['x-content-type-options']).toBe('nosniff'); expect(pub.headers['content-security-policy']).toContain('sandbox');
    const first = (await queryOne(`SELECT brand_logo_file_id AS id FROM organizations WHERE slug = $1`, [slug]))!.id;
    await exec(`UPDATE files SET created_at = DATE_SUB(NOW(3), INTERVAL 30 DAY) WHERE id = $1`, [first]);
    await runMaintenance();
    expect((await queryOne(`SELECT deleted_at FROM files WHERE id = $1`, [first]))!.deleted_at).toBeNull();      // attached to the organization: kept
    expect((await upload(tok, png(640, 640))).status).toBe(201);
    const old = await queryOne(`SELECT deleted_at, OCTET_LENGTH(data) AS n FROM files WHERE id = $1`, [first]); expect(old!.deleted_at).not.toBeNull(); expect(Number(old!.n)).toBe(0);   // the old logo is gone, bytes and all
    expect((await get(`/api/public/orgs/${slug}/logo`)).status).toBe(200);
    expect((await get(`/api/public/orgs/${(await other.admin.get('/api/organizations/current')).body.data.slug}/logo`)).status).toBe(404);   // another organization has none
    expect((await w.admin.del('/api/branding/logo')).status).toBe(200); expect((await get(`/api/public/orgs/${slug}/logo`)).status).toBe(404);
    expect((await w.admin.del('/api/branding/logo')).status).toBe(404);
    await upload(tok, png(512, 512));
  });
});

describe('public branding and the installable app', () => {
  it('answers without a login, with public fields only', async () => {
    const b = (await get(`/api/public/branding?org=${slug}`)).body.data;
    expect(b).toMatchObject({ default: false, slug, app_name: 'Bright Minds', tagline: 'Learn. Build. Grow.', color: '#7a1f3d', accent: '#ffc107', support_email: 'help@bright.in' });
    expect(b.logo_url).toContain(`/api/public/orgs/${slug}/logo`); expect(b.manifest_url).toBe(`/api/public/orgs/${slug}/manifest.webmanifest`);
    expect(Object.keys(b).sort()).toEqual(['accent', 'app_name', 'color', 'default', 'logo_url', 'manifest_url', 'name', 'slug', 'support_email', 'support_phone', 'tagline']);   // no ids, no settings
    expect(JSON.stringify(b)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
  it('finds the organization by its own domain, falls back to the platform default, and ignores suspended or unknown ones', async () => {
    expect((await get('/api/public/branding', 'learn.brightminds.in')).body.data.slug).toBe(slug);
    expect((await get('/api/public/branding', 'LEARN.BRIGHTMINDS.IN')).body.data.slug).toBe(slug);
    const def = (await get('/api/public/branding', 'somewhere.else.in')).body.data; expect(def).toMatchObject({ default: true, name: 'Robokalam Learner OS', color: '#12263f' });
    expect((await get('/api/public/branding?org=does-not-exist')).body.data.default).toBe(true);
    expect((await get("/api/public/branding?org=x'; DROP TABLE organizations;--")).body.data.default).toBe(true);
    await exec(`UPDATE organizations SET status = 'suspended' WHERE slug = $1`, [slug]);
    expect((await get(`/api/public/branding?org=${slug}`)).body.data.default).toBe(true); expect((await get(`/api/public/orgs/${slug}/manifest.webmanifest`)).status).toBe(404);
    await exec(`UPDATE organizations SET status = 'active' WHERE slug = $1`, [slug]);
  });
  it('builds a web-app manifest from the branding, with the logo as the icon', async () => {
    const m = await get(`/api/public/orgs/${slug}/manifest.webmanifest`);
    expect(m.status).toBe(200); expect(m.headers['content-type']).toContain('application/manifest+json');
    expect(m.body).toMatchObject({ name: 'Bright Minds', short_name: 'Bright Minds', theme_color: '#7a1f3d', display: 'standalone', scope: '/', start_url: `/?org=${slug}&source=pwa` });
    expect(m.body.icons.map((i: any) => i.sizes)).toEqual(['192x192', '512x512']); expect(m.body.icons[0].src).toContain('/logo?v=');
    const o = (await other.admin.get('/api/organizations/current')).body.data.slug;
    const plain = await get(`/api/public/orgs/${o}/manifest.webmanifest`);
    expect(plain.body.theme_color).toBe('#12263f'); expect(plain.body.icons.some((i: any) => i.purpose === 'maskable' && i.src === '/icons/maskable-512.png')).toBe(true);
    expect((await get('/api/public/orgs/no-such-org/manifest.webmanifest')).status).toBe(404);
  });
  it('audits every change and ships a safe service worker and manifest', async () => {
    const a = (await query(`SELECT DISTINCT action FROM audit_logs WHERE org_id = $1 AND action LIKE 'organization.%'`, [w.orgId])).map((r) => r.action);
    expect(a).toEqual(expect.arrayContaining(['organization.branding_updated', 'organization.logo_changed', 'organization.logo_removed']));
    const pub = path.resolve(__dirname, '../../web/public');
    const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
    expect(sw).toMatch(/\/api\//); expect(sw).toMatch(/url\.pathname\.startsWith\('\/api\/'\)/);             // API traffic is never cached or intercepted
    expect(sw).not.toMatch(/cache\.put\([^)]*\/api/);
    const man = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
    expect(man).toMatchObject({ display: 'standalone', scope: '/' }); expect(man.icons.length).toBeGreaterThanOrEqual(3);
    for (const i of man.icons) expect(fs.existsSync(path.join(pub, i.src))).toBe(true);
    expect(fs.existsSync(path.join(pub, 'offline.html'))).toBe(true);
  });
});
