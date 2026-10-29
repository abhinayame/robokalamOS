# Phase 17: family chat, push notifications, learning paths, question bank, QR check-in, polls, provider self-test

| Feature | Who | Where |
|---|---|---|
| **Provider self-test**: one-click harmless checks of e-mail, Razorpay, Zoom, WhatsApp and push | owners (`system:test`) | System status → Live provider tests |
| **Family chat**: one conversation per learner between parents and the school | parents, teachers, admins (`chat:use`) | Messages |
| **Push notifications** to phones and computers that installed the app | everyone, per device | Account → Turn on notifications |
| **Question bank**: write once, reuse in any quiz (quizzes get a copy), random draws | teachers, admins (`qbank:manage`) | Question bank, and "Add from question bank" in a quiz lesson |
| **Learning paths**: courses in order; the next unlocks when one is finished | `lms:manage` to build, everyone to walk | Courses → Learning paths, My courses |
| **QR check-in**: a code that changes every 30 seconds; learners scan and are marked present or late | teacher shows, learner scans | Classroom → Live |
| **Live polls**: ask the class, one anonymous vote each, results after voting | teacher asks, learners vote | Classroom → Live |

## Turning things on
1. **Push:** `npx web-push generate-vapid-keys`, then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`mailto:you@school.in`) in Hostinger and restart. Until all three exist nothing is pushed, and notifications that arrive meanwhile are marked skipped so enabling push later never floods anyone. On iPhone the app must be added to the Home Screen first.
2. **Real-provider tests:** set the keys for e-mail, Razorpay, Zoom and WhatsApp as before, then open **System status → Live provider tests** and press each button. E-mail goes to your own address; Razorpay makes a Rs 1 link and cancels it; Zoom makes tomorrow's meeting and deletes it; WhatsApp sends ONE template message to a number you type (templates can cost money, so it is never automatic).

## Rules
- **Chat** is for grown-ups: a learner's own login never sees it. A parent sees only their own children; staff see learners in their scope. Messages are plain text and are never edited. The sender can take a message back for 10 minutes; moderators (`chat:moderate`) can remove any or close a thread. Removed text is kept for the audit trail but never shown. The other side gets one unread notification per thread, not one per message.
- **Push** accepts only the big browser push services (Google, Mozilla, Microsoft, Apple), so a user cannot make the server call an arbitrary address. A notification is pushed at most once. Dead devices are forgotten.
- **QR check-in:** the code is signed with a per-class secret that never leaves the server; only the current and previous 30-second code work, so a photo of an old screen fails. Only an active member of that batch can check in. A teacher's manual mark always wins over a scan, and the Zoom auto-attendance never overwrites a scan.
- **Paths:** assigning enrols the person in the first course only. A course that is for staff cannot be on a path given to learners (and the reverse). Unpublished courses block assignment.
- **Polls:** answers are anonymous (counts only); a learner sees the counts after voting or when the poll closes.

## Migration
`021_phase17_engagement.sql`: permissions (`system:test`, `chat:use`, `chat:moderate`, `qbank:manage`), chat tables, `push_subscriptions` and `notifications.push_state`, question bank, path tables, attendance source `qr`, class check-in columns, poll tables. Runs automatically on deploy.

## Verified
297 server tests (10 new). Browser run (`e2e17`): parent and teacher chat both ways, question saved and copied into a quiz, path assigned to a batch, learner sees step two locked, poll created and voted, self-test explains missing keys; no overflow on a phone.

## Still not built
GST invoices, e-signatures, kit and inventory tracking, proctored exams, other languages, and a native Play Store / App Store app (the installed web app plus push covers most of it).
