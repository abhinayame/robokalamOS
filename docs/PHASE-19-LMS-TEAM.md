# Phase 19: training for a team (assign by role or person, take it yourself, chapters with sections, automatic assignment, team matrix)

## "Can I assign a course to employees and team members?"
Yes. Before this phase the screen only had an "all active staff" tick-box (the server could already take named people, the screen could not ask for them). Now **Assign** on any course or learning path shows **Staff and team members**:
- **Everyone on the team**, or
- **Everyone with a role**: Admins, Branch admins, Teachers, Counsellors, Accountants (with how many people each has), or
- **Pick people** by name or e-mail,
- plus an optional "finish by" date. Preview shows how many are new and how many already have it; nobody is assigned twice. For learners, assign by batch as before.

The owner / super admin runs all of this (`lms:manage`). Teachers and other staff only see what they are given.

## Taking a course yourself
- **Open courses** appear in the **Course catalog** and anyone in the audience can join (staff and learners).
- Owners can also press **＋ Take it myself** on any published staff course, even one that is "assigned only".

## Chapters with sections
A course now has **chapters**, and each chapter can have **sections** inside it, then lessons in either (course → chapter → section → lesson). Reorder chapters and sections with the arrows, move a section to another chapter, and remove a chapter (its lessons are kept, just ungrouped). Learners see the same structure in the player and on the course page. Copying a course keeps the structure.

## Automatic assignment (set it once)
In a course's **Learners** tab, **Assign automatically**:
- *Everyone who becomes a Teacher (or Counsellor, Accountant, …)* gets this course, with an optional deadline in days.
- *Everyone who joins this batch* gets this course.
New hires, promotions and new batch members are picked up the moment it happens; **Apply to people already there** catches up everyone else. Only published courses are applied, and a rule never double-enrols anyone.

## Team training
**Courses → Team training**: one row per team member, one column per staff course, with Done / percentage / Not started / Overdue, filters by role and a CSV export.

## Reminders
Every hour the system reminds people whose course is **due within 2 days** (at most every 3 days) and whose course is **overdue** (at most once a week). Finished courses are left alone. These are in-app notifications (and phone notifications when push is switched on).

## Migration
`023_lms_team.sql`: sections (`parent_id` on modules), how someone joined (`assigned`, `self`, `auto`), and the auto-assign rules table. Additive; existing courses are unchanged.

## Verified
322 server tests (8 new in `phase19.test.ts`). Browser run (`e2e19`): chapter with a section and lessons, publish, assign to all Teachers with the people picker, teacher sees the course and the nested structure, the owner takes it too, add an auto-assign rule, a new counsellor is enrolled automatically, team training matrix; the Phase 18 run (`e2e18`) still passes.
