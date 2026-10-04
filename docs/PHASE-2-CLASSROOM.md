# Phase 2: Classroom

Stream, Classwork (topics, materials, assignments), People, Submissions and file uploads, built on the Phase 1 batch memberships.

## Access model
- One gate: `openRoom()` (`server/src/modules/classroom/access.ts`). A batch outside the caller's scope is **404**, never 403.
- `canManage` = `classroom:manage` + org-wide / branch admin of the batch's branch / active teacher of **that** batch. Another teacher gets 404.
- Learners: read, comment, submit their own work (`classroom:interact`). Parents: read-only, never submit or comment.
- Archived/completed batches are read-only (409 `BATCH_CLOSED`); teachers can still review existing submissions.

## Data (`002_classroom.sql`)
`files`, `topics`, `classroom_posts`, `comments`, `materials`, `assignments`, `submissions` (unique per assignment+learner). All tenant-bound by composite FKs `(id, org_id)`; soft delete on content. Permissions: `classroom:read|manage|interact`.

## Submissions
`draft → submitted | late → evaluated | returned`. Late is decided by the server clock against `due_at`. Resubmission is allowed after *returned*, or while not yet evaluated if the assignment allows it. `version` counts submissions. Marks are Phase 3 (scores); Phase 2 records feedback and status only.

## Files
Stored in the DB (`LONGBLOB`), capped by `UPLOAD_MAX_MB` (default 5). Type is verified from file **content** (magic bytes), not the client's MIME; executables/HTML/SVG are rejected. Downloads are authorised through the owning material/assignment/submission on every request, served as attachment (PDF/images may open inline) with `nosniff` and a sandboxing CSP.

## API
`GET /api/classrooms`, `/:batchId`, `/people`, `/stream`, posts + comments, `/classwork`, topics, `classwork/reorder`, materials, assignments (CRUD under the batch). `GET /api/assignments` (+`?learner_id=`), `/:id`, `PUT /:id/submission`, `GET /:id/submissions`. `GET /api/submissions/:id`, `POST /:id/review`. `POST/GET/DELETE /api/files`.

## Known limits / next
- A parent with several children in one batch sees the first child's state on the assignment page (the API accepts `learner_id`).
- Dashboard widgets for pending work are not added; counts appear on the Classroom list.
- Phase 3: attendance, scores/grades, certificates.
