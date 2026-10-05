import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { isConfigured as zoomConfigured, isWebhookConfigured as zoomWebhook } from '../live/zoom.js';
import { isConfigured as razorpayConfigured, isWebhookConfigured as razorpayWebhook } from '../fees/razorpay.js';
import { env, isProd } from '../../config/env.js';
import { pool, query, queryOne } from '../../db/pool.js';
import { ok, wrap } from '../../lib/http.js';
import { snapshot } from '../../lib/metrics.js';
import { preflight } from '../../lib/preflight.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { isConfigured, isWebhookConfigured } from '../comms/aisensy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../migrations');
const pkgVersion = (() => { try { return JSON.parse(fs.readFileSync(path.resolve(here, '../../../package.json'), 'utf8')).version as string; } catch { return 'unknown'; } })();

export const healthRouter = Router();
/** Readiness: can this instance serve real traffic right now? Public, tells nothing sensitive. */
healthRouter.get('/ready', async (_req, res) => {
  const checks: Record<string, boolean> = { database: false, migrations: false };
  try {
    await query('SELECT 1'); checks.database = true;
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const applied = new Set((await query(`SELECT name FROM schema_migrations`)).map((r) => r.name as string));
    checks.migrations = files.every((f) => applied.has(f));
  } catch { /* reported below */ }
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ ok: ready, data: { status: ready ? 'ready' : 'not_ready', checks } });
});

export const systemRouter = Router();
systemRouter.use(requireOrg, requirePerm('system:read'));

/** Things that must always be zero. A non-zero count means a bug or a manual change somewhere. */
async function integrity(orgId: string) {
  const n = async (sql: string) => Number((await queryOne(sql, [orgId]))!.n);
  const checks = [
    { id: 'capacity', label: 'Batches over capacity', count: await n(`SELECT COUNT(*) AS n FROM batches b WHERE b.org_id = $1 AND b.deleted_at IS NULL AND b.capacity IS NOT NULL AND (SELECT COUNT(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') > b.capacity`) },
    { id: 'dup_membership', label: 'Learners twice in one batch', count: await n(`SELECT COUNT(*) AS n FROM (SELECT learner_id, batch_id FROM learner_batch_memberships WHERE org_id = $1 GROUP BY learner_id, batch_id HAVING COUNT(*) > 1) x`) },
    { id: 'score_range', label: 'Scores above their maximum', count: await n(`SELECT COUNT(*) AS n FROM scores WHERE org_id = $1 AND deleted_at IS NULL AND score > max_score`) },
    { id: 'score_trail', label: 'Scores without a history entry', count: await n(`SELECT COUNT(*) AS n FROM scores s WHERE s.org_id = $1 AND NOT EXISTS (SELECT 1 FROM score_history h WHERE h.score_id = s.id)`) },
    { id: 'campaign_dup_phone', label: 'Campaigns messaging one number twice', count: await n(`SELECT COUNT(*) AS n FROM (SELECT campaign_id, phone FROM whatsapp_recipients WHERE org_id = $1 GROUP BY campaign_id, phone HAVING COUNT(*) > 1) x`) },
    { id: 'stuck_queue', label: 'WhatsApp messages stuck in the queue over 15 minutes', count: await n(`SELECT COUNT(*) AS n FROM whatsapp_recipients WHERE org_id = $1 AND status = 'queued' AND claimed_at < DATE_SUB(NOW(3), INTERVAL 15 MINUTE)`) },
    { id: 'stuck_campaign', label: 'Campaigns still "processing" with nothing left to send', count: await n(`SELECT COUNT(*) AS n FROM whatsapp_campaigns c WHERE c.org_id = $1 AND c.status = 'processing' AND NOT EXISTS (SELECT 1 FROM whatsapp_recipients r WHERE r.campaign_id = c.id AND r.status IN ('pending','queued')) AND c.updated_at < DATE_SUB(NOW(3), INTERVAL 10 MINUTE)`) },
    { id: 'fee_allocation_mismatch', label: 'Fee installments whose paid amount differs from their payments', count: await n(`SELECT COUNT(*) AS n FROM fee_installments i WHERE i.org_id = $1 AND i.paid_amount <> COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.installment_id = i.id), 0)`) },
    { id: 'payment_unaccounted', label: 'Payments that are not fully allocated, credited or refunded', count: await n(`SELECT COUNT(*) AS n FROM payments p WHERE p.org_id = $1 AND p.amount - p.refunded_amount <> COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0) + p.unallocated_amount`) },
    { id: 'live_unmarked', label: 'Zoom classes that ended over an hour ago but were never turned into attendance', count: await n(`SELECT COUNT(*) AS n FROM class_sessions s WHERE s.org_id = $1 AND s.live_ended_at IS NOT NULL AND s.live_ended_at < DATE_SUB(NOW(3), INTERVAL 1 HOUR) AND s.attendance_finalized_at IS NULL AND EXISTS (SELECT 1 FROM live_participants p WHERE p.session_id = s.id)`) },
    { id: 'lead_without_learner', label: 'CRM leads whose learner was removed', count: await n(`SELECT COUNT(*) AS n FROM crm_leads cl JOIN learners l ON l.id = cl.learner_id WHERE cl.org_id = $1 AND l.deleted_at IS NOT NULL AND cl.lead_status NOT IN ('converted','not_interested','lost')`) },
  ];
  return checks.map((c) => ({ ...c, ok: c.count === 0 }));
}

