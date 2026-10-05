# WhatsApp through Meta's Cloud API (alternative to AiSensy)

Both providers sit behind the same sender, so campaigns, reminders, retries, opt-outs and delivery tracking behave identically. Choose with one variable: `WHATSAPP_PROVIDER` = `aisensy` (default) or `meta`. Meta has **no platform fee** (you pay only Meta's per-conversation price) and its delivery webhooks are free.

## What you need from Meta
1. A **Meta Business account** and a **WhatsApp Business app** at developers.facebook.com (type: Business), with the WhatsApp product added.
2. A **phone number** added in WhatsApp Manager. It cannot be one already in use on the normal WhatsApp app. Note its **Phone number ID** (not the number itself).
3. **Message templates** created in WhatsApp Manager and approved (category Utility for reminders). Body variables only; no header or buttons yet.
4. A **permanent access token**: Business Settings → Users → System users → add a system user, assign the app and the WhatsApp account, generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`. (The temporary token in the quick-start page expires in 24 hours.)
5. The **App secret** (App settings → Basic) and a **verify token** you invent (8+ random characters).

## Hostinger variables (never in chat or code)
| Variable | Value |
|---|---|
| `WHATSAPP_PROVIDER` | `meta` |
| `META_WA_TOKEN` | the permanent system-user token |
| `META_PHONE_NUMBER_ID` | the Phone number ID |
| `META_APP_SECRET` | the app secret (signs webhook calls) |
| `META_VERIFY_TOKEN` | your invented token |
| `META_TEMPLATE_LANGUAGE` | template language code, default `en` (e.g. `en_US`, `hi`) |
| `META_API_VERSION` | default `v21.0` |

Restart the app. System Status shows "WhatsApp Cloud API (Meta) token" as set.

## Webhook (delivered / read / failed)
In the Meta app: WhatsApp → Configuration → Webhook: callback URL `https://<your domain>/api/webhooks/meta`, verify token = `META_VERIFY_TOKEN`, then subscribe to the **messages** field.
* The subscription check (GET) is answered only with the right verify token.
* Every POST must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret), checked in constant time; otherwise it looks like a 404.
* Events are stored once (replays ignored), statuses never go backwards, and an event that beats our own record of the message id is applied afterwards. Customer replies are ignored.

## In the app
Templates screen: the "campaign / template name" field takes the **template name exactly as in WhatsApp Manager**. Variable names must be in the same order as `{{1}} {{2}}`. Newlines in values are turned into spaces and empty values into `-`, because Meta rejects both.

## Limits to know
* Business-initiated messages need an approved template (all of ours are). Free-form replies are not supported.
* One language per deployment (`META_TEMPLATE_LANGUAGE`); a template approved only in another language is rejected by Meta (error 132001).
* Tested against a stand-in server only: send one real message to yourself first.
