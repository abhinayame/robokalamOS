# Phase 21: discounts, correcting payments, receipt designs, levels and a learner's journey

## Discounts (Fees → a learner → Fees tab)
- **% Give discount / Change discount** on any fee: choose a percentage or rupees, pick a saved discount (Sibling, Early bird, Scholarship…) or write your own, and give a reason. A live box shows what the learner will pay and what is still due.
- The unpaid instalments are re-split in proportion; what was already paid is never touched. A discount can never take the fee below what has been paid. 100% waives the fee; changing or removing the discount later brings the instalments back.
- **History** keeps every change: who, when, why, before and after.
- **Saved discounts** and an **accounts-team limit** live under **Fees → Receipts & discounts**. By default accountants have a free hand; an owner can set a limit (say 20%): anything above it needs an owner.
- The "Give a fee plan to learners" screen has the same saved discounts, a reason, and an optional **Level** label (shown on the ledger and the receipt).

## Correcting payments
- **Edit** a recorded payment (from the learner's Fees tab or Fees → Payments): fix the date, method, reference, note, or even the amount. Totals, dues and the main dashboard follow immediately; an amount change re-spreads the money over the instalments.
- **Cancel** a payment recorded by mistake (for example twice): the instalments it paid reopen, it stops counting in the dashboard and reports, and its receipt is kept and stamped CANCELLED.
- Every change is kept in the payment's **History** (who, when, why, before and after). The receipt keeps its number and says **Corrected (revision n)**; you can e-mail the corrected receipt to the parent.
- Online (Razorpay) payments cannot have their amount, date or method changed, and a payment with a refund cannot have its amount edited or be cancelled.
- New permission `payment:edit` (owners and accountants).

## Receipt designs (Fees → Receipts & discounts)
Three designs, with a live preview (normal, corrected, cancelled): **Classic** (formal bordered page), **Modern** (coloured header, big amount) and **Slip** (narrow strip for a till printer). Each school sets its address, GSTIN/registration number, a line under its name, terms at the bottom, who signs, a colour and whether to show the logo. Every receipt shows the amount in words, what it was paid towards, the fee, discount given, paid so far and **balance due as of that payment**. The designs are our own (no copied templates).

## Levels and the learner's journey (Learner → Journey)
- Give a course a **Level** (Programs & Courses → course → Level).
- The **Journey** tab shows how long the learner has been with the school ("2 years 6 months"), the current level, levels finished, certificates, fees paid across levels, level badges, and every level and batch in order with dates and what was paid.
- **⬆ Move up a level** finishes the old batch, joins the new one, can bill the next level (with a saved discount), and awards **Level N complete** (+100 XP). A celebration with confetti appears, with a button to **share the badge as a picture** (the same branded share image as before).
- Recent badges now glow and carry a NEW tag.

## Migration
`025_fees_pro.sql` (additive): discount fields and history, saved discounts, payment history and voiding, receipt design columns, `fee:discount`, `fee:discount_unlimited` and `payment:edit` permissions, instalment list prices, and course levels.

## Verified
335 server tests (10 new in `phase21.test.ts`). Browser run (`e2e21`): accountant gives a 10% saved discount, corrects a payment date and reads its history, Payments list has Edit and Cancel, owner picks and saves a receipt design, learner moves up a level with fee, discount, confetti and a shared badge picture; no console errors. Receipt PDFs of all three designs were rendered and inspected.
