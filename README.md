# Robokalam Learner OS

> **One Operating System for Every Learner.**

LMS · virtual classroom · student information system · gamification · parent engagement · CRM · communication — built for Robokalam and Indian education/training organizations.

**Core rule: one learner = one master profile.** Batches are memberships on that profile (`learner_batch_memberships`, unique per learner+batch); nothing is ever duplicated per batch, and every bulk action de-duplicates by `learner_id` first.

## Status

| Phase | Scope | State |
|---|---|---|
| **1 Foundation** | Organizations, auth, RBAC, teachers/learners/parents, master learner DB, Learner 360°, batches, learner/teacher memberships, batch selection + unique-learner calc, bulk assign/remove/status/export, role dashboards, audit log | ✅ implemented & tested |
| 2–9 | Classroom, assessment, gamification, attendance & parent, CRM, communication (AiSensy WhatsApp), analytics, hardening | designed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), **not built yet** |

## Documentation

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system, diagrams, ERD, API, RBAC matrix, selection/dedupe, WhatsApp, CRM, security, roadmap
* [`docs/database/later-phases-schema.sql`](docs/database/later-phases-schema.sql) — full schema for phases 2–9 (validated against migration 001)
* [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Hostinger Cloud runbook, SSL, backups, logging
* [`postman/`](postman) — collection + environment (34 requests, 61 assertions)

## Quick start (development)

Requires Node 22+ and PostgreSQL 14+.

```bash
npm install
createdb rk_dev                                  # and a role, see server/.env.example
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
# needs a database whose name ends in _test (it is wiped on every run)
createdb rk_test
npm test                 # 52 API/integration tests against real PostgreSQL
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
Full instructions: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
