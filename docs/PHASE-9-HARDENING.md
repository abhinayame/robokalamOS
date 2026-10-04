# Phase 9 — Production hardening

Scope: security, performance, backups, logging, monitoring, Postman, deployment, documentation. No new learner-facing features.

## What was added
| Area | What | Where |
|---|---|---|
| Security | Audit and tests for RBAC coverage, auth/session behaviour, CSRF, injection, mass assignment, secrets in responses, per-endpoint rate limits, security headers | [`SECURITY.md`](SECURITY.md), `server/tests/hardening.test.ts` |
| Logging | Request id on every request (`X-Request-Id`, also in 500 bodies), structured access log without bodies/tokens, slow request (>2 s) and slow query (>1.5 s) warnings | `middleware/observe.ts`, `db/pool.ts` |
| Monitoring | `GET /api/health/ready`, in-process metrics (latency percentiles, slowest routes), **Settings → System Status** page, 8 data-integrity checks | `modules/system`, `web/src/pages/SystemStatus.tsx` |
| Configuration safety | Production preflight: refuses a trivially weak `JWT_SECRET`, warns about proxy/CORS/TLS/leftover owner password; never prints values | `lib/preflight.ts` |
| Housekeeping | 6-hourly cleanup of expired sessions, orphan uploads, old webhook logs, read notifications. Never touches learner, score, XP, attendance, audit or message data | `modules/system/maintenance.ts` |
| Backups | Consistent snapshot, optional AES-256-GCM encryption, retention, verify-first restore with typed confirmation and row-count check | `lib/dump.ts`, `scripts/backup.ts`, `scripts/restore.ts`, `tests/backup.test.ts` |
| Performance | Seed + timing tools, covering indexes (migration `010`), report/leaderboard/dashboard query fixes | `dev/seed-perf.ts`, `dev/perf-check.ts`, `010_performance.sql` |
| Postman | Collection now covers Phases 1–8 end to end, 137 requests / 267 assertions, passes on repeated fresh runs with newman | `postman/` |
| Docs | Deployment (all env vars, backup/restore, rotation, monitoring), Security, Runbook | `docs/` |

## Performance at scale
Dataset (local MariaDB, single process, one org): **100,121 learners · 1,508 batches · 300,535 memberships · 800,968 attendance rows · 400,484 submissions · 279,768 scores · 279,768 XP entries · 12,313 CRM leads**.
Reproduce: `npm run seed:large -w server -- robokalam-demo 100000`, `npm run seed:perf -w server -- robokalam-demo 1500`, start the server, then `PERF_PASSWORD=… npx tsx server/dev/perf-check.ts`. Median of 3 calls, includes JSON serialization, excludes network.

|---|---:|---:|---:|---:|
| learners list p1 | 226 ms | 242 ms | 200 | 27 KB |
| learners list deep page | 507 ms | 566 ms | 200 | 27 KB |
| learners search (name) | 228 ms | 274 ms | 200 | 27 KB |
| learners filter by 5 batches | 25 ms | 41 ms | 200 | 26 KB |
| batches list | 433 ms | 473 ms | 200 | 27 KB |
| batch people | 17 ms | 38 ms | 200 | 7 KB |
| dashboard (org admin) | 1819 ms | 1981 ms | 200 | 5 KB |
| selection resolve: 100 batches | 207 ms | 321 ms | 200 | 1 KB |
| selection resolve: all 1,000+ batches | 642 ms | 781 ms | 200 | 1 KB |
| bulk dry run (100 batches) | 87 ms | 123 ms | 200 | 0 KB |
| learner 360 | 10 ms | 13 ms | 200 | 3 KB |
| gradebook (one batch) | 24 ms | 54 ms | 200 | 65 KB |
| attendance summary | 8 ms | 10 ms | 200 | 1 KB |
| leaderboard (batch) | 13 ms | 18 ms | 200 | 3 KB |
| leaderboard (whole org) | 848 ms | 888 ms | 200 | 3 KB |
| gamification overview | 8 ms | 17 ms | 200 | 0 KB |
| batch insights | 42 ms | 89 ms | 200 | 3 KB |
| compare 10 batches | 55 ms | 138 ms | 200 | 6 KB |
| CRM leads list | 291 ms | 329 ms | 200 | 13 KB |
| CRM summary | 117 ms | 127 ms | 200 | 0 KB |
| report: learner | 327 ms | 388 ms | 200 | 158 KB |
| report: batch | 1764 ms | 1928 ms | 200 | 155 KB |
| report: teacher | 100 ms | 125 ms | 200 | 2 KB |
| report: attendance | 140 ms | 182 ms | 200 | 64 KB |
| report: score | 12 ms | 24 ms | 200 | 112 KB |
| report: achievement | 89 ms | 144 ms | 200 | 96 KB |
| report: xp | 31 ms | 76 ms | 200 | 57 KB |
| report: crm | 103 ms | 145 ms | 200 | 127 KB |
| report: communication | 5 ms | 6 ms | 200 | 1 KB |

