# Phase 13 — E-mail, password reset, calendar feeds and certificates

Migrations: `016_email_calendar.sql`, `017_certificates.sql`. New permissions: `cert:read`, `cert:manage` (org admin and branch admin get both; teachers and counsellors can read).

## 1. E-mail channel (backend only)
Everything that sends mail puts a row in `email_outbox`; a worker (every 5 s, on every server safely, claim token) sends it through SMTP.

| Setting (Hostinger env vars) | Meaning |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (`true` for port 465), `SMTP_USER`, `SMTP_PASSWORD` | Your mail server. Hostinger mailboxes work: host `smtp.hostinger.com`, port 465, secure `true` |
| `SMTP_FROM` | The visible sender, e.g. `Robokalam <no-reply@robokalam.in>` |
| `APP_URL` | The public address (`https://os.robokalam.in`) used in links inside e-mails, calendar feeds and certificate QR codes |
| `EMAIL_WORKER` | `true` (default). Set `false` on a server that must not send |

* **Not configured = off, honestly:** password reset is hidden on the sign-in page, e-mail reminders say "E-mail is not connected", System Status shows e-mail as not configured. Nothing pretends to send.
* **Two categories.** *Transactional* (password reset, "your password was changed") is always sent. *Notification* (reminders) respects opt-outs; every notification carries a signed one-click **unsubscribe** link (`/api/public/unsubscribe/<token>`), which can only opt out the address it was made for.
* **Retries:** a temporary failure (network, 4xx) is retried after 1, 5 and 30 minutes; a permanent one (5xx, bad address) fails at once. A message stuck "sending" for 5 minutes is released. Old rows are deleted after 90 days.
* **Safe content:** every value is HTML-escaped; colors and links are validated; one dedupe key never produces two e-mails.
* The SMTP password is read only from the environment and never logged, returned or stored. Error text is scrubbed of it.
* **Staff view:** `GET /api/email/status`, `GET /api/email/outbox` (needs `comms:read`; never returns bodies).

## 2. Password reset
`Login → "Reset it by e-mail"` → e-mail with a link `/reset-password?token=…`.
* The answer to "forgot password" is **always the same** whether or not the address exists; at most 3 links per hour per account; rate limited per IP.
* Only the **SHA-256 hash** of the token is stored; it works **once**, for **30 minutes**; a newer request cancels older links.
* Resetting enforces the password policy, **signs the person out of every device**, clears any lock-out, writes an audit entry and sends a "your password was changed" e-mail.
* Suspended and deleted accounts get nothing.

## 3. Calendar feeds
Account → **Calendar feed**: "Create my calendar link". Paste it into Google Calendar ("From URL"), Apple Calendar or Outlook; classes then appear and stay up to date (calendar apps refresh every few hours).
* Teachers see the batches they teach; learners and parents see the batches the learner(s) attend. Nothing else.
* The link contains a secret token; **only its hash is stored**, it is shown once, and can be replaced or turned off any time (the old link stops at once). Cancelled classes appear as cancelled.
* Standards: UTC times, RFC 5545 escaping and 75-octet folding, stable UIDs. Feeds cover 30 days back to 120 days ahead.
* `GET /api/calendar/session/:id.ics` downloads a single class.

## 4. Certificates
Certificates (menu) → **New design** (title, wording with `{name} {course_name} {batch_name} {date} {org_name}`, signatory, logo on/off) → **Issue to learners**: choose batches with the usual selector, **preview**, then confirm.
* One learner = one certificate per design and batch; a learner in several selected batches, or issued twice, gets **one**. A revoked certificate can be issued again.
* **Wording is frozen** at issue time. Editing or archiving a design never changes certificates already given.
* Each certificate has a public **code** (`RKC-XXXX-XXXX`, no look-alike characters) and a **QR code** on the PDF (landscape A4 with the organization's logo, brand color and signatory).
* **Public verification** (no sign-in): `/verify/<code>` page and `GET /api/public/verify/:code`. It returns only the name, certificate, course, batch, issuing organization, date and valid/revoked status; no contact details or ids. Revoked certificates show "revoked" and the PDF is stamped REVOKED.
* Learners and parents see theirs under **My certificates**; staff see them on the learner's profile (Certificates tab). PDFs are served only to staff in scope, the learner and their parents.
* Issuing notifies the learner and parents and adds a line to the learner's activity timeline; issuing and revoking are audited.

## 5. Reminders by e-mail
In Auto reminders, a rule can now **send by E-mail**: write a subject and message using the same placeholders as WhatsApp rules. It uses the same triggers, sending hours and once-only log. People with no address are logged as "skipped: no_email", opted-out addresses as "opted_out". For parents it uses the primary parent's e-mail, otherwise any parent with one.

## What was tested
`server/tests/phase13.test.ts` (19 tests) with a stand-in mail server: escaping, dedupe, opt-outs (notification vs transactional), retry/back-off, permanent failure, signed unsubscribe, identical forgot-password answers, single-use and expiring tokens, session revocation, lock-out clearing, ICS escaping/folding, feed scoping (teacher, parent, other batches), revocation of links, certificate issue/dedupe/confirm/frozen wording/PDF access/verification/revoke/re-issue, and e-mail reminders. Browser test `e2e13` covers the screens end to end against a local fake SMTP server. **Real delivery to a real mailbox is something only you can test** after setting the `SMTP_*` variables.
