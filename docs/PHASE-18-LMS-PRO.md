# Phase 18: a fuller LMS (course studio, catalog, player, reviews, Q&A, analytics)

Everything here is **added on top of** the Phase 16 and 17 LMS. Existing courses, paths, the question bank and the old course screens keep working.

## The publish problem, fixed
- A draft course card now says **“Draft: nobody can see it yet”** with a **Publish** button. If something is missing, you are taken to the studio instead of seeing a silent failure.
- In the studio, **Publish…** opens a checklist (has lessons, a required lesson, quizzes have questions, file lessons have files; advice: description, “what you will learn”, certificate). Publishing is one click once it is ready. **Unpublish** is there too, and **Assign** appears as soon as the course is live.

## For authors (Courses → Open studio)
| Tab | What it does |
|---|---|
| **Content** | Modules (chapters) and lessons; reorder; six lesson types: reading (Markdown), video (YouTube/Vimeo play inside the page), download (files), quiz, assignment, web link |
| **Details** | Landing-page content: description, “what you will learn”, requirements, instructor, category, level, language, icon and colour; **Assigned or Open** enrolment; lessons unlock in order; minimum quiz grade; XP for finishing; certificate |
| **Learners** | Progress table, CSV, assign, and one-click **nudges** (not started, overdue, inactive for a week; once a day per person) |
| **Work to review** | Handed-in assignments: accept or send back with feedback |
| **Q&A** | Course discussion: answer, mark answered, pin, hide |
| **Reviews** | Ratings and comments; hide rude ones |
| **Numbers** | Enrolled, started, finished, rating; per-lesson completion, average score, tries; **per-question “% got it right”** to find confusing questions |
| **Announcements** | One post notifies everyone enrolled (and learners' parents) |
Also: **Preview** the course exactly as a learner sees it (nothing saved), **Copy** a whole course (modules, lessons, files) into a new draft.

## For learners and staff
- **Course catalog** (open courses, searchable, by category) and a **course page** with outcomes, syllabus, instructor, rating and reviews, then **Join for free**.
- **My courses**: *Continue learning* card, tabs for In progress / Not started / Completed, learning paths.
- **Player**: modules and lessons on the left, locked lessons greyed out when a course unlocks in order, video embeds, downloads, quizzes with attempts, shuffle and explanations, assignments with files, **private notes** that save by themselves, **Q&A** per lesson, announcement banner.
- **Finish** → a celebration screen with the certificate, XP, the next step on a path, and a rating prompt.
- **My learning record**: every finished course with date, grade and certificate (print or save as PDF).

## Rules
- **Quiz answers never reach the browser** until the quiz allows it (passed, or out of attempts) and the author left “show answers” on. Every attempt is stored.
- **Minimum grade**: when set, the course only completes once the average of the quiz grades reaches it; retaking a quiz can lift it.
- **Locked lessons** show only their title and type, so a sequential course cannot be skipped by reading ahead.
- **Open courses** are visible only to the right audience (learner courses to learners, staff courses to staff). Parents cannot join.
- **Files**: lesson downloads can be opened by people enrolled in that course (and authors); submitted work only by its author and reviewers. New permission `lms:learn` (everyone except parents) covers taking courses and uploading assignment files.
- **Discussion** shows children by first name only; staff replies are marked *Teacher*.
- Reviews need half the course finished; one per person (editable).

## Migration
`022_lms_pro.sql` (additive): course details and rules, modules, new lesson types and quiz settings, quiz attempts, notes, submissions, reviews, discussions, announcements, the `lms:learn` permission, and two new file owner types.

## Verified
314 server tests (17 new in `phase18.test.ts`). Browser run (`e2e18`): create a course, see the Publish prompt, build modules and every lesson type, set details, publish through the checklist, join from the catalog, read, write notes, pass a quiz with an explanation, hand in work, finish with the celebration and a review, ask and answer a question, read the numbers, send an announcement; no overflow on a phone.

## Not in this phase
Live-session lessons inside a course (use Classroom live classes), peer-graded assignments, paid courses, subtitles/transcripts for videos, and a mobile app.
