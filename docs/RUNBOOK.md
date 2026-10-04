# Operations runbook

Symptom → check → fix. Everything runs as one Node process + MySQL.

## First look (always)
1. `GET /api/health/ready` → `200` means database + migrations are fine. `503` shows which one failed.
2. **Settings → System Status**: red badges and any non-zero integrity check say where to look.
3. Logs (hPanel → app → Logs). Find a failing request by its `request_id` (shown in the 500 response and the `X-Request-Id` header).

## Site down / 503
| Check | Fix |
|---|---|
| `/api/health/ready` says `database: false` | Database host/credentials changed or DB down: verify `DATABASE_URL`/`DB_*` and `DATABASE_SSL`; restart the app |
| `migrations: false` | A migration failed or `AUTO_MIGRATE=false`. Run `npm run migrate:prod -w server`; read the error; **restore from backup before retrying a half-applied release** |
| App won't start, `[config] …` error | Production preflight refused the config (weak `JWT_SECRET`). Fix the variable |
| Everyone logged out after deploy | `JWT_SECRET` changed — expected, sign in again |
| Everyone shares one rate-limit / "too many requests" for all users | `TRUST_PROXY` not `true` |

## Slow
System Status → *Slowest routes* and the `slow query` warnings in logs (SQL text only). Measured reference at 100k learners / 1,500 batches is in `PHASE-9-HARDENING.md`; compare against it. Likely causes: missing index after a schema change, a report over a very large audience (use batch/date filters), or a tiny DB plan (raise `DATABASE_POOL_MAX` only if "pool waiting" > 0).

## WhatsApp
| Symptom | Fix |
|---|---|
| Campaign stays *processing* | System Status → WhatsApp: worker must be *Running* (`COMMS_WORKER=true`, one instance). Integrity check "stuck campaign / queue" names the problem; claims stuck over 5 min are re-queued automatically; the integrity check flags anything over 15 min |
| Messages fail immediately | `AISENSY_API_KEY`/template name/approval in AiSensy; the error text is on each recipient |
| Sent but never *delivered* in the app | Webhook URL in AiSensy must be exactly `https://<domain>/api/webhooks/aisensy/<AISENSY_WEBHOOK_SECRET>`; System Status shows *last delivery callback*. Callbacks that arrive before the send is recorded are kept and replayed once it is |
| Wrong/duplicate numbers | Audience is deduplicated by learner and phone; check learner's parent mobile numbers |

## Data
- **Integrity check non-zero:** do not "fix" by hand. Check *Audit log* around the time it started; restore a test copy from backup to compare; contact the developer with the check name.
- **Learner deleted by mistake:** soft delete — restore via the learner's page (admins) or `UPDATE learners SET deleted_at = NULL WHERE id = …`.
- **Disaster:** follow *Restore* in `DEPLOYMENT.md` (verify → drill into empty DB → `--wipe --confirm-database`). Expect minutes, not hours.

## Release procedure
1. Take a backup (`backup:prod`) and copy it off-server.
2. Merge the PR → Hostinger redeploys → app migrates on start.
3. Check `/api/health/ready`, System Status (all clear), sign in, open a learner, a classroom, Communication.
4. If broken: fix forward if small; otherwise redeploy the previous commit; if a migration ran, restore the backup first.

## Scheduled
Cleanup job runs 60 s after start and every 6 h (`MAINTENANCE=true`). Backups: daily cron. Quarterly: restore drill, secret rotation review, `npm audit`.
