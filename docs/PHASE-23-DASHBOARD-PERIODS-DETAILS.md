# Phase 23 – Dashboard periods and "see details"

## What it does
- **Period picker** on the admin and teacher dashboards: Week, Month, Quarter, Half-year, Year, All time, or a custom date range. The choice is remembered per browser. Weeks start on Monday; every period ends today, in the school's time zone.
- **Every number opens its records.** Click a tile (for example *Collected this month ₹30,000*) to see the payments behind it: who paid, when, receipt number, method and amount, with totals that add up to the tile. Each row opens the learner (or batch / assignment). The sheet has **Download CSV** and a link to the full page.

## Which numbers follow the period
| Follows the period | Always "as of today" |
|---|---|
| Collected (payments, people who paid), new learners, attendance, average score, XP, badges, new / converted leads | Fees outstanding and overdue, learners not in a batch, work waiting for evaluation, classes in the next 7 days, batch and teacher counts |

## API
- `GET /api/dashboard?period=week|month|quarter|half|year|all` or `?from=YYYY-MM-DD&to=YYYY-MM-DD` (custom). The response then carries `period: { key, label, start, end }`, `kpis.fees.collected / payments / payers`, `kpis.new_learners` and `kpis.crm.new_in_period / converted_in_period`. **Without a period the response is unchanged** (all-time activity numbers, `collected_this_month`).
- `GET /api/dashboard/details/:metric?period=…` → `{ title, period, columns, rows, summary, total_rows, truncated, open }` (up to 500 rows).
  Metrics: `collected`, `outstanding`, `overdue`, `learners`, `new_learners`, `without_batch`, `batches`, `teachers`, `attendance`, `scores`, `pending_evaluations`, `xp`, `badges`, `leads`, `classes`.
- Same visibility as the numbers: `dashboard:view` on the router, plus `fee:read` for fee metrics, `learner:read`, `batch:read`, `teacher:read`, `crm:read` where relevant; branch admins and teachers only see their own scope.

Tests: `server/tests/dashboard-details.test.ts`.
