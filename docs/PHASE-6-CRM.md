# Phase 6: CRM

Leads, tags, CRM activities and follow-ups, built on the one master learner profile.

## Model (`006_crm.sql`)
- **A lead IS a learner profile.** `crm_leads` has one row per learner (unique), so converting never copies data and the pipeline is never a second list of people.
- `crm_activities`: the CRM timeline (type, details, staff member, time, optional next follow-up). Internal only: it is **never** written to the learner timeline that learners and parents can read.
- `follow_ups`: tasks assigned to a counsellor/admin with a due time; open, done or cancelled. The lead's `next_follow_up_at` is always the earliest open follow-up (kept in sync).
- `tags` and `learner_tags`: reusable colour labels. Deleting a tag removes it from learners.
- Permissions: `crm:read`, `crm:manage` (super admin, org admin, branch admin, counsellor), `tag:read` (all staff roles), `tag:apply` (also teachers), `tag:manage`. Learners and parents have none, and tags are removed from the learner payload they receive.

## Pipeline rules
- Stages: new, contacted, interested, demo scheduled, demo attended, follow-up, converted, not interested, lost. A **lost** lead needs a reason. Every stage change is logged on the CRM timeline.
- Reaching converted / not interested / lost cancels open follow-ups.
- **Enrolling a lead into a batch converts it automatically** (stamp, timeline entry, follow-ups closed), including through the bulk engine.
- Counsellors must be active users with the counsellor, org admin or branch admin role; assigning one notifies them. Follow-ups assigned to someone else notify that person.
- Visibility is the same RBAC scope as learners: other branches, other teachers' learners and other organizations are 404.

## Filters and bulk
The shared learner filter engine (list, selection, bulk) gained **tag**, **CRM status**, **counsellor** and **follow-up due**. New bulk actions through the Phase 1 engine (preview, confirm, learners de-duplicated across batches): add tag, remove tag, assign counsellor (creates leads where missing), log a CRM activity, create follow-ups (one summary notification to the assignee, not one per learner).

## Screens
Leads (stage tabs with counts, filters, summary, add lead for a new or existing learner with duplicate protection), Follow-ups (overdue / today / upcoming / done, call button, complete with outcome and next follow-up), Learner 360 CRM tab and tag editor, Settings → Tags, tag chips and filters on the Learners list, new bulk actions.

## Not in this phase
- Sending campaigns from the CRM (Phase 7: communication). Automatic reminders for overdue follow-ups (they appear on the Follow-ups page and in the summary).
- A drag-and-drop kanban; lead import from CSV.
- Postman requests for Phases 3-6.
