# Phase 12 — Organization branding and an installable app

Each organization can make the platform look like its own school, and learners can install it on their phone like an app. Migration: `015_branding.sql`. Uses the existing `org:manage` permission (organization admins).

## Branding (Settings → Branding)
| Setting | Where it shows |
|---|---|
| App name, tagline | Menu header, sign-in page, browser tab title, the installed app's name |
| **Logo** — a square **PNG**, 512–2048 px, ≤ 1 MB | Menu, sign-in page, browser tab icon, **the installed app's icon** |
| Main color | Menu, primary buttons, theme color of the phone's browser bar |
| Accent color | Highlights and the active-menu marker |
| Support e-mail / phone | Public branding data (for sign-in help) |
| Own web address (e.g. `learn.myschool.in`) | The sign-in page of that address shows the school's branding automatically |

Rules the server enforces (and the tests prove):
* The main color must give **at least 4.5:1 contrast with white** (WCAG AA), because white text sits on it; too-light colors are refused with the measured ratio. The screen warns before saving.
* The logo is checked from its bytes: it must be a PNG, square, 512–2048 px. It is stored as a file owned by the organization (`owner_type = 'branding'`), so the clean-up of unattached uploads never removes it; a replaced or removed logo is deleted completely (bytes included).
* A custom domain must be a real hostname (no scheme/path) and is unique across organizations (409 otherwise).
* Every change is audited (`organization.branding_updated`, `logo_changed`, `logo_removed`).

### Public endpoints (no sign-in; the sign-in page needs them)
`GET /api/public/branding?org=<slug>` (or by the Host the app is opened on, else the platform default) · `GET /api/public/orgs/:slug/logo` · `GET /api/public/orgs/:slug/manifest.webmanifest`.
They expose **public fields only** (name, app name, tagline, colors, logo URL, support contacts): no ids, no settings. They serve only the file the organization chose as its logo (with `nosniff` and a sandbox CSP), ignore suspended organizations, and an unknown organization gets the platform default (so nothing reveals which slugs exist). They are rate limited.

### Custom domain: what you do outside the app
1. In your domain's DNS add a CNAME for `learn.myschool.in` to the Hostinger app's domain (or attach it as a domain alias in hPanel) and enable SSL.
2. Enter the same address in Branding. If the app uses `CORS_ORIGINS`, add the `https://` origin there as well.
The app only *recognizes* the domain; it cannot create DNS records or certificates.

## Installable app (PWA)
* `manifest.webmanifest` (default) and a **per-organization manifest** built from the branding (name, theme color, logo as the icon, `start_url=/?org=<slug>`), so each school's install looks like its own app.
* A **service worker** (`/sw.js`) makes the app installable and opens it quickly. Its rules are deliberately narrow:
  * It caches **only static files** of the app itself (the offline page, icons, the fingerprinted scripts and styles).
  * It **never touches `/api/` requests**: personal data is never stored in a cache and a stale answer can never be shown for live data (verified in the browser: the cache holds no `/api` entry, and an API call while offline fails instead of returning something old).
  * Pages are fetched from the network first; if the network is gone a friendly **offline page** appears.
* **Install**: an *Install app* button appears in the header and on *My account* when the browser offers installation; on iPhone/iPad the account page explains *Share → Add to Home Screen*. Apple touch icon and maskable Android icon are included.
* The service worker file is served with `no-cache` so updates reach people on their next visit.

## Limits
* Installed apps open the website in a window of its own; they are not store apps (no push notifications, no Play Store / App Store listing). That would be a separate native-wrapper project.
* The logo must be PNG (it doubles as the app icon; SVG is refused on purpose because an uploaded SVG can carry script).
* The sign-in page learns the school from `?org=<slug>`, a remembered visit, or the custom domain; on the plain platform address with no hint it shows the platform brand until someone signs in.