### What the first run found, and the fix
| Endpoint | Before | After | Fix |
|---|---:|---:|---|
| Dashboard (org admin) | 9.9 s | 1.8 s | covering indexes on attendance/scores/XP; independent aggregates run in parallel |
| Attendance report (all batches) | 15.9 s | 0.14 s | walks batches in name order, a few at a time, stops at the row limit instead of aggregating 800k rows |
| Score report | 2.3 s | 0.01 s | newest rows come straight off an `(org, updated_at)` index |
| Batch report (all 1,508 batches) | 5.2 s | 1.8 s | covering indexes on memberships/submissions/attendance/XP |
| Leaderboard, whole organization | 4.2 s | 0.85 s | `(org, learner)` covering index instead of a 1,500-id `IN` list |

Still the slowest, by nature: the dashboard (counts across 100k learners) and a batch report over *every* batch at once. Both are under 2 s at 100k learners; a filtered report (one course, one branch, one batch) is tens of milliseconds. If the dashboard becomes a problem at several hundred thousand learners, the next step is a short-lived cache or a nightly summary table — not needed at this size.
Rules held throughout: server-side filtering and pagination everywhere (the learner list returns 25 rows of a 100k table in ~0.2 s, deep page 3000 in ~0.5 s), no endpoint loads all learners into the browser, selection of 1,000+ batches resolves unique learners in the database in ~0.6 s.
Indexes were added with `ALTER TABLE … ADD KEY` (migration `010`); on a large live table that takes about a minute and briefly blocks writes to that table, so apply it in a quiet moment (the production tables are still small).

## Backup and restore, measured
203,000 rows / 53 tables: backup 3.3 s (3.25 MB, encrypted), restore into an empty database 9.4 s, row counts verified equal. Procedures in [`DEPLOYMENT.md`](DEPLOYMENT.md) and [`RUNBOOK.md`](RUNBOOK.md).

## Postman
`postman/robokalam-learner-os.postman_collection.json` + `…environment.json` (regenerate with `python3 postman/build.py`). Flows: login, create organization, learner, enroll (one learner in many batches), filter, select multiple batches and compute unique learners, create assignment, submit, evaluate, score and modify score (history checked), award badge, give XP (single, bulk, idempotent retry), learner profile, gradebook, attendance, CRM activity and follow-ups, WhatsApp template/campaign/dry-run audience, webhook processing, campaign status, reports, system status, and a negative/security folder. Run: `newman run postman/robokalam-learner-os.postman_collection.json -e postman/robokalam-learner-os.postman_environment.json` after setting `BASE_URL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` (and `AISENSY_WEBHOOK_SECRET` equal to the server's). The sign-in limit is 10 per minute and the collection signs in 4 times, so wait a minute between runs.
**Needs a live provider (not exercised by Postman):** actual WhatsApp delivery. Without `AISENSY_API_KEY` the collection asserts the honest `NOT_CONFIGURED` behaviour; with a key it asserts the campaign starts processing. Sending is done only by the background worker.

## Known limitations (honest list)
- WhatsApp delivery has only been tested against a stand-in provider; send one real message to yourself before a campaign.
- In-process metrics reset on restart and are per instance.
- `authenticate` runs ~6 small queries per request; fine at this scale, a cache is the next optimization.
- Refresh-token reuse is rejected but does not revoke the whole session family.
- Uploaded files live in the database (simple backups, but large uploads grow it; `UPLOAD_MAX_MB` caps each file).
- Run the sending worker on exactly one instance.
