import crypto from 'node:crypto';
import { exec, newId, queryOne, type Db } from '../../db/pool.js';
import { notifyAbout } from '../../lib/notify.js';
import { recordActivity } from '../../lib/timeline.js';

export const TOKENS = ['name', 'course_name', 'batch_name', 'date', 'org_name'];
export const TEMPLATES = ['classic', 'modern', 'playful', 'minimal', 'midnight'] as const;
export type Template = (typeof TEMPLATES)[number];

/** A code people can read out over the phone: no 0/O/1/I/L. */
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const newCode = () => { const b = crypto.randomBytes(8); const c = (i: number) => ALPHA[b[i]! % ALPHA.length]!; return `RKC-${c(0)}${c(1)}${c(2)}${c(3)}-${c(4)}${c(5)}${c(6)}${c(7)}`; };
export const fillBody = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => (TOKENS.includes(k) ? (v[k] ?? '') : m)).replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').trim();
export const fmtDate = (d: string | Date) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export interface IssueArgs {
  orgId: string; orgName: string; design: any; learner: { id: string; full_name: string }; date: string; issuedBy: string | null;
  batch?: { id: string; name: string; course_name: string } | null; courseName?: string | null;
}
/**
 * Give one learner one certificate. The wording, template and colors are frozen on the row, so editing a design later never changes
 * what was issued. Returns the new id, or null when the learner already holds a live certificate of this design (and batch).
 */
export async function issueCertificate(db: Db, a: IssueArgs): Promise<string | null> {
  const course = a.batch?.course_name ?? a.courseName ?? '';
  const body = fillBody(a.design.body_text, { name: a.learner.full_name, course_name: course, batch_name: a.batch?.name ?? '', date: fmtDate(a.date), org_name: a.orgName });
  const id = newId();
  for (let attempt = 0; ; attempt++) {
    try {
      await exec(`INSERT INTO certificates (id, org_id, learner_id, batch_id, design_id, code, title, recipient_name, body, course_name, batch_name, signatory_name, signatory_title, issued_on, issued_by, template, accent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, a.orgId, a.learner.id, a.batch?.id ?? null, a.design.id, newCode(), a.design.title_text, a.learner.full_name, body, course || null, a.batch?.name ?? null, a.design.signatory_name, a.design.signatory_title, a.date, a.issuedBy, a.design.template ?? 'classic', a.design.accent ?? null], db);
      break;
    } catch (e: any) {
      if (e?.errno === 1062 && String(e.message).includes('uq_cert_code') && attempt < 5) continue;
      if (e?.errno === 1062) return null;
      throw e;
    }
  }
  await recordActivity(db, { orgId: a.orgId, learnerId: a.learner.id, type: 'certificate.issued', title: `Certificate issued: ${a.design.title_text}`, meta: { certificate_id: id }, actorUserId: a.issuedBy });
  await notifyAbout(db, { orgId: a.orgId, learnerIds: [a.learner.id], kind: 'certificate.issued', title: 'You received a certificate', body: a.design.title_text, link: '/my-certificates', excludeUserId: a.issuedBy });
  return id;
}

/** Issue the batch's chosen certificate to everyone active in it. Safe to repeat: nobody gets two. */
export async function issueForBatch(db: Db, orgId: string, batchId: string, issuedBy: string | null) {
  const b = await queryOne(`SELECT b.id, b.name, b.completion_certificate_design_id AS design_id, c.name AS course_name FROM batches b JOIN courses c ON c.id = b.course_id WHERE b.id = $1 AND b.org_id = $2 AND b.deleted_at IS NULL FOR UPDATE`, [batchId, orgId], db);
  if (!b?.design_id) return { issued: 0, skipped: 0 };
  const design = await queryOne(`SELECT * FROM certificate_designs WHERE id = $1 AND org_id = $2 AND status = 'active'`, [b.design_id, orgId], db);
  if (!design) return { issued: 0, skipped: 0 };
  const org = await queryOne(`SELECT name FROM organizations WHERE id = $1`, [orgId], db);
  const { query } = await import('../../db/pool.js');
  const members = await query(`SELECT l.id, l.full_name FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id AND l.deleted_at IS NULL WHERE m.batch_id = $1 AND m.status IN ('active','completed') ORDER BY l.full_name`, [batchId], db);
  const date = new Date().toISOString().slice(0, 10); let issued = 0;
  for (const l of members) if (await issueCertificate(db, { orgId, orgName: org?.name ?? '', design, learner: l, date, issuedBy, batch: { id: b.id, name: b.name, course_name: b.course_name } })) issued++;
  await exec(`UPDATE batches SET completion_certificates_issued_at = NOW(3) WHERE id = $1`, [batchId], db);
  return { issued, skipped: members.length - issued };
}
