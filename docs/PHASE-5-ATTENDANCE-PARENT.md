# Phase 5: Attendance, Parent portal, Notifications, Learner analytics

## Attendance (`005_attendance.sql`)
- **Class sessions** belong to ONE batch: date/time (stored UTC), optional title, status `scheduled → started → completed`, or `cancelled` (and back to `scheduled`). A unique `(batch, start time)` means generating twice never duplicates a class.
- **Generate from the batch schedule**: creates the classes implied by the batch's days and start/end time, in the organization's timezone (DST-safe), within the batch's own start/end dates. Up to ~3 months at a time.
- **Live classes**: a teacher adds a meeting URL (Google Meet, Zoom or any https link; the provider is detected). Learners and parents get a **Join class** button from 15 minutes before the start until the class ends; the link is not sent to the browser before then. WebRTC is reserved as a provider value for later.
- **Marking**: one sheet per class listing the batch's active learners, statuses present / late / absent / excused with an optional note. One mark per learner (duplicates merged), only active members can be marked, cancelled classes cannot be marked, and saving completes the class. Corrections are allowed and audited.
- **Percentages**: `(present + late) ÷ (present + late + absent)`. Excused and unmarked classes are not counted. Everything is reported **per batch first**; the combined figure is labelled as combined. Reports: batch report (per learner, per class, learners under 75%), learner summary (per batch and month by month).
- Access: only the batch's teachers/admins mark; learners and parents see their own/child's marks; other batches and orgs are 404.

## Notifications
In-app only (email/WhatsApp are Phase 7). Created in the same transaction as the event: absent, class cancelled, assignment posted, assignment evaluated/returned, score received, badge awarded. Each goes to the learner's login and every linked parent login, with the child's name. The actor is never notified of their own action. A bell with an unread count and a Notifications page; read state is per user.

## Parent / learner portal (`/portal`)
Child switcher, then: Overview, Classes (with Join), Assignments, Scores, Attendance, XP & badges, Teacher feedback, Announcements, Progress. It reuses the Phase 2-4 endpoints and adds `/api/portal/announcements` and `/api/portal/feedback`. A child in several batches shows all of them, kept separate.

## Learner analytics (`GET /api/analytics/learner`)
Monthly series (default 6 months) from real rows: average score %, attendance %, XP balance, badges, plus assignment completion per batch and course progress (assignments handed in + classes attended, out of assignments set + classes held). Staff only see the learner's batches inside their own scope. Gaps in the data stay gaps in the charts. Shown on the portal and on Learner 360.

## Also fixed in this phase
- **Empty states** on lists from Phases 2-4 (stream, classwork, grades, quizzes, achievements, …) rendered nothing instead of their friendly message; fixed.
- Quiz window validation on edit compared against a missing value; fixed.

## Not in this phase
- Email/WhatsApp/push delivery (Phase 7); announcements to all learners/parents as a campaign (Phase 7).
- Automatic reminders before class; per-user notification preferences.
- Postman requests for Phases 3-5.
