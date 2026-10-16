# Phase 16: LMS, shareable achievements, certificate templates, timetable

## What it adds
| Feature | Who | Where |
|---|---|---|
| **Courses (LMS)**: reading, video/web-link and quiz lessons, reorder, publish | Admin/teacher with `lms:manage` | **Courses (LMS)** |
| **Assign** a course to learners (by batch selector) or to **all staff** (onboarding), with a due date, preview then confirm | `lms:manage` | Courses → Assign |
| **My courses** player with progress, quizzes graded on the server | Learners and staff | **My courses** |
| **Progress tracking**: enrolled / finished / not started / overdue, per person, CSV export | `lms:read` | Courses → Progress |
| **Certificate templates** (Classic, Modern, Playful, Minimal, Midnight) + accent colour + PDF preview | `cert:manage` | Certificates → Designs |
| **Certificate automation**: pick a design per batch; when the batch is marked Completed, everyone gets it once | `cert:manage` | Certificates → Automation |
| **3D badges** drawn as SVG (colour follows the badge) | Everyone | Achievements, Gamification |
| **Share cards**: badge, XP/level, certificate, approved project as a PNG for status (1080x1920) or post (1080x1080), with Robokalam branding and a QR | Learner, parent | 📤 Share buttons |
| **Weekly timetable** with prev/next week, in the school's timezone | Everyone | **Timetable** |

## Rules worth knowing
- Quiz answers are checked on the server and never sent to the browser.
- Finishing a course gives a **learner** the course's certificate automatically. **Staff** get a completion record, not a certificate.
- A certificate keeps the template and accent it was issued with; editing a design later does not change old ones.
- Batch automation runs once per batch (`completion_certificates_issued_at`). Already-completed batches use **Issue** by hand.
- Share cards are generated on request for the signed-in person only. There are **no public links**. A card shows the first name (or first name + initial), never the school, address or phone. The QR points to the demo page (if demo booking is on) or the app; certificate cards point to the verify page.
- Cards are rendered with `@resvg/resvg-js` and bundled DejaVu fonts (`server/assets/fonts`), so the server needs no system fonts. Emoji are not rendered; glyphs are drawn.

## API
`/api/lms/*` (manage + progress), `/api/learn/*` (own enrollments), `/api/share/cards/:kind/:id.png?format=story|square&name=first|short`, `/api/timetable/week?start=YYYY-MM-DD`, `/api/certificates/designs/:id/preview.pdf`, `/api/certificates/automation`.

## Migration
`020_lms_share_templates.sql`: certificate `template`/`accent`, batch auto-issue columns, four LMS tables, `lms:manage`/`lms:read` permissions.

## Verified
287 server tests (12 new). Browser run (`e2e16`): create course, add reading and quiz lessons, publish, assign to all staff, complete as staff, progress table, template picker, automation tab, share picture renders on a phone, no overflow on `/learn`, `/timetable`, `/achievements`.
