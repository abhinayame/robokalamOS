# Phase 4: Gamification

XP, badges, levels, the achievement wall and an optional leaderboard.

## XP is a ledger (`004_gamification.sql`)
`xp_transactions` is append-only: balance = `SUM(points)`. There is no editable total anywhere. Corrections and reversals are new negative rows. One writer (`addXp`, `modules/gamification/xp.ts`).
- **Idempotent**: `dedupe_key` is unique; a retried request (same `request_id`) awards nothing twice. `setSourceXp` makes the *net* XP of one source (a score's bonus, a badge's reward) equal a target by appending only the difference, so re-saving never double-counts.
- XP carries the **classroom** (batch) it was earned in; batch/course/program leaderboards rank by XP attributed to those batches.

## Awarding
- Teachers award only inside batches they manage, only to active members, positive and ≤ 500 per award, and must pick a batch. Admins may award without a batch and may deduct (≤ 10,000) as a correction. Learners and parents cannot award.
- **Bulk** uses the Phase 1 engine (`POST /api/bulk/learners`, `award_xp` / `award_badge`): dry-run preview, explicit confirm, learners de-duplicated across batches, scope enforced before anything runs.
- **Bonus XP** (0–500) can be added when scoring an assignment or an activity (completing the Phase 3 hook). Clearing the score reverses its bonus.

## Badges, wall, levels
- Admins define badges (name, icon, category, description, criteria, XP reward, status). Teachers/admins award them; one live award per learner/badge/classroom (re-award is skipped). The XP reward is credited once.
- **Revoke** (admins, or the teacher of that classroom) frees the slot and reverses the reward; both rows stay.
- **Achievement wall**: badge, description, date, awarding teacher, reason, XP.
- **Levels** are optional and per organization: built-in defaults (Explorer … Master) or admin-customised (must start at 0 XP and strictly increase, up to 20); reset restores defaults.

## Leaderboard (optional)
Off by default; admins switch it on or off. Scope: batch (learners/parents of that batch, staff in scope), or course/program/all (staff only), for all time, last 30 days or last 7 days. Ties share a rank; a learner always sees their own position even outside the top N; only names, XP and badge counts are shown.

## Permissions
`gamification:read` (everyone), `gamification:award` (teachers + admins), `gamification:manage` (org admins). Out-of-scope learners and classrooms return 404.

## API
`/api/gamification`: `GET overview|xp|achievements|levels|settings|leaderboard|badges`, `POST xp`, `POST badges`, `PATCH badges/:id`, `POST badges/:id/award`, `POST learner-badges/:id/revoke`, `PUT levels`, `PUT settings`.

## Not in this phase
- Automatic XP rules (e.g. +20 on every submission): XP is awarded by people or as score bonuses for now.
- Per-learner leaderboard opt-out (the org-level switch is the control); weekly/monthly are rolling windows, not calendar periods.
- WhatsApp "badge awarded" messages (Phase 7); Postman requests for Phases 3-4.
