# Phase 14 — Admissions, demo classes, WhatsApp replies, receipts and teacher pay

Migration `018_admissions_demo_payroll.sql`. New permissions `payroll:read` (org admin, branch admin, accountant) and `payroll:manage` (org admin). Everything else reuses `crm:*`, `fee:*`, `payment:record` and `comms:*`.

## 1. Admissions: enrol a lead in one step
Learner profile → **Admit**. Choose a batch, optionally a fee plan (with discount and start date) and the first payment received, **Preview**, then **Confirm**.
* One transaction: seat in the batch (capacity enforced under a lock), fee assigned, first payment recorded, lead marked **converted** with the batch it ended in, an `admission_confirmed` entry on the CRM timeline, audit row. If any step is refused (batch full, bad payment) **nothing is saved**.
* Repeating is harmless: an existing seat and fee are kept, and the payment's request id stops a double charge.
* Needs `crm:manage`; the fee plan needs `fee:manage` and the payment needs `payment:record`, so a counsellor without those can still admit without money.
* API: `POST /api/admissions/enrol/:learnerId` (`dry_run` or `confirm`).

## 2. Demo classes and the public booking page
**CRM → Demo classes.** Create slots (title, time, seats, online link or place), switch **Accept online bookings** on, and share the link `https://<domain>/book-demo/<school-slug>` on social media or WhatsApp.
* The page is **off until you switch it on**. When off, it behaves exactly like a page that does not exist.
* A parent picks a slot and gives child name, parent name, mobile (and optional e-mail). The app creates the child, links the parent (siblings share one parent by mobile), and a **CRM lead in "demo scheduled"** with source "Demo booking page". The same child is reused when the same parent books again. Created on behalf of whoever published the slot, so the audit trail names a person.
* Abuse protection: a hidden honeypot field (bots look successful and create nothing), 6 bookings per minute per address, 4 per phone per day, at most two upcoming demos per child, and the slot row is locked so **the last seat can only be taken once**. The page returns nothing about people already on file, and the online link is shown only after booking (and in the confirmation e-mail).
* Staff mark each booking **Attended** (moves the lead to "demo attended"), **No-show** (gives the counsellor a follow-up for tomorrow) or **Cancel**. Cancelling a slot releases everyone on it and notes it on their lead. Capacity cannot drop below the seats taken.
* A confirmation e-mail goes to the parent when an address was given and e-mail is configured.
* New reminder kind **Demo class reminder** (hours before the demo) in Auto reminders, by WhatsApp or e-mail, once per booking.

## 3. WhatsApp replies (STOP, YES, DEMO)
When the Meta WhatsApp Cloud API webhook is connected (`docs/PHASE-14-META-CLOUD-API.md`), messages people send are processed:
* **STOP / UNSUBSCRIBE / CANCEL / OPT OUT** (the whole message, not a word inside a sentence): the number is added to the opt-out list of every school that knows it. **START** removes it.
* **YES / DEMO / INFO / OFFER / FEES…** from a lead: logged on the CRM timeline, lead moved to "interested", a follow-up due now for the counsellor, and a notification. Any other text from a lead is logged and the counsellor notified.
* A number known to **two schools**: only STOP/START apply to both; other messages are not attributed to either, so one school never reads another's conversation. Unknown numbers opt nobody out.
* Everything lands in **Communication → Replies** (numbers masked). A repeated provider message is ignored.
* **AiSensy:** its Basic plan has no webhooks and inbound replies are not read from AiSensy. Opt-outs stay manual there.

## 4. Receipt e-mails
When a payment is recorded (by staff, at admission, or online), the parent gets an e-mail with the amount, receipt number and what it paid for, plus a link to My fees (primary parent's address, else the learner's). One per payment; a double click sends one. A switch on the Fees page turns it off. Does nothing when e-mail is not configured. (Sending the receipt by WhatsApp needs an approved template and is not included.)

## 5. Teacher workload and pay estimate
**People → Teacher pay.** Pick a month: classes held, cancelled, hours taught and an **estimated pay** (hours × rate) per teacher, with a CSV export. Set each teacher's hourly rate under *Pay rates*; a month uses the rate in force on its last day, so old months keep old rates.
* Only classes marked **completed** count. A class counts for every teacher on the batch that day (lead or assistant), so set assistants' rates accordingly. Classes still open after their start, and classes without an end time, are flagged.
* Branch admins see only their branches. Teachers cannot see it. The CSV neutralises names that could run as spreadsheet formulas and is audited.
* This is an estimate for the accountant, not a payslip: no tax, advances or deductions.

## Tested
`server/tests/phase14.test.ts` (17 tests): admission confirmation, rollback on a full batch, idempotence and permissions; demo slots, public booking, honeypot, last-seat race, attended/no-show/cancel flows, slot cancellation, demo reminders; reply classification, STOP/START across schools, lead follow-ups, signed webhook; receipt e-mails and the switch; payroll maths, rates, permissions, CSV. Browser run `e2e14`: public booking on a phone, staff view, admission, payroll, replies. Inbound replies were tested against stand-in payloads, not real Meta messages.
