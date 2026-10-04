# Robokalam Learner OS

> **One Operating System for Every Learner.**

LMS · virtual classroom · student information system · gamification · parent engagement · CRM · communication — built for Robokalam and Indian education/training organizations.

**Core rule: one learner = one master profile.** Batches are memberships on that profile (`learner_batch_memberships`, unique per learner+batch); nothing is ever duplicated per batch, and every bulk action de-duplicates by `learner_id` first.

## Status

| Phase | Scope | State |
|---|---|---|
| **1 Foundation** | Organizations, auth, RBAC, teachers/learners/parents, master learner DB, Learner 360°, batches, learner/teacher memberships, batch selection + unique-learner calc, bulk assign/remove/status/export, role dashboards, audit log | ✅ implemented & tested |
| **2 Classroom** | Posts, topics, materials, assignments, submissions, uploads | ✅ [`PHASE-2`](docs/PHASE-2-CLASSROOM.md) |
| **3 Assessment** | Scores with full history, quizzes, gradebook | ✅ [`PHASE-3`](docs/PHASE-3-ASSESSMENT.md) |
| **4 Gamification** | XP ledger, badges, levels, leaderboard | ✅ [`PHASE-4`](docs/PHASE-4-GAMIFICATION.md) |
| **5 Attendance & portal** | Class sessions, attendance, learner & parent portal | ✅ [`PHASE-5`](docs/PHASE-5-ATTENDANCE-PARENT.md) |
| **6 CRM** | Leads, activities, follow-ups, tags | ✅ [`PHASE-6`](docs/PHASE-6-CRM.md) |
| **7 Communication** | AiSensy WhatsApp campaigns, webhooks, announcements | ✅ [`PHASE-7`](docs/PHASE-7-COMMUNICATION.md) |
| **8 Analytics** | Batch comparison, reports registry, CSV/XLSX export | ✅ [`PHASE-8`](docs/PHASE-8-ANALYTICS.md) |
| **12 Branding & app** | Logo, name, colors and custom domain per organization; installable app (PWA) with offline page | ✅ [`PHASE-12`](docs/PHASE-12-BRANDING-PWA.md) |
| **13 E-mail, certificates & calendar** | E-mail channel with password reset, e-mail reminders, personal calendar feeds (Google/Apple/Outlook), certificates with QR and public verification | ✅ [`PHASE-13`](docs/PHASE-13-CERTIFICATES-CALENDAR-EMAIL.md) |
| **11 Live classes** | Zoom meetings from the schedule, automatic attendance from who joined, recordings | ✅ [`PHASE-11`](docs/PHASE-11-LIVE-CLASSES.md) |
| **10 Fees, reminders, import** | Fee plans, installments, payments, receipts, Razorpay payment links, automatic WhatsApp reminders, CSV import | ✅ [`PHASE-10`](docs/PHASE-10-FEES-REMINDERS-IMPORT.md) |
| **9 Production hardening** | Security audit, observability, system status, backups, performance, Postman, runbooks | ✅ [`PHASE-9`](docs/PHASE-9-HARDENING.md) |

## Documentation

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system, diagrams, ERD, API, RBAC matrix, selection/dedupe, WhatsApp, CRM, security, roadmap
* [`docs/database/later-phases-schema.sql`](docs/database/later-phases-schema.sql) — full schema for phases 2–9 (validated against migration 001)
* [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Hostinger runbook, env vars, SSL, backups & restore drill, secret rotation, monitoring
* [`docs/Robokalam-Learner-OS-Developer-Guide.pptx`](docs/Robokalam-Learner-OS-Developer-Guide.pptx) — 29-slide step-by-step onboarding deck for junior developers
* [`docs/SECURITY.md`](docs/SECURITY.md) · [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — security model and operations playbook
* [`postman/`](postman) — collection + environment (34 requests, 61 assertions)

## Quick start (development)

Requires Node 22+ and MySQL 8 or MariaDB 10.6+.

```bash
npm install
# create a MySQL/MariaDB database and user (utf8mb4), e.g.:
#   CREATE DATABASE rk_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
#   CREATE USER 'rk'@'localhost' IDENTIFIED BY '…'; GRANT ALL ON rk_dev.* TO 'rk'@'localhost';
cp server/.env.example server/.env               # set DATABASE_URL + JWT_SECRET
npm run migrate                                  # apply SQL migrations
npm run seed -w server                           # platform super admin from SUPER_ADMIN_* env
npm run seed:demo -w server                      # OPTIONAL dev-only demo organization (via the real API)
npm run dev:server                               # API on :4000
npm run dev:web                                  # web on :5173 (proxies /api)
```

Demo org (dev only, after `seed:demo`): `admin@demo.robokalam.test`, `teacher1@demo.robokalam.test`, `aarav@demo.robokalam.test` (learner), `parent@demo.robokalam.test` — password `Demo-Pass-12345`; platform owner `owner@robokalam.test`.
Scale test: `npm run seed:large -w server -- robokalam-demo 100000`.

## Tests

```bash
# needs a MySQL/MariaDB database whose name ends in _test (it is DROPPED and recreated every run)
# TEST_DATABASE_URL=mysql://rk:…@127.0.0.1:3306/rk_test   (the user needs CREATE/DROP rights)
npm test                 # 158 API/integration tests against a real MySQL/MariaDB
npm run typecheck        # server + web
npx newman run postman/robokalam-learner-os.postman_collection.json \
  -e postman/robokalam-learner-os.postman_environment.json --env-var SUPER_ADMIN_PASSWORD=…
```

What the suite proves: tenant isolation (HTTP **and** database FKs), RBAC for admin/branch-admin/teacher/counsellor/learner/parent, one-profile-many-batches, duplicate contact rejection, transfer/rollback, capacity under bulk actions, selection dedupe (same learner in two selected batches counts once), empty selection = nobody, confirmation required, CSV-injection safety, token rotation/lockout/CSRF, audit trail.

## Production

```bash
npm ci && npm run build
npm run migrate:prod -w server && npm run seed:prod -w server
node server/dist/server.js          # serves API + built web app
```
Full Hostinger instructions (hPanel Git deploy and VPS): [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
