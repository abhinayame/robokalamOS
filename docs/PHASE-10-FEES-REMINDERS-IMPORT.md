# Phase 10 — Fees & payments, automatic reminders, CSV import

Closes the three biggest gaps against tutor-management platforms such as Wise: **money** (what is owed, what was paid, online payment), **follow-through** (reminders nobody has to remember) and **onboarding** (bring an existing spreadsheet in without creating duplicates).

Migrations: `011_fees.sql`, `012_reminders.sql`, `013_import.sql`. New permissions: `fee:read`, `fee:manage`, `payment:record`, `payment:refund`.

---

## 1. Fees and payments

### Model (all money is `DECIMAL(12,2)` rupees in the database and whole paise in code, so sums never drift)
| Table | Purpose |
|---|---|
| `fee_plans` + `fee_plan_items` | A price split into dated installments ("₹4,000 now, ₹3,000 after 30 days"). Plans that were given to learners cannot be edited (archive and create a new one). |
| `learner_fees` | What one learner owes. **One active fee per learner per plan per batch** (a generated unique key), so giving a plan twice is a no-op. Holds gross, discount and net. |
| `fee_installments` | The dated dues, with `paid_amount` and status `pending / partial / paid / cancelled`. "Overdue" is derived from the due date in the *organization's* timezone. |
| `payments` | Every rupee received: method, receipt number (`PREFIX-RCT-000001`), provider, reference, optional client `request_id` (idempotency). |
| `payment_allocations` | Which installments a payment paid, and how much. Refunds reverse these. |
| `fee_refunds`, `payment_links` | Refund history; hosted Razorpay links and their state. |

### Rules the code enforces (and the tests prove)
* A payment is spread over the learner's open installments **oldest due date first**, or over exactly the installments chosen. More than the learner owes is refused (online payments that arrive after the dues were cleared another way are kept as **credit**, never lost).
* The learner row is locked while a payment is applied, and a repeated `request_id` / provider payment id returns the payment already made. Double-clicking *Record* or a webhook arriving twice cannot double-record.
* A refund takes money back from the **latest-due installments first**; a fee with payments cannot be cancelled (refund first); an installment can never be lowered below what is already paid.
* Fees are assigned through the **selection engine**: choose batches, see the unique learners, preview (`dry_run`), then confirm. A learner in two selected batches is billed once.
* Scope: branch admins and counsellors only see learners they may see; learners and parents see only their own ledger (other ids return 404). Teachers have no fee access.
* Everything is audited (`fee_plan.created`, `fee.assigned`, `payment.recorded`, `payment.refunded`, `payment.link_created`, `fee.cancelled`, `fee.installment_adjusted`, `fee.charge_added`) and written to the learner's timeline.

### Online payments — Razorpay Payment Links
A payment link is a page **hosted by Razorpay**; the learner pays there, so no card data and no API key ever touches our pages or browser.
1. Staff (`payment:record`) or the learner/parent presses **Pay now** → `POST /api/fees/pay-links` creates one link for what is due (the same live link is reused if asked again).
2. Razorpay calls `POST /api/webhooks/razorpay` with `payment_link.paid`. The request is trusted **only** if `X-Razorpay-Signature` equals the HMAC-SHA256 of the exact raw body with `RAZORPAY_WEBHOOK_SECRET` (constant-time compare). Anything else is a 404.
3. The payment is recorded and allocated; the event is stored in `webhook_events` (a repeated event or payment is a no-op). Expired/cancelled links are marked.

Environment variables (set **only** in the Hostinger panel): `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (8+ chars, you choose it and enter the same value in Razorpay → Settings → Webhooks, event *Payment Link: paid*, URL `https://<domain>/api/webhooks/razorpay`). Without the key pair the app runs on manual payments and says so. Startup warns if only some are set.
**Not automated:** refunds of online payments are *recorded* here; issue the real refund in the Razorpay dashboard (the screen says so).
**Tested against a stand-in provider only.** Use Razorpay *test mode* keys and make one small test payment before going live.

### API (all under `/api/fees`)
`GET /status · /summary · /dues · /payments · /plans · /learners/:id · /me` · `POST /plans · /assign · /payments · /pay-links · /learners/:id/fees · /fees/:id/cancel · /payments/:id/refund` · `PATCH /plans/:id · /installments/:id` · `GET /payments/:id/receipt.pdf` (printable receipt; learners may download their own).
Reports registry gains **Fee dues report** and **Fee collections report** (CSV/XLSX like every report). The admin dashboard shows outstanding / overdue / collected this month.

