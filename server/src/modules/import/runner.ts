import { exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordActivity } from '../../lib/timeline.js';
import type { AuthUser } from '../../middleware/auth.js';
import { enrollLearners } from '../batches/enrollment.js';
import { createLearner } from '../learners/service.js';
import { linkParent, upsertParent } from '../parents/service.js';
import type { Clean } from './validate.js';

export interface Actor { id: string; email: string; fullName: string; orgWide: boolean; branchIds: string[]; isSuperAdmin: boolean }
export const actorOf = (u: AuthUser): Actor => ({ id: u.id, email: u.email, fullName: u.fullName, orgWide: u.access.orgWide, branchIds: u.access.branchIds, isSuperAdmin: u.isSuperAdmin });
/** The rights the person had when they confirmed, rebuilt for the background run (and for a resume after a restart). */
const userOf = (a: Actor, orgId: string): AuthUser => ({ id: a.id, email: a.email, fullName: a.fullName, userOrgId: orgId, roles: [], isSuperAdmin: a.isSuperAdmin, permissions: new Set(), access: { orgWide: a.orgWide, branchIds: a.branchIds, teacher: false, ownLearnerIds: [] }, sessionId: '' });

const running = new Set<string>();

async function processRow(job: { id: string; org_id: string }, user: AuthUser, row: { id: number; clean: Clean & { existing?: { id: string } | null } }) {
  const c = row.clean; const orgId = job.org_id;
  if (c.existing) {
    // an existing learner: never overwrite their profile, only add what is missing (batches, a parent)
    return tx(async (db) => {
      let added = 0;
      for (const batchId of c.batch_ids) { const r = await enrollLearners({ db, user, orgId }, batchId, [c.existing!.id]); added += r.joined + r.rejoined; }
      if (c.parent) {
        const { parent, created } = await upsertParent(db, orgId, c.parent);
        const has = await queryOne(`SELECT 1 FROM learner_parents WHERE learner_id = $1 AND parent_id = $2`, [c.existing!.id, parent.id], db);
        if (!has) { await linkParent(db, orgId, c.existing!.id, parent.id, c.parent.relationship, false); added++; await recordActivity(db, { orgId, learnerId: c.existing!.id, type: 'parent.linked', title: `Parent linked: ${parent.full_name}`, meta: { parent_id: parent.id, reused: !created, import_job: job.id }, actorUserId: user.id }); }
      }
      return added ? { status: 'merged', learnerId: c.existing!.id, message: `Existing learner updated: ${added} addition(s).` } : { status: 'skipped', learnerId: c.existing!.id, message: 'Already in the system with everything in this row.' };
    });
  }
  return tx(async (db) => {
    const l = await createLearner(db, { user, orgId }, { full_name: c.full_name, email: c.email, date_of_birth: c.date_of_birth, gender: c.gender, school: c.school, location: c.location, branch_id: c.branch_id, enrolled_on: c.enrolled_on, parent: c.parent ?? undefined, batch_ids: c.batch_ids }, c.mobile);
    await recordActivity(db, { orgId, learnerId: l.id, type: 'learner.imported', title: 'Added by CSV import', meta: { import_job: job.id }, actorUserId: user.id });
    return { status: 'created', learnerId: l.id as string, message: `Created ${l.learner_code}.` };
  });
}

/** Work through a confirmed job, 25 rows at a time, one transaction per row. Safe to call twice: rows are claimed with a token. */
export async function processJob(jobId: string) {
  if (running.has(jobId)) return;
  running.add(jobId);
  try {
    const job = await queryOne(`SELECT id, org_id, status, options, created_by FROM import_jobs WHERE id = $1`, [jobId]);
    if (!job || job.status !== 'running') return;
    const user = userOf((job.options as any).actor as Actor, job.org_id);
    for (;;) {
      const live = await queryOne(`SELECT status FROM import_jobs WHERE id = $1`, [jobId]);
      if (live?.status !== 'running') break;
      const token = newId();
      const claimed = await exec(`UPDATE import_rows SET status = 'processing', claim_token = $2 WHERE job_id = $1 AND status IN ('valid','duplicate') ORDER BY row_no LIMIT 25`, [jobId, token]);
      if (!claimed.affectedRows) break;
      const rows = await query(`SELECT id, clean FROM import_rows WHERE job_id = $1 AND claim_token = $2 AND status = 'processing' ORDER BY row_no`, [jobId, token]);
      for (const r of rows) {
        let res: { status: string; learnerId?: string; message: string };
        try { res = await processRow(job, user, r as any); }
        catch (e: any) { res = { status: 'failed', message: (e instanceof AppError ? e.message : 'Unexpected error while saving this row.').slice(0, 300) }; if (!(e instanceof AppError)) logger.error({ err: e, job: jobId, row: r.id }, 'import row failed'); }
        await exec(`UPDATE import_rows SET status = $2, message = $3, learner_id = $4, claim_token = NULL WHERE id = $1`, [r.id, res.status, res.message, res.learnerId ?? null]);
      }
    }
    const left = await queryOne(`SELECT COUNT(*) AS n FROM import_rows WHERE job_id = $1 AND status IN ('valid','duplicate','processing')`, [jobId]);
    const live = await queryOne(`SELECT status FROM import_jobs WHERE id = $1`, [jobId]);
    if (live?.status === 'running' && Number(left!.n) === 0) await finish(job, 'completed');
  } catch (e) { logger.error({ err: e, job: jobId }, 'import job crashed'); }
  finally { running.delete(jobId); }
}

export async function jobCounts(jobId: string) {
  const c: Record<string, number> = { valid: 0, error: 0, duplicate: 0, processing: 0, created: 0, merged: 0, skipped: 0, failed: 0 };
  for (const r of await query(`SELECT status, COUNT(*) AS n FROM import_rows WHERE job_id = $1 GROUP BY status`, [jobId])) c[r.status] = Number(r.n);
  return c;
}

export async function finish(job: { id: string; org_id: string; options?: any }, status: 'completed' | 'cancelled') {
  const counts = await jobCounts(job.id);
  const r = await exec(`UPDATE import_jobs SET status = $2, summary = $3, finished_at = NOW(3) WHERE id = $1 AND status = 'running'`, [job.id, status, JSON.stringify(counts)]);
  if (r.affectedRows) await audit({ orgId: job.org_id, actor: job.options?.actor ? { id: job.options.actor.id, email: job.options.actor.email } as any : null, action: status === 'completed' ? 'import.completed' : 'import.cancelled', entityType: 'import_job', entityId: job.id, next: counts });
}

/** After a restart: jobs that were mid-way continue where they stopped (rows left 'processing' by the crash go back in the queue). */
export async function resumeImports() {
  await exec(`UPDATE import_rows SET status = 'valid', claim_token = NULL WHERE status = 'processing' AND job_id IN (SELECT id FROM (SELECT id FROM import_jobs WHERE status = 'running') j)`);
  for (const j of await query(`SELECT id FROM import_jobs WHERE status = 'running'`)) void processJob(j.id);
}
