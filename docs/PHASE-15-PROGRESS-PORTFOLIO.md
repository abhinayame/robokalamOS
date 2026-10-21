# Phase 15 — Monthly progress reports and the project portfolio

Migration `019_progress_portfolio.sql`. New permission `portfolio:review` (org admin, branch admin, teacher).

## 1. Monthly progress report
Parents and learners open **Progress report** (menu); staff see a **Progress report** tab on each learner. Pick a month. Everything is computed from what is already recorded, and nothing is made up:
* **Attendance** per batch (present, late, absent, excused) and an overall percentage (present + late over present + late + absent; cancelled classes and unmarked classes do not count).
* **Scores** recorded that month, their average, and the change from the month before.
* **Assignments** due that month and how many were handed in.
* **XP and badges** earned that month.
* **Teacher notes** (below).
* A **PDF** with the school's logo and color.

### Teacher notes
**Classroom → Progress reports**: choose a batch and month and write a short note for each learner (it saves when you leave the box). Only the batch's teachers (and admins in scope) can write; a note can be cleared; future months are refused. Several teachers can each add a note and all appear in the report.

### Sending to parents
On the same screen, **Send reports to parents** (needs `comms:announce`): **preview** shows who will get it, then confirm. Each parent gets an e-mail with the month's highlights and a link to the full report (primary parent's address, else the learner's own).
* A learner is **never sent the same month twice**; learners with nothing recorded are skipped; people with no address are counted and skipped; people who unsubscribed from notification e-mails are respected.
* Needs e-mail configured (`SMTP_*`). If it is not, the screen says so and nothing is sent.

## 2. Project portfolio
**Learners** add a project (name, description, up to 6 pictures or a PDF, and/or an https video link). It waits for a teacher: **until it is approved, parents and classmates cannot see it or its pictures.**
* **Teachers** (Classroom → Portfolio review) approve, or send back with a reason the learner sees. Teachers can also add a project for a learner (published at once), comment on any project, and remove one.
* Approving notifies the learner and parents and adds a line to the learner's timeline.
* Pictures are served only to people who may see that learner (staff in scope, the learner, their parents); pending and rejected items only to the learner and reviewers. Removing a project removes its files.
* Files are checked by content (pictures and PDFs only here), exactly like classroom uploads, and served with `nosniff` and a sandbox policy.
* **Not included:** large video uploads. Videos are links to a site you choose (YouTube, Google Drive…), because files are stored in the database.

## Tested
`server/tests/phase15.test.ts` (9 tests): report numbers against hand-computed data, privacy between families, teachers and schools, PDF, notes permissions, send preview and confirm, once-only sending; portfolio hidden-until-approved including the pictures, review permissions and scope, rejection reason, feedback, removal. Browser run `e2e15` on a phone and desktop: note saved, learner adds a project, parent cannot see it, teacher approves, parent sees the picture, report page, staff tabs.
