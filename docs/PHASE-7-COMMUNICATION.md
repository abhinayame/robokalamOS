# Phase 7: Communication

WhatsApp through AiSensy (templates, campaigns, de-duplicated recipients, message logs, delivery webhooks, opt-outs) and in-app announcements.

## Setup on Hostinger (backend only; never in the browser)
Set these in the Node app's **Environment variables**; leave `AISENSY_API_KEY` empty and the app sends nothing and says so on screen.

| Variable | Meaning |
|---|---|
| `AISENSY_API_KEY` | Your AiSensy API key. Required to send. |
| `AISENSY_BASE_URL` | Default `https://backend.aisensy.com`. |
| `AISENSY_CAMPAIGN_PATH` | Default `/campaign/t1/api/v2` (the AiSensy "campaign API" path). Change it only if AiSensy tells you to. |
| `AISENSY_WA_NUMBER` | Your sender number (shown as "set" in the status banner; the number the campaign is created for in AiSensy). |
| `AISENSY_WEBHOOK_SECRET` | A long random value (16+ characters). Delivery webhooks are accepted only at `https://<your-domain>/api/webhooks/aisensy/<this value>`. Paste that URL into AiSensy's webhook settings. |
| `WHATSAPP_RATE_PER_SECOND` | Default 5. |
| `COMMS_WORKER` | Default `true`: the sender runs inside the app process. |

**Verify against your AiSensy account before the first real send.** The request and webhook shapes are implemented from AiSensy's campaign API (`apiKey`, `campaignName`, `destination`, `userName`, `templateParams`) and the webhook parser accepts several common field spellings, but they were tested only against a stand-in server, not against AiSensy itself. Send one message to yourself first. Templates must already be approved in AiSensy; this app does not create or approve templates.

## Flow (brief §52)
1. **Template** (admin): name, use case (welcome, class reminder, new assignment, score received, badge awarded, attendance alert, fee reminder, …), the AiSensy *API campaign name*, message text for reference, ordered variable names.
2. **Campaign** (draft): template, audience (parents' primary mobile, or the learners' own), batches chosen with the shared selection engine, a value for every template variable using placeholders `{learner_name} {learner_first_name} {parent_name} {org_name} {batch_name}` (`{batch_name}` only when exactly one batch is selected), optional schedule.
3. **Review** (the confirmation screen): batches, memberships, unique learners, duplicates removed, learners with a number, shared numbers merged, skipped (no number / opted out), WhatsApp recipients, a masked sample, and warnings. **Nothing is sent without an explicit confirmation**, and confirming must carry the recipient count that was reviewed; if the audience changed since, the server refuses and shows the new numbers.
4. **Snapshot**: on confirm, one row per unique learner **and** per unique phone is frozen (siblings sharing a parent's number get one message, personalised for the first child). Capped at 20,000 per campaign.
5. **Send**: a worker claims rows with a token (safe with several instances), checks opt-out and cancellation again, makes **one HTTP call per message** paced to the rate limit, and records every attempt in `whatsapp_messages`.
6. **Retry**: network errors, 429 and 5xx retry after 1, 5 and 15 minutes (4 attempts); rejected numbers/templates/keys fail at once. "Retry failed" re-queues failed recipients (never opted-out numbers).
7. **Webhook**: stores every event (replays ignored), moves recipients sent → delivered → read, never backwards, never marks a delivered message failed, and applies events that arrive before our own record of the message id.
8. **Results**: totals, successful, failed, pending, per-recipient status and per-recipient log; the page refreshes while sending.
Statuses: draft, scheduled, processing, completed, partially failed, failed, cancelled. Cancelling stops everything not yet sent.

## Opt-outs
Admins list numbers that must never be messaged. They are skipped at preview, at confirm and again at send time, and anything waiting for them is cancelled.

## Announcements (in-app)
Teachers and admins send to the unique learners of their selected batches (scope enforced; one row per learner). Every learner and parent who can sign in gets **one** notification, even a parent of several selected children; the sender is not notified. Optionally also posts to the Stream of each selected batch the sender manages. A confirmation shows the people count first. Limit 50,000 learners.

## Permissions
`comms:read`, `comms:campaign` (super admin, org admin, branch admin, counsellor), `comms:manage` (templates, opt-outs: org admin), `comms:announce` (also teachers). Other organizations' campaigns are 404; non-org-wide users see only their own campaigns. Phone numbers are masked in lists. The API key and webhook secret are never returned or logged.

## Not in this phase
- Email (needs SMTP details); event-triggered automatic WhatsApp (e.g. send on every new assignment); inbound replies and STOP-keyword handling; media/button templates; creating templates inside AiSensy.
- Postman requests for Phases 3-7.