systemRouter.get('/status', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const t0 = Date.now(); await query('SELECT 1'); const dbMs = Date.now() - t0;
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied = await query(`SELECT name, applied_at FROM schema_migrations ORDER BY name`);
  const mem = process.memoryUsage();
  const poolInfo = (pool as any).pool;
  const wa = await queryOne(`SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'queued'), 0) AS queued, COALESCE(SUM(status = 'failed' AND sent_at IS NULL), 0) AS failed FROM whatsapp_recipients WHERE org_id = $1 AND campaign_id IN (SELECT id FROM whatsapp_campaigns WHERE org_id = $1 AND status IN ('processing','scheduled','partially_failed','failed'))`, [orgId]);
  const hook = await queryOne(`SELECT MAX(received_at) AS last FROM webhook_events WHERE provider = 'aisensy'`);
  const sessions = await queryOne(`SELECT COUNT(*) AS n FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.org_id = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW(3)`, [orgId]);
  const failedLogins = await queryOne(`SELECT COUNT(*) AS n FROM audit_logs WHERE org_id = $1 AND action = 'auth.login_failed' AND created_at > DATE_SUB(NOW(3), INTERVAL 24 HOUR)`, [orgId]);
  const checks = await integrity(orgId);
  const findings = preflight();   // names only, never values
  ok(res, {
    app: { version: pkgVersion, node: process.version, environment: isProd ? 'production' : env.NODE_ENV, server_time: new Date().toISOString() },
    database: { reachable: true, latency_ms: dbMs, pool_connections: poolInfo?._allConnections?.length ?? null, pool_waiting: poolInfo?._connectionQueue?.length ?? null },
    migrations: { applied: applied.length, available: files.length, pending: files.filter((f) => !applied.some((a) => a.name === f)), latest: applied.at(-1)?.name ?? null },
    process: { uptime_seconds: Math.round(process.uptime()), memory_mb: { rss: Math.round(mem.rss / 1048576), heap_used: Math.round(mem.heapUsed / 1048576) } },
    traffic: snapshot(),
    fees: { online_payments: razorpayConfigured(), webhook_configured: razorpayWebhook(), last_online_payment_at: (await queryOne(`SELECT MAX(paid_at) AS t FROM payments WHERE provider = 'razorpay'`))?.t ?? null },
    live: { zoom_configured: zoomConfigured(), webhook_configured: zoomWebhook(), last_event_at: (await queryOne(`SELECT MAX(received_at) AS t FROM webhook_events WHERE provider = 'zoom'`))?.t ?? null, classes_live_now: Number((await queryOne(`SELECT COUNT(*) AS n FROM class_sessions WHERE live_started_at IS NOT NULL AND live_ended_at IS NULL`))!.n) },
    reminders: { enabled_rules: Number((await queryOne(`SELECT COUNT(*) AS n FROM reminder_rules WHERE enabled = TRUE`))!.n), queued_last_24h: Number((await queryOne(`SELECT COUNT(*) AS n FROM reminder_log WHERE outcome = 'queued' AND created_at >= DATE_SUB(NOW(3), INTERVAL 24 HOUR)`))!.n) },
    imports: { running: Number((await queryOne(`SELECT COUNT(*) AS n FROM import_jobs WHERE status = 'running'`))!.n) },
    whatsapp: { configured: isConfigured(), webhook_configured: isWebhookConfigured(), worker_enabled: env.COMMS_WORKER === 'true', waiting: Number(wa!.pending), in_flight: Number(wa!.queued), failed_unsent: Number(wa!.failed), last_webhook_at: hook?.last ?? null },
    security: { active_sessions: Number(sessions!.n), failed_logins_24h: Number(failedLogins!.n), config_findings: findings },
    integrity: checks, integrity_ok: checks.every((c) => c.ok),
  });
}));
