import fs from 'node:fs';
import { Router, type Request } from 'express';
import QRCode from 'qrcode';
import { Resvg } from '@resvg/resvg-js';
import { z } from 'zod';
import { Params, queryOne } from '../../db/pool.js';
import { appUrl } from '../../lib/appurl.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireAnyPerm, requireOrg } from '../../middleware/auth.js';
import { getLevels, levelFor } from '../gamification/xp.js';
import { cardSvg, type Card } from './svg.js';

const router = Router(); // mounted at /api/share
router.use(requireOrg, requireAnyPerm('classroom:read', 'portal:learner', 'portal:parent'));
const FONT_DIR = new URL('../../../assets/fonts/', import.meta.url);
const fonts = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map((f) => decodeURIComponent(new URL(f, FONT_DIR).pathname));
const uri = (mime: string, data: Buffer) => `data:${mime};base64,${data.toString('base64')}`;

/** A learner the caller may see (own, a child, or staff in scope). 404 otherwise, so nothing reveals who exists. */
async function visible(req: Request, learnerId: string) {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const l = await queryOne(`SELECT l.id, l.full_name FROM learners l WHERE l.id = ${p.add(learnerId)} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!l) throw notFound('Card');
  return l;
}
/** Children are shown by first name (or first name and last initial), never the full name, and no school or contact details ever appear. */
const display = (full: string, mode: string) => { const [first = '', ...rest] = full.trim().split(/\s+/); return mode === 'short' && rest.length ? `${first} ${rest[rest.length - 1]!.charAt(0).toUpperCase()}.` : first; };

router.get('/cards/:kind/:id.png', limit('share card', 60), wrap(async (req, res) => {
  const q = parse(z.object({ format: z.enum(['story', 'square']).default('story'), name: z.enum(['first', 'short']).default('first') }), req.query);
  const kind = parse(z.enum(['badge', 'xp', 'certificate', 'project']), req.params.kind); const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  const org = await queryOne(`SELECT name, slug, brand_app_name, brand_color, brand_accent, brand_logo_file_id, demo_booking_enabled FROM organizations WHERE id = $1`, [orgId]);
  const orgName = org?.brand_app_name || org?.name || 'Robokalam';
  const logo = org?.brand_logo_file_id ? (await queryOne(`SELECT data, mime_type FROM files WHERE id = $1 AND org_id = $2 AND owner_type = 'branding' AND deleted_at IS NULL`, [org.brand_logo_file_id, orgId])) : null;
  const joinUrl = org?.demo_booking_enabled ? `${appUrl()}/book-demo/${org.slug}` : appUrl();
  const base = { format: q.format, orgName, logoDataUri: logo ? uri(logo.mime_type, logo.data) : null, color: /^#[0-9a-f]{6}$/i.test(org?.brand_color ?? '') ? org!.brand_color : '#12263f', accent: /^#[0-9a-f]{6}$/i.test(org?.brand_accent ?? '') ? org!.brand_accent : '#f5a524',
    qrDataUri: await QRCode.toDataURL(joinUrl, { margin: 1, width: 280 }), cta: org?.demo_booking_enabled ? 'Book a free demo class' : `Learn at ${orgName}`, ctaSmall: 'Scan to find out more', footnote: joinUrl.replace(/^https?:\/\//, '') };
  let card: Card;
  if (kind === 'badge') {
    const r = await queryOne(`SELECT lb.learner_id, bd.name, bd.description, b.name AS batch_name FROM learner_badges lb JOIN badges bd ON bd.id = lb.badge_id LEFT JOIN batches b ON b.id = lb.batch_id WHERE lb.id = $1 AND lb.org_id = $2 AND lb.revoked_at IS NULL`, [id, orgId]);
    if (!r) throw notFound('Card'); const l = await visible(req, r.learner_id);
    card = { ...base, kind, who: display(l.full_name, q.name), headline: 'Badge unlocked!', title: r.name, sub: r.description ?? (r.batch_name ? `Earned in ${r.batch_name}` : 'Earned for great effort'), glyph: 'star', badgeKey: r.name };
  } else if (kind === 'xp') {
    const l = await visible(req, id); const xp = Number((await queryOne(`SELECT COALESCE(SUM(points), 0) AS n FROM xp_transactions WHERE learner_id = $1`, [l.id]))!.n);
    const { levels } = await getLevels(orgId); const lv = levelFor(xp, levels);
    const badges = Number((await queryOne(`SELECT COUNT(*) AS n FROM learner_badges WHERE learner_id = $1 AND revoked_at IS NULL`, [l.id]))!.n);
    let rank: string | null = null;
    if ((await queryOne(`SELECT leaderboard_enabled AS e FROM gamification_settings WHERE org_id = $1`, [orgId]))?.e) {
      const b = await queryOne(`SELECT b.id, b.name FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id AND b.deleted_at IS NULL WHERE m.learner_id = $1 AND m.status = 'active' ORDER BY m.created_at LIMIT 1`, [l.id]);
      if (b) { const ahead = Number((await queryOne(`SELECT COUNT(*) AS n FROM (SELECT m.learner_id, COALESCE(SUM(x.points), 0) AS t FROM learner_batch_memberships m LEFT JOIN xp_transactions x ON x.learner_id = m.learner_id WHERE m.batch_id = $1 AND m.status = 'active' GROUP BY m.learner_id) s WHERE s.t > $2`, [b.id, xp]))!.n); rank = `#${ahead + 1} in ${b.name}`; }
    }
    card = { ...base, kind, who: display(l.full_name, q.name), headline: `Level ${lv.level.level_no}: ${lv.level.name}`, title: `${display(l.full_name, q.name)} is levelling up`, stat: { big: `${xp.toLocaleString('en-IN')} XP`, small: `${badges} badge${badges === 1 ? '' : 's'} earned${rank ? ` · ${rank}` : ''}` }, bar: lv.next ? { pct: lv.progress_pct, label: `${lv.xp_to_next} XP to ${lv.next.name}` } : { pct: 100, label: 'Top level reached' }, glyph: 'bolt', badgeKey: `level-${lv.level.level_no}`, badgeLabel: `LV ${lv.level.level_no}` };
  } else if (kind === 'certificate') {
    const c = await queryOne(`SELECT learner_id, title, course_name, batch_name, issued_on, code, revoked_at FROM certificates WHERE id = $1 AND org_id = $2`, [id, orgId]);
    if (!c) throw notFound('Card'); const l = await visible(req, c.learner_id);
    if (c.revoked_at) throw conflict('This certificate was revoked, so it cannot be shared.', 'REVOKED');
    card = { ...base, kind, who: display(l.full_name, q.name), headline: 'Certificate earned!', title: c.course_name ?? c.title, sub: `${c.title} · ${new Date(c.issued_on).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`, glyph: 'trophy', badgeKey: c.course_name ?? c.title, ctaSmall: `Verify at ${appUrl().replace(/^https?:\/\//, '')}/verify/${c.code}` };
    card.qrDataUri = await QRCode.toDataURL(`${appUrl()}/verify/${c.code}`, { margin: 1, width: 280 }); card.cta = 'Scan to verify'; card.footnote = `Certificate ${c.code}`;
  } else {
    const it = await queryOne(`SELECT i.learner_id, i.title, i.description, i.status FROM portfolio_items i WHERE i.id = $1 AND i.org_id = $2 AND i.deleted_at IS NULL`, [id, orgId]);
    if (!it) throw notFound('Card'); const l = await visible(req, it.learner_id);
    if (it.status !== 'published') throw conflict('A teacher has to approve a project before it can be shared.', 'NOT_PUBLISHED');
    const f = await queryOne(`SELECT data, mime_type FROM files WHERE owner_type = 'portfolio' AND owner_id = $1 AND deleted_at IS NULL AND mime_type LIKE 'image/%' ORDER BY created_at LIMIT 1`, [id]);
    card = { ...base, kind, who: display(l.full_name, q.name), headline: 'Look what I built!', title: it.title, sub: it.description ?? undefined, glyph: 'star', badgeKey: it.title, pictureDataUri: f ? uri(f.mime_type, f.data) : null };
  }
  const png = new Resvg(cardSvg(card), { font: { loadSystemFonts: false, fontFiles: fonts, defaultFontFamily: 'DejaVu Sans' }, fitTo: { mode: 'original' } }).render().asPng();
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename="robokalam-${kind}.png"`, 'X-Content-Type-Options': 'nosniff' }).send(png);
}));
export default router;
