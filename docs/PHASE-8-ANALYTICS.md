# Phase 8: Analytics, dashboards and reports

No new tables: every figure is computed from what Phases 1-7 already record, on the server, inside the caller's own access. Migration `008_reports.sql` only adds the `report:read` permission (super admin, org admin, branch admin, teacher, counsellor, accountant).

## Definitions (shown in the app, used everywhere)
- **Attendance %** = (present + late) ÷ (present + late + absent). Excused and unmarked classes are not counted. Batches are never merged unless a figure is explicitly labelled combined.
- **Assignment completion** = hand-ins by current members ÷ (assignments set × current members).
- **Average score** = mean of each score's percentage (score ÷ its maximum).
- **Retention** = current members ÷ (current members + left + transferred). Learners who completed a batch are not counted as churn.
- **Unique learners** for a course/program come from SQL `COUNT(DISTINCT learner_id)`, never by adding batch counts; totals such as attendance are exact sums of raw counts, never averages of averages.

## Dashboards
- **Admin / branch admin / counsellor**: learners, batches, teachers, memberships, plus attendance, average score, waiting for evaluation, classes in the next 7 days, total XP, badges awarded, CRM leads (needs `crm:read`) and WhatsApp campaigns (needs `comms:read`). Everything respects scope (a branch admin sees their branch).
- **Teacher**: today's classes (with attendance marked or not), waiting for evaluation by assignment, recent submissions, assignments, badges awarded in 30 days, attendance and average score of their batches, quick actions.
- **Learner and parent**: **MY PROGRESS** (XP, level, badges, average score, attendance, assignments done/total) plus pending assignments, recent scores, upcoming classes and teacher feedback, per child with a child switcher.

## Batch analytics (Classroom → Insights)
Headline numbers, attendance by month, how learners are spread across score bands, and a list of learners who need a closer look (attendance under 75% with 3+ marked classes, or average under 50% with 2+ scores) with the evidence. Teachers of that batch and admins only; learners and parents see the leaderboard, not class-wide analytics.

## Compare batches (`/analytics`)
2 to 10 batches side by side: learners, attendance, average score, assignment completion, XP, badges, retention, classes held; optional period. A batch outside the caller's scope makes the request 404.

## Reports (`/reports`)
Learner, Batch, Course, Program, Teacher (admins only), Attendance, Score, Achievement, XP, CRM (needs `crm:read`), Communication (needs `comms:read`). Each has its own filters (batch, course, program, branch, status, type, dates). Preview on screen (first 500 rows), **CSV** (UTF-8 with BOM so Excel shows every script correctly; formula-looking text is neutralised), **Excel** (a real `.xlsx`; text is stored as text and never evaluated), and **print / save as PDF** (the page prints just the report). Exports are capped at 50,000 rows, and every export is written to the audit log. A report you may not open looks the same as one that does not exist.

## Not in this phase
- Scheduled or emailed reports, saved report templates, a server-rendered PDF file (printing to PDF uses the browser).
- Revenue and fee analytics (no payments module yet); a global search across entities.
- Postman requests for Phases 3-8.
