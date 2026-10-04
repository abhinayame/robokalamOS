import express, { Router } from 'express';
import { z } from 'zod';
import { exec, newId, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { sha256 } from '../files/store.js';

export const DEFAULT_BRAND = { name: 'Robokalam Learner OS', app_name: 'Robokalam', tagline: 'One Operating System for Every Learner.', color: '#12263f', accent: '#f5a524' };

/** WCAG relative luminance and contrast ratio of two #rrggbb colors. */
const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

const colour = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a color like #12263f.').transform((s) => s.toLowerCase());
const host = z.string().trim().toLowerCase().max(190).regex(/^(?=.{4,190}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Enter a domain like learn.myschool.in (no https://, no path).');
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** PNG width/height from its header, so we can insist on a square logo that works as an app icon. */
export function pngSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.subarray(12, 16).toString() !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// ------------------------------------------------------------------ public: needed before anybody signs in
export const publicRouter = Router();
publicRouter.use(limit('public', 240));
const slugRe = /^[a-z0-9][a-z0-9-]{1,48}$/;

async function findOrg(slug: string | undefined, hostName: string | undefined) {
  const cols = `o.id, o.name, o.slug, o.brand_app_name, o.brand_tagline, o.brand_color, o.brand_accent, o.brand_logo_file_id, o.support_email, o.support_phone, o.updated_at`;
  if (slug && slugRe.test(slug)) return queryOne(`SELECT ${cols} FROM organizations o WHERE o.slug = $1 AND o.status = 'active' AND o.deleted_at IS NULL`, [slug]);
  if (hostName) return queryOne(`SELECT ${cols} FROM organizations o WHERE o.custom_domain = $1 AND o.status = 'active' AND o.deleted_at IS NULL`, [hostName.toLowerCase()]);
  return null;
}
async function logoVersion(o: any) {
  if (!o.brand_logo_file_id) return null;
  const f = await queryOne(`SELECT sha256 FROM files WHERE id = $1 AND org_id = $2 AND owner_type = 'branding' AND deleted_at IS NULL`, [o.brand_logo_file_id, o.id]);
  return f ? String(f.sha256).slice(0, 10) : null;
}
const publicShape = async (o: any) => {
  const v = await logoVersion(o);
  return { default: false, slug: o.slug, name: o.name, app_name: o.brand_app_name || o.name, tagline: o.brand_tagline ?? null, color: o.brand_color || DEFAULT_BRAND.color, accent: o.brand_accent || DEFAULT_BRAND.accent,
    logo_url: v ? `/api/public/orgs/${o.slug}/logo?v=${v}` : null, manifest_url: `/api/public/orgs/${o.slug}/manifest.webmanifest`, support_email: o.support_email ?? null, support_phone: o.support_phone ?? null };
};

/** Branding for the sign-in page: by `?org=slug`, else by the domain the app is opened on, else the platform default. Public fields only. */
publicRouter.get('/branding', wrap(async (req, res) => {
  const o = await findOrg(typeof req.query.org === 'string' ? req.query.org : undefined, req.hostname);
  res.setHeader('Cache-Control', 'public, max-age=60');
  ok(res, o ? await publicShape(o) : { default: true, slug: null, ...DEFAULT_BRAND, logo_url: null, manifest_url: '/manifest.webmanifest', support_email: null, support_phone: null });
}));

publicRouter.get('/orgs/:slug/logo', wrap(async (req, res) => {
  const o = await findOrg(String(req.params.slug), undefined);
  if (!o?.brand_logo_file_id) throw notFound('Logo');
  const f = await queryOne(`SELECT mime_type, data FROM files WHERE id = $1 AND org_id = $2 AND owner_type = 'branding' AND deleted_at IS NULL`, [o.brand_logo_file_id, o.id]);
  if (!f || f.mime_type !== 'image/png') throw notFound('Logo');
  res.setHeader('Content-Type', 'image/png'); res.setHeader('Content-Length', String(f.data.length));
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=3600'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.send(f.data);
}));

publicRouter.get('/orgs/:slug/manifest.webmanifest', wrap(async (req, res) => {
  const o = await findOrg(String(req.params.slug), undefined);
  if (!o) throw notFound('Organization');
  const b = await publicShape(o);
  const icons = b.logo_url
    ? [{ src: b.logo_url, sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: b.logo_url, sizes: '512x512', type: 'image/png', purpose: 'any' }]
    : [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }];
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8'); res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ name: b.app_name, short_name: b.app_name.slice(0, 12), description: b.tagline ?? `${b.app_name} on the Robokalam Learner OS`, id: `/?org=${o.slug}`, start_url: `/?org=${o.slug}&source=pwa`, scope: '/', display: 'standalone', orientation: 'portrait-primary',
    background_color: '#ffffff', theme_color: b.color, lang: 'en-IN', icons });
}));

// ------------------------------------------------------------------ admin
export const adminRouter = Router();
adminRouter.use(requireOrg, requirePerm('org:manage'));

async function settings(orgId: string) {
  const o = await queryOne(`SELECT id, name, slug, brand_app_name, brand_tagline, brand_color, brand_accent, brand_logo_file_id, custom_domain, support_email, support_phone, updated_at FROM organizations WHERE id = $1`, [orgId]);
  if (!o) throw notFound('Organization');
  return { name: o.name, slug: o.slug, app_name: o.brand_app_name, tagline: o.brand_tagline, color: o.brand_color, accent: o.brand_accent, custom_domain: o.custom_domain, support_email: o.support_email, support_phone: o.support_phone,
    logo_url: (await logoVersion(o)) ? `/api/public/orgs/${o.slug}/logo?v=${await logoVersion(o)}` : null, defaults: DEFAULT_BRAND };
}

adminRouter.get('/settings', wrap(async (req, res) => ok(res, await settings(orgIdOf(req)))));

adminRouter.put('/settings', wrap(async (req, res) => {
  const b = parse(z.object({
    app_name: z.preprocess(blank, z.string().trim().min(2).max(40).nullable()).optional(),
    tagline: z.preprocess(blank, z.string().trim().max(160).nullable()).optional(),
    color: z.preprocess(blank, colour.nullable()).optional(), accent: z.preprocess(blank, colour.nullable()).optional(),
    custom_domain: z.preprocess(blank, host.nullable()).optional(),
    support_email: z.preprocess(blank, z.string().trim().toLowerCase().email('Enter a valid e-mail.').max(160).nullable()).optional(),
    support_phone: z.preprocess(blank, z.string().trim().max(30).regex(/^[+\d][\d\s\-()]{5,}$/, 'Enter a phone number.').nullable()).optional(),
  }), req.body);
  if (b.color && contrast(b.color, '#ffffff') < 4.5) throw badRequest('That main color is too light: white text on it would be hard to read. Pick a darker one.', [{ field: 'color', message: `Contrast with white is ${contrast(b.color, '#ffffff').toFixed(1)}:1; it needs at least 4.5:1.` }]);
  const orgId = orgIdOf(req); const prev = await settings(orgId);
  const sets: string[] = []; const vals: unknown[] = [];
  const map: Record<string, string> = { app_name: 'brand_app_name', tagline: 'brand_tagline', color: 'brand_color', accent: 'brand_accent', custom_domain: 'custom_domain', support_email: 'support_email', support_phone: 'support_phone' };
  for (const [k, col] of Object.entries(map)) if ((b as any)[k] !== undefined) { vals.push((b as any)[k]); sets.push(`${col} = $${vals.length + 1}`); }
  if (sets.length) await exec(`UPDATE organizations SET ${sets.join(', ')} WHERE id = $1`, [orgId, ...vals]).catch((e) => { if (e?.errno === 1062) throw conflict('That domain is already used by another organization.', 'DOMAIN_TAKEN'); throw e; });
  const next = await settings(orgId);
  await audit({ orgId, actor: req.user, action: 'organization.branding_updated', entityType: 'organization', entityId: orgId, previous: { ...prev, logo_url: undefined, defaults: undefined }, next: { ...next, logo_url: undefined, defaults: undefined }, req });
  ok(res, next);
}));

/** The logo: a square PNG, 512-2048 px, up to 1 MB. It doubles as the installed app's icon. */
adminRouter.post('/logo', limit('upload', 40), express.raw({ type: () => true, limit: '1mb' }), wrap(async (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || !buf.length) throw badRequest('Send the PNG file as the request body.');
  const sz = pngSize(buf);
  if (!sz) throw badRequest('The logo must be a PNG file.');
  if (sz.w !== sz.h) throw badRequest(`The logo must be square (yours is ${sz.w}×${sz.h}).`);
  if (sz.w < 512 || sz.w > 2048) throw badRequest(`The logo must be between 512 and 2048 pixels wide (yours is ${sz.w}). It is also used as the app icon.`);
  const orgId = orgIdOf(req); const id = newId();
  await tx(async (db) => {
    const prev = await queryOne(`SELECT brand_logo_file_id FROM organizations WHERE id = $1 FOR UPDATE`, [orgId], db);
    await exec(`INSERT INTO files (id, org_id, uploader_user_id, original_name, mime_type, size_bytes, sha256, owner_type, owner_id, data) VALUES ($1,$2,$3,'logo.png','image/png',$4,$5,'branding',$6,$7)`, [id, orgId, req.user!.id, buf.length, sha256(buf), orgId, buf], db);
    await exec(`UPDATE organizations SET brand_logo_file_id = $2 WHERE id = $1`, [orgId, id], db);
    if (prev?.brand_logo_file_id) await exec(`UPDATE files SET deleted_at = NOW(3), data = '' WHERE id = $1 AND owner_type = 'branding'`, [prev.brand_logo_file_id], db);
  });
  await audit({ orgId, actor: req.user, action: 'organization.logo_changed', entityType: 'organization', entityId: orgId, next: { size_bytes: buf.length, width: sz.w }, req });
  ok(res, await settings(orgId), undefined, 201);
}));

adminRouter.delete('/logo', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const o = await queryOne(`SELECT brand_logo_file_id FROM organizations WHERE id = $1`, [orgId]);
  if (!o?.brand_logo_file_id) throw notFound('Logo');
  await tx(async (db) => { await exec(`UPDATE organizations SET brand_logo_file_id = NULL WHERE id = $1`, [orgId], db); await exec(`UPDATE files SET deleted_at = NOW(3), data = '' WHERE id = $1 AND owner_type = 'branding'`, [o.brand_logo_file_id], db); });
  await audit({ orgId, actor: req.user, action: 'organization.logo_removed', entityType: 'organization', entityId: orgId, req });
  ok(res, await settings(orgId));
}));
