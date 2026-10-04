import { createHash } from 'node:crypto';
import { Params, exec, query, type Db } from '../../db/pool.js';
import { badRequest, conflict } from '../../lib/errors.js';

/**
 * Upload allow-list. The type is decided from the file CONTENT (magic bytes), never from
 * the name or the browser-supplied Content-Type, so a renamed .exe cannot masquerade as a PDF.
 */
interface Kind { mime: string; kind: 'pdf' | 'ppt' | 'doc' | 'image' | 'other'; magic: (b: Buffer) => boolean; inline: boolean }
const startsWith = (...bytes: number[]) => (b: Buffer) => bytes.every((x, i) => b[i] === x);
const ZIP = startsWith(0x50, 0x4b, 0x03, 0x04);
const OLE = startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const isText = (b: Buffer) => { const s = b.subarray(0, 4096); return !s.includes(0) && Buffer.from(s.toString('utf8'), 'utf8').length >= s.length - 3; };

export const ALLOWED: Record<string, Kind> = {
  pdf:  { mime: 'application/pdf', kind: 'pdf', magic: startsWith(0x25, 0x50, 0x44, 0x46, 0x2d), inline: true },
  png:  { mime: 'image/png', kind: 'image', magic: startsWith(0x89, 0x50, 0x4e, 0x47), inline: true },
  jpg:  { mime: 'image/jpeg', kind: 'image', magic: startsWith(0xff, 0xd8, 0xff), inline: true },
  jpeg: { mime: 'image/jpeg', kind: 'image', magic: startsWith(0xff, 0xd8, 0xff), inline: true },
  gif:  { mime: 'image/gif', kind: 'image', magic: startsWith(0x47, 0x49, 0x46, 0x38), inline: true },
  webp: { mime: 'image/webp', kind: 'image', magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP', inline: true },
  doc:  { mime: 'application/msword', kind: 'doc', magic: OLE, inline: false },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'doc', magic: ZIP, inline: false },
  ppt:  { mime: 'application/vnd.ms-powerpoint', kind: 'ppt', magic: OLE, inline: false },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'ppt', magic: ZIP, inline: false },
  xls:  { mime: 'application/vnd.ms-excel', kind: 'other', magic: OLE, inline: false },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'other', magic: ZIP, inline: false },
  txt:  { mime: 'text/plain; charset=utf-8', kind: 'other', magic: isText, inline: false },
  csv:  { mime: 'text/csv; charset=utf-8', kind: 'other', magic: isText, inline: false },
};

export function sanitizeName(raw: string): string {
  const base = raw.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().replace(/^\.+/, '');
  return base.slice(-150) || 'file';
}

export function inspectFile(name: string, buf: Buffer) {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const spec = ALLOWED[ext];
  if (!spec) throw badRequest(`This file type is not allowed. Use: ${Object.keys(ALLOWED).join(', ')}.`);
  if (!buf.length) throw badRequest('The file is empty.');
  if (!spec.magic(buf)) throw badRequest('The file content does not match its type (is it renamed or damaged?).');
  return { ext, ...spec };
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface FileMeta { id: string; name: string; size: number; mime: string }

/** Attachments of several owners at once: owner_id → files. */
export async function filesFor(ownerType: 'material' | 'assignment' | 'submission', ownerIds: string[], db?: Db): Promise<Map<string, FileMeta[]>> {
  const out = new Map<string, FileMeta[]>();
  if (!ownerIds.length) return out;
  const p = new Params();
  const rows = await query(
    `SELECT id, owner_id, original_name AS name, size_bytes AS size, mime_type AS mime FROM files
      WHERE owner_type = ${p.add(ownerType)} AND owner_id IN ${p.in(ownerIds)} AND deleted_at IS NULL ORDER BY created_at, id`, p.values, db);
  for (const r of rows) out.set(r.owner_id, [...(out.get(r.owner_id) ?? []), { id: r.id, name: r.name, size: r.size, mime: r.mime }]);
  return out;
}

/**
 * Attach uploaded files to an owner. Only the uploader's own, still-unattached (or already-attached-here)
 * files qualify. With `replace`, files previously attached here but not listed are removed.
 */
export async function attachFiles(db: Db, a: { orgId: string; userId: string; ownerType: 'material' | 'assignment' | 'submission'; ownerId: string; fileIds: string[]; replace?: boolean; max?: number }) {
  const ids = [...new Set(a.fileIds)];
  if (ids.length > (a.max ?? 10)) throw badRequest(`You can attach at most ${a.max ?? 10} files.`);
  if (ids.length) {
    const p = new Params();
    const found = await query(
      `SELECT id, owner_type, owner_id FROM files WHERE org_id = ${p.add(a.orgId)} AND uploader_user_id = ${p.add(a.userId)} AND deleted_at IS NULL AND id IN ${p.in(ids)} FOR UPDATE`, p.values, db);
    if (found.length !== ids.length) throw badRequest('One of the attached files was not found. Please upload it again.');
    for (const f of found) {
      if (f.owner_type && !(f.owner_type === a.ownerType && f.owner_id === a.ownerId)) throw conflict('One of the files is already attached somewhere else.');
    }
    const up = new Params();
    await exec(`UPDATE files SET owner_type = ${up.add(a.ownerType)}, owner_id = ${up.add(a.ownerId)} WHERE id IN ${up.in(ids)}`, up.values, db);
  }
  if (a.replace) {
    const dp = new Params();
    await exec(
      `UPDATE files SET deleted_at = NOW(3) WHERE owner_type = ${dp.add(a.ownerType)} AND owner_id = ${dp.add(a.ownerId)} AND deleted_at IS NULL
        ${ids.length ? `AND id NOT IN ${dp.in(ids)}` : ''}`, dp.values, db);
  }
}

export const removeOwnerFiles = (db: Db, ownerType: string, ownerId: string) =>
  exec(`UPDATE files SET deleted_at = NOW(3) WHERE owner_type = $1 AND owner_id = $2 AND deleted_at IS NULL`, [ownerType, ownerId], db);
