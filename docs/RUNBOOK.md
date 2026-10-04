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

## Fees, reminders, imports
| Symptom | Check / fix |
|---|---|
| Learner paid online but nothing shows | System Status → *Online payments*: key pair and webhook secret set? In Razorpay → Webhooks, is the URL exactly `https://<domain>/api/webhooks/razorpay` with the same secret, and are deliveries 200? Unmatched events are kept in `webhook_events` (`outcome = unmatched`) |
| Integrity check "installments whose paid amount differs" ≠ 0 | Never edit by hand. Compare `fee_installments.paid_amount` with `SUM(payment_allocations.amount)`; restore a copy from backup and contact the developer |
| Reminders not going out | *Auto reminders* page: rule **On**? Inside its sending hours (or use *Run now*)? WhatsApp connected? Preview shows who would be messaged; the log shows skipped reasons (no number / opted out) |
| Same reminder twice | Should be impossible (unique key per rule+item); report it with the rule name and learner |
| Import stuck at "Importing…" | The app resumes unfinished imports on start; check logs for `import job crashed`. Rows already created stay; re-upload only the failed rows (problem file) |
| Import says batch full | Capacity is enforced per row; raise the batch capacity or enrol fewer learners |

## Live classes (Zoom)
| Symptom | Check / fix |
|---|---|
| "Create Zoom meeting" button missing | System Status → *Live classes*: Zoom key trio set? (all of `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`) |
| Meeting creation fails with a Zoom message | Marketplace app activated? scopes granted? A basic licence allows one meeting at a time per host |
| Class never becomes "Live" / nobody is listed | Event subscription URL exactly `https://<domain>/api/webhooks/zoom`, events ticked, Secret Token equal to `ZOOM_WEBHOOK_SECRET_TOKEN`; Zoom → Event Subscriptions shows delivery status |
| "Reset it by e-mail" missing on sign-in | `SMTP_HOST` and `SMTP_FROM` both set? System Status → e-mail |
| E-mails stay "pending" or "failed" | `GET /api/email/outbox` (staff) shows the last error. Wrong port/secure pair (465 needs `SMTP_SECURE=true`), wrong password, or the sender address not allowed by the mailbox |
| Reset / calendar / certificate links point to the wrong address | Set `APP_URL` to the public https address |
| A person says they get no reminder e-mails | They may have clicked unsubscribe (`email_optouts`); account e-mails like password reset still reach them |
| Many "who is this?" names | Learners join with a nickname. Match each once (it is remembered); ask them to join with their full name |
| Integrity check "Zoom classes … never turned into attendance" ≠ 0 | Open the class → Zoom attendance → *Recalculate* |

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
