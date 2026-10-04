# Phase 3: Assessment

Scores, score history, gradebook, quizzes and feedback, on top of the Phase 2 classroom.

## Model (`003_assessment.sql`)
- `scores`: **one live row per learner per graded item** (assignment, quiz or manual activity), enforced by a unique index on `(learner, batch, source_type, live_key)`. Removing a score frees the slot (soft delete).
- `score_history`: every create/update/delete with previous and new score, max, feedback, who and when. Written in the same transaction as the change by one function, `recordScore()` (`modules/assessment/scoring.ts`), so nothing can write a score without a trail.
- `activities`: named manual items (e.g. "Robotics Project", category Project) so many learners can be scored on the same thing.
- `quizzes`, `questions`, `quiz_attempts`.

## Rules
- Score must be 0..max (also a DB CHECK). Percentage and performance are computed, never stored: Excellent ≥ 85, Good ≥ 70, Average ≥ 50, else Needs attention. Trend needs 4+ scores (last 3 vs the 3 before; ±5 points).
- **Assignments**: evaluating now requires a score (≤ the assignment's max) and writes/updates the gradebook score. *Return for changes* writes none.
- **Manual scoring**: a sheet for the whole batch; duplicate learners in one save are merged (last wins); only active members can be scored; empty clears the score (history keeps it).
- **Quizzes**: single, multiple (exact set) and short answer (case/space-insensitive), all auto-graded on the server. Learners never receive answer keys or drafts. Time limit and close time are enforced server-side (30s grace; later submissions are recorded as *expired* with 0). A started attempt resumes instead of consuming another. The gradebook keeps the best attempt. Questions and limits lock once anyone has attempted.
- **Access**: managers (batch teachers/admins) see the whole gradebook and history; a learner sees only their own row and history; a parent their child; everyone else 404. Closed batches allow correcting scores but not creating activities/quizzes or taking quizzes.

## API
`GET/POST /api/classrooms/:batch/activities`, `PATCH|DELETE …/activities/:id`, `GET|PUT …/activities/:id/scores`, `GET …/gradebook` (filters: type, category, from, to, item, search). `GET /api/scores?learner_id&batch_id&course_id&type&from&to`, `GET /api/scores/:id/history`, `DELETE /api/scores/:id`. `POST /api/quizzes`, `GET /api/quizzes?batch_id`, `GET|PATCH|DELETE /api/quizzes/:id`, `PUT …/questions`, `POST …/publish`, `POST …/attempts`, `POST /api/quizzes/attempts/:id/submit`, `GET /api/quizzes/attempts/:id`, `GET …/:id/attempts`. `POST /api/submissions/:id/review` now takes `score`.

## Not in this phase
- **Bonus XP** on scores belongs to Phase 4 (XP is a separate transaction ledger).
- Long-answer (manually graded) quiz questions; quizzes do not post to the Stream.
- Postman requests for Phase 3.
