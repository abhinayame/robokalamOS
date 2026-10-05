import crypto from 'node:crypto';
import { Router } from 'express';
import { exec, tx } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { limit } from '../../middleware/limits.js';
import { verifyWebhook, validationAnswer } from './zoom.js';
import { finalizeAttendance, onMeetingEnded, onMeetingStarted, onParticipantJoined, onParticipantLeft, onRecording, sessionByMeeting, type Outcome } from './service.js';

/**
 * Zoom webhooks. Public by necessity, so every event except the one-time URL challenge must carry a valid signature
 * (`v0=HMAC-SHA256(secret, "v0:<timestamp>:<raw body>")`, timestamp within 5 minutes). Anything else looks like a 404.
 * Events are stored in `webhook_events`, so a repeated delivery is a no-op.
 */
const router = Router();

router.post('/zoom', limit('webhook', 600), async (req, res) => {
  const body = req.body as any; const raw = (req as any).rawBody as Buffer | undefined;
  if (body?.event === 'endpoint.url_validation' && body?.payload?.plainToken) return void res.json(validationAnswer(String(body.payload.plainToken)));
  if (!verifyWebhook(raw, req.get('x-zm-signature'), req.get('x-zm-request-timestamp'))) return void res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  const event = String(body?.event ?? ''); const o = body?.payload?.object ?? {};
  const key = crypto.createHash('sha256').update(raw!).digest('hex');
  try {
    let finalizeId: string | null = null;
    const outcome = await tx(async (db) => {
      try { await exec(`INSERT INTO webhook_events (provider, event_key, payload, provider_message_id) VALUES ('zoom',$1,$2,$3)`, [key, JSON.stringify(body ?? null).slice(0, 60000), o?.id ? String(o.id) : null], db); }
      catch (e: any) { if (e?.errno === 1062) return 'duplicate' as Outcome; throw e; }
      let out: Outcome = 'ignored';
      if (o?.id && /^(meeting\.(started|ended|participant_joined|participant_left)|recording\.completed)$/.test(event)) {
        const s = await sessionByMeeting(String(o.id), db);
        if (!s) out = 'unmatched';
        else if (event === 'meeting.started') out = await onMeetingStarted(db, s, o.start_time);
        else if (event === 'meeting.participant_joined') out = await onParticipantJoined(db, s, o.participant);
        else if (event === 'meeting.participant_left') out = await onParticipantLeft(db, s, o.participant);
        else if (event === 'meeting.ended') { out = await onMeetingEnded(db, s, o.end_time); finalizeId = s.id; }
        else out = await onRecording(db, s, o);
      }
      await exec(`UPDATE webhook_events SET outcome = $1 WHERE provider = 'zoom' AND event_key = $2`, [out, key], db);
      return out;
    });
    if (finalizeId) await finalizeAttendance(finalizeId);       // after the event is committed: marks are built from the complete join log
    res.json({ ok: true, data: { outcome } });
  } catch (e) {
    logger.error({ err: e }, 'zoom webhook processing failed');
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Could not process the event.' } });   // Zoom retries
  }
});

export default router;
