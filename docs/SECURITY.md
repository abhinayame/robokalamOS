# Security model

What the app enforces, where it is enforced, and where the tests prove it. Written from the Phase 9 audit.

## Identity & sessions
- Passwords: bcrypt (`BCRYPT_COST`, default 12), policy checked server-side; sign-in never reveals whether an account exists (same message and a dummy hash comparison for unknown emails).
- Account lockout after `MAX_FAILED_LOGINS` (default 8) for `LOCKOUT_MINUTES`; per-IP sign-in rate limit. *Trade-off:* someone who knows a staff email can lock that account for 15 minutes; the owner can still unlock by waiting or via the database. Accepted over allowing guessing.
- Access token (JWT, 15 min) + **single-use rotating refresh token** stored hashed in `auth_sessions`. Reusing a refresh token fails. Logout revokes the session even for token-only clients. Changing the password signs out every other device.
- Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production. Cookie-authenticated writes require a **CSRF double-submit token**; Bearer-token calls are exempt (they are not ambient).
- Known limitation: refresh-token *reuse* is rejected but does not revoke the whole session family.

## Authorization
- **RBAC:** every API route declares the permission it needs (`requirePerm`). A test (`tests/hardening.test.ts`) scans the route files and fails if a new route has neither a permission nor an entry in a reviewed allow-list (each with a reason), and fails if anything other than `/api/auth`, `/api/health`, `/api/webhooks` is mounted before authentication.
- **Org isolation:** every query is scoped by `org_id`; composite foreign keys `(id, org_id)` make cross-org links impossible at the database level. Super admin acts inside one organization at a time (`X-Org-Id`).
- **Row scope:** teachers see only their batches' learners, learners/parents only themselves. Out-of-scope reads return **404**, not 403, so existence is not leaked.
- **Audit log:** sign-ins (including failures), permission changes, learner/batch/score/XP/badge/campaign changes. Append-only; no API edits it. Soft delete everywhere learner data is concerned.

## Input & output
- All SQL is parameterized; sort/filter columns come from whitelists. Zod validates every body/query/param and strips unknown fields (no mass assignment). Malformed JSON, bad UUIDs and bad enums return 400, never 500.
- Uploads: type verified by **magic bytes** (not extension/MIME), size-limited, served with `nosniff` and a sandboxing CSP.
- CSV/XLSX exports neutralize spreadsheet formula injection (`=`, `+`, `-`, `@` prefixes).
- Helmet CSP, `Referrer-Policy`, `Permissions-Policy` (camera, microphone, geolocation off), `Cache-Control: no-store` on every `/api` response (personal data is never cached by browsers/proxies), gzip compression.
- Errors: 500s return a generic message plus a `request_id`; stack traces and SQL never reach the client. No secret ever appears in an API response (tested).

## Rate limits (per user, else per IP)
sign-in 10 / 15 min · refresh 60/min · change password 10/min · uploads 40/min · exports 12/min · bulk actions 30/min · campaign confirm 10/min · webhook 600/min · general API 300/min.
Behind Hostinger's proxy `TRUST_PROXY=true` is **required**; otherwise every user shares one IP in the limits and the audit log (the app warns at start-up).

## Secrets
Only in environment variables (Hostinger panel). Never in git, logs, API responses or the browser bundle. Webhook URLs contain a secret path segment and are compared in constant time. The WhatsApp provider key is used only by the server. Backups are AES-256-GCM encrypted when `BACKUP_PASSPHRASE` is set. See *Rotating secrets* in `DEPLOYMENT.md`.

## WhatsApp-specific
Opt-outs are honoured before sending; a recipient list is deduplicated by learner and by phone per campaign (enforced by a unique key); campaigns need an explicit confirm step showing the unique-learner count; delivery webhooks are idempotent and unmatched events are kept for replay.

## Money (Phase 10)
Payments are applied under a row lock with idempotency keys, so retries and repeated webhooks cannot double-record. The Razorpay webhook is trusted only with a valid HMAC signature over the raw body (constant-time compare); card data never reaches us because payment happens on Razorpay's hosted page. Fee, payment and refund permissions are separate (`fee:read`, `fee:manage`, `payment:record`, `payment:refund`) and every change is audited. Two integrity checks on System Status flag any installment or payment that does not add up. Imports go through the same creation code as the form, run under the importer's branch rights, and defuse spreadsheet formulas in the problem file.

## Live classes (Phase 11)
The Zoom webhook is trusted only with a valid HMAC signature over the raw body and a timestamp within 5 minutes (replay protection), compared in constant time. Host start links are fetched fresh and never stored; the Zoom client secret never leaves the server or appears in any response. Only https recording links are stored. Automatic attendance never overwrites a teacher's manual mark, and ambiguous names are never guessed.

## Branding and the installable app (Phase 12)
The only unauthenticated additions are three read-only endpoints under `/api/public` that return public branding fields (no ids or settings), the organization's chosen logo (PNG only, `nosniff`, sandbox CSP) and its manifest; they are rate limited, ignore suspended organizations and give unknown organizations the platform default. Logos are verified from their bytes (SVG is refused because it can carry script). The service worker never intercepts or caches `/api/` requests, so personal data cannot end up in a browser cache.

## E-mail, password reset, calendar and certificates (Phase 13)
* Password reset: identical answer for known/unknown addresses, 5/min per IP and 3/hour per account, hashed single-use 30-minute tokens, all sessions revoked on reset, audited, confirmation e-mail sent.
* Public by design, each with its own protection: `/api/public/verify/:code` (code is unguessable, minimal fields, rate limited), `/api/public/calendar/<token>.ics` (256-bit secret token, hash stored, revocable, rate limited, `X-Robots-Tag: noindex`), `/api/public/unsubscribe/<token>` (HMAC-signed, can only opt out).
* E-mail HTML escapes every value; unsubscribe and reset links are built from `APP_URL`, never from request headers. The SMTP password stays in the environment and is scrubbed from error text.
* Certificate PDFs are served only to staff in scope, the learner and their parents; verification never returns contact details.

## Admissions, demo booking, replies and payroll (Phase 14)
* The public demo booking page is opt-in per school, creates nothing for bots (honeypot), is rate limited per address, per phone and per child, locks the slot row, and returns no data about people already on file. The meeting link is shown only after booking.
* Inbound WhatsApp: accepted only with a valid Meta signature over the raw body. STOP applies to every school that knows the number; other text is never attributed when two schools know it.
* Admission is atomic and idempotent; fee and payment steps need their own permissions.
* Payroll needs `payroll:read`, rates need `payroll:manage`, branch admins see only their branches, and the CSV neutralises formula-like text.

## Dependencies
`npm audit --omit=dev` reports 0 vulnerabilities at the time of Phase 9. Re-run before each release.

## Reporting
Security issues: email the platform owner directly; do not open a public issue with details.
