import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { isConfigured } from './aisensy.js';
import { runWorkerOnce } from './delivery.js';

let timer: NodeJS.Timeout | null = null; let busy = false;

/** Starts the in-process sender. It does nothing until WhatsApp is configured and a campaign is processing. */
export function startCommsWorker() {
  if (env.COMMS_WORKER !== 'true' || timer) return;
  timer = setInterval(async () => {
    if (busy || !isConfigured()) return;
    busy = true;
    try { const s = await runWorkerOnce(); if (s.claimed) logger.info(s, 'whatsapp worker pass'); }
    catch (e) { logger.error({ err: e }, 'whatsapp worker pass failed'); }
    finally { busy = false; }
  }, 4000);
  timer.unref();
}
export function stopCommsWorker() { if (timer) clearInterval(timer); timer = null; }