### Screens
**Fees** (Dues · Payments · Plans) for staff; **Fees tab** on Learner 360; **My fees** for learners and parents (balances, Pay now, receipts).

---

## 2. Automatic reminders

A **rule** says *when* and *which WhatsApp template*; the scheduler turns what is due into ordinary campaigns (`kind = 'auto'`), so delivery, retries, opt-outs and delivery webhooks are identical to manual campaigns (they appear in Communication, marked automatic).

| Kind | Fires | Once per |
|---|---|---|
| Fee due soon | N days before the due date | installment |
| Fee overdue | N days after the due date; optionally repeats every M days, at most K times | installment per repeat |
| Class reminder | N hours before a scheduled class | class and learner |
| Absence follow-up | N hours after a learner was marked absent | absence |

* **Never twice:** each reminder first claims a unique `(rule, key)` row in `reminder_log`; the rule row is locked during a pass, so two servers or two clicks cannot double-send.
* **Sending hours** (default 9 am–8 pm, organization timezone): outside them the scheduler waits. *Run now* ignores the window but still never repeats.
* Placeholders per kind, e.g. `{parent_name} {learner_first_name} {amount_due} {due_date} {installment_label} {days_overdue} {class_title} {class_time} {pay_link}`; `{pay_link}` creates a Razorpay link per reminder (before the DB transaction, so locks are never held while waiting on Razorpay).
* A parent with two children (same phone) gets both reminders, in separate waves; learners with no number or opted out are logged as *skipped* with the reason.
* **Preview** shows exactly who would be messaged without writing anything. The pass runs every 5 minutes inside the comms worker (`REMINDERS=true`, default; needs `COMMS_WORKER=true` and a configured AiSensy key).
* Permissions: read = `comms:read`, create/edit/run = `comms:manage`.

---

## 3. CSV import

`Learners → Import CSV` (`learner:create`). **Preview first, then confirm.**
* Columns: `full_name` (required) + `mobile` or `email` (required, otherwise a re-import would duplicate people) and optionally `gender, date_of_birth, school, location, enrolled_on, branch, batches (code or exact name, separated by |), parent_name, parent_mobile, parent_email, relationship`. Header spellings are forgiving (`Name`, `Phone`, `DOB`…); a template is downloadable. Dates accept `2014-05-21` and `21/05/2014`. Up to 5,000 rows per file.
* The preview checks every row (name, Indian mobile, email, date, gender, branch, batches incl. archived/other-branch, parent) and finds duplicates **inside the file** and **against existing learners** (by mobile or email). **Nothing is written** by a preview.
* Confirm needs the reviewed number (`expected_valid`). Duplicates are **skipped**, or — if chosen — an existing learner is only *topped up* (added to batches, parent linked); their profile is never overwritten. One learner = one master profile.
* Rows are processed **one transaction each** in the background (25 at a time, claimed with a token): a full batch fails only its own row, with the reason, and leaves no half-created learner. The page polls progress. A restart resumes unfinished jobs. Cancel stops the rest.
* Creation goes through the same `createLearner` code as the Add-learner form (duplicates, learner code, parent find-or-create by mobile, capacity and branch rights, audit), so the two can never drift. Siblings sharing a parent mobile share **one** parent record.
* Branch admins can only import into their own branch and its batches. Jobs are visible to their creator and org-wide admins only. A problems CSV (formula-injection safe) can be downloaded and fixed.

---

## Operations
* **System Status** now shows online-payment/webhook configuration, enabled reminder rules, reminders queued in 24 h and running imports, and two new **integrity checks that must be zero**: installments whose paid amount differs from their payments, and payments not fully allocated/credited/refunded.
* Maintenance deletes unconfirmed import previews after 7 days and finished jobs after 180 days.
* New env vars: see `docs/DEPLOYMENT.md` (`RAZORPAY_*`, `REMINDERS`).

## Known limits
* Online payments and reminders were tested against stand-in providers; do one real test payment and one real reminder to yourself before relying on them.
* No automatic late fees, no payment gateway other than Razorpay, no multi-currency (INR only), no GST invoices (receipts only).
* Credit (extra online payment) is shown and can be refunded; there is no "apply credit to a new fee" button yet.
