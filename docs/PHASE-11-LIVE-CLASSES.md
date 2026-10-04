# Phase 11 — Live classes: Zoom meetings, automatic attendance, recordings

Until now a class only stored a meeting *link*. This phase connects classes to **Zoom** so a teacher can create the meeting from the schedule, attendance is marked from who actually joined, and recordings reach the learners. We deliberately integrate with Zoom instead of building our own video classroom (that would be a product of its own, with its own infrastructure and risks).

Migration: `014_live.sql`. No new permissions: everything uses the classroom gate (`openRoom` / `assertManage`), so a teacher can only act on their own batches and learners only see what their batch shows.

## How it works
1. **Create** — on a scheduled class, a teacher/admin presses *Create Zoom meeting*. The server calls Zoom (`POST /v2/users/{host}/meetings`, waiting room on, join-before-host off, participants muted) and puts the join link on the class. One meeting per class; a failed Zoom call leaves the class untouched.
2. **Start** — *Start on Zoom* fetches a **fresh host link** from Zoom each time (they expire after a couple of hours) and never stores it.
3. **Join log** — Zoom calls `POST /api/webhooks/zoom` for `meeting.started`, `participant_joined`, `participant_left`, `meeting.ended` and `recording.completed`.
   * Trusted **only** with a valid `x-zm-signature` (`v0=` + HMAC-SHA256 of `v0:<timestamp>:<raw body>` with `ZOOM_WEBHOOK_SECRET_TOKEN`, constant-time) **and** a timestamp within 5 minutes, so a captured request cannot be replayed. The one-time URL challenge (`endpoint.url_validation`) is answered with the matching HMAC. Anything else is a 404.
   * A join is identified by *who joined which meeting when*, not by the envelope, so a re-sent or re-wrapped event never adds time twice. Events are also stored in `webhook_events`.
4. **Matching people to learners** — alias a teacher confirmed earlier, then **e-mail** (case-insensitive), then **exact name** (brackets and punctuation ignored, so "meena iyer (Mom)" matches "Meena Iyer"). Two learners with the same name are **never guessed between**: the participant stays *unmatched* for a teacher to resolve.
5. **Attendance** — when the class ends (or the teacher presses *Recalculate*):
   * **present**: stayed at least half the scheduled class (minimum 10 minutes), minutes added up across rejoins;
   * **late**: joined more than 10 minutes after the start (and stayed long enough);
   * **absent**: never joined, or stayed less than the minimum. The note says exactly why ("joined for only 4 min").
   * **A mark a teacher made by hand is never changed** (`attendance.source = 'manual'`); automatic marks are recalculated safely any number of times.
   * New absences notify learner/parent logins, like manual marking, and the class becomes *completed*.
   * If nobody joined (or there is no join data) nothing is marked at all.
6. **Unmatched names** — the **Zoom attendance** screen lists who joined, for how long, and a "Who is this?" picker for unmatched names. Matching saves an alias, so "Guest iPad" is recognised automatically in every later class, and attendance is recalculated at once.
7. **Recordings** — the Zoom share link and passcode are stored (https links only) and every learner/parent of the batch gets a notification. They are shown to people who can open the classroom, nobody else. (Recordings stay in Zoom's cloud: we store a link, not the video.)
8. **Safety net** — if Zoom's "ended" event is lost, a class that started more than 6 hours ago and never ended is closed and marked from the data we have (runs in the 6-hourly maintenance job). System Status has an integrity check for classes that ended but were never turned into attendance.

## Setup (Hostinger variables only; never in chat or code)
1. In the Zoom Marketplace create a **Server-to-Server OAuth** app with scopes `meeting:write:admin` (or `meeting:write`), `meeting:read:admin`; activate it.
2. Set `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`. Optionally `ZOOM_HOST_USER` (the host's e-mail; default is the account owner).
3. Add an **Event Subscription** to the app: endpoint `https://<domain>/api/webhooks/zoom`, events *Meeting started, ended, participant joined, participant left* and *Recording completed*; copy its **Secret Token** into `ZOOM_WEBHOOK_SECRET_TOKEN` (8+ chars) and press *Validate*.
4. Ask learners to join with the **name the school knows them by** (or the e-mail on their profile). The Join button tells them so.

## Limits (honest list)
* **One Zoom host account** per organization: a basic Zoom licence allows one meeting at a time per host. Two simultaneous batches need two licences (or an org that schedules around it).
* Attendance relies on names/e-mail: an unfamiliar Zoom display name needs one click from the teacher the first time.
* Google Meet and other links are still just links (no join log): mark those by hand as before.
* Tested against a stand-in Zoom only. Do one real class with a few test participants before relying on it.

## API (`/api/live`)
`GET /status` · `POST /sessions/:id/meeting` · `DELETE /sessions/:id/meeting` · `POST /sessions/:id/start-link` · `GET /sessions/:id/participants` · `POST /sessions/:id/match` · `POST /sessions/:id/finalize` · `GET /sessions/:id/recordings`; webhook `POST /api/webhooks/zoom`. The class list gains `has_zoom`, `live` (`live`/`ended`) and `recordings`.
