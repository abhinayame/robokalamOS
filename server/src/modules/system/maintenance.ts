import { sweepLiveSessions } from '../live/service.js';
import { env } from '../../config/env.js';
import { exec } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

/**
 * Housekeeping. Only removes things that have no business value: expired sign-in sessions, uploads nobody attached,
 * old webhook payloads and long-read notifications. Learner records, scores, XP, attendance, audit logs and message
 * logs are never touched.
 */
export async function runMaintenance() {
  const r = {
    expired_sessions: (await exec(`DELETE FROM auth_sessions WHERE (expires_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)) OR (revoked_at IS NOT NULL AND revoked_at < DATE_SUB(NOW(3), INTERVAL 30 DAY))`)).affectedRows,
    orphan_files: (await exec(`UPDATE files SET deleted_at = NOW(3), data = '' WHERE owner_type IS NULL AND deleted_at IS NULL AND created_at < DATE_SUB(NOW(3), INTERVAL 2 DAY)`)).affectedRows,
    old_imports: (await exec(`DELETE FROM import_jobs WHERE (status = 'previewed' AND created_at < DATE_SUB(NOW(3), INTERVAL 7 DAY)) OR (status IN ('completed','cancelled') AND finished_at < DATE_SUB(NOW(3), INTERVAL 180 DAY))`)).affectedRows,
    live_closed: await sweepLiveSessions(),
    old_webhooks: (await exec(`DELETE FROM webhook_events WHERE received_at < DATE_SUB(NOW(3), INTERVAL 90 DAY)`)).affectedRows,
    read_notifications: (await exec(`DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < DATE_SUB(NOW(3), INTERVAL 180 DAY)`)).affectedRows,
    deleted_file_bytes: (await exec(`UPDATE files SET data = '' WHERE deleted_at IS NOT NULL AND deleted_at < DATE_SUB(NOW(3), INTERVAL 30 DAY) AND size_bytes > 0 AND LENGTH(data) > 0`)).affectedRows,
  };
  logger.info(r, 'maintenance finished');
  return r;
}

let timer: NodeJS.Timeout | null = null;
export function startMaintenance() {
  if (env.MAINTENANCE !== 'true' || timer) return;
  const tick = () => runMaintenance().catch((e) => logger.error({ err: e }, 'maintenance failed'));
  setTimeout(tick, 60_000).unref();                                // shortly after start
  timer = setInterval(tick, 6 * 3600_000); timer.unref();
}
export function stopMaintenance() { if (timer) clearInterval(timer); timer = null; }
