# Deployment — Hostinger (Node.js + MySQL)

Robokalam Learner OS is **one Node.js process** (API + the built web app) plus a **MySQL / MariaDB** database — both of which Hostinger provides.

Requirements: Node.js ≥ 20 (22 recommended) · MySQL 8 or MariaDB 10.6+ (any current Hostinger MySQL database) · a domain/subdomain.

---

## A. Hostinger "Node.js app" with Git deploy (hPanel)

### 1. Create the database (hPanel → Databases → MySQL Databases)
Create a database + user and note: **database name, user, password, host** (usually `localhost`). If the password contains special characters (`@ : / # ?`), URL-encode them in the connection string (e.g. `@` → `%40`).

```
DATABASE_URL=mysql://DB_USER:DB_PASSWORD@localhost:3306/DB_NAME
```

### 2. Import the repo (hPanel → Websites → Add website → Node.js app → GitHub)
Pick the repository and use the **Review build settings** page like this:

| Field | Value |
|---|---|
| Framework preset | **Other** |
| Branch | `main` |
| Node version | **22.x** (20.x also works) |
| Root directory | `./` |
| Install command | `npm ci --include=dev` |
| Build command | `npm run build` |
| Start command | `npm start` (or entry file `server.js`) |
| Output directory | leave blank (the Node server serves the web app itself); if required, `web/dist` |

On every start the server applies pending database migrations and creates the platform owner login once, then listens (both steps are idempotent; set `AUTO_MIGRATE=false` to run them by hand with `npm run migrate:prod -w server`). The repo root has a `server.js` entry file and a `start` script, so any way the host launches the app works.

### 3. Environment variables (same page → Environment variables → Add)

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `mysql://DB_USER:DB_PASSWORD@localhost:3306/DB_NAME` |
| `DATABASE_SSL` | `false` (local Hostinger database). `true` only for a remote DB that requires TLS |
| `JWT_SECRET` | 48+ random characters — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CORS_ORIGINS` | `https://os.robokalam.in` (your exact https origin) |
| `TRUST_PROXY` | `true` |
| `BCRYPT_COST` | `12` |
| `SUPER_ADMIN_EMAIL` | your owner email |
| `SUPER_ADMIN_PASSWORD` | a strong password (10+ chars, upper + lower + digit). **Delete this variable after the first successful start.** |

Optional / feature variables:

| Name | Value |
|---|---|
| `AISENSY_API_KEY`, `AISENSY_WA_NUMBER` | Your AiSensy project API key and WhatsApp number. **Set only here, never in chat, code or the browser.** Empty = the app sends nothing and says so on the Communication screen |
| `WHATSAPP_PROVIDER`, `META_WA_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_TEMPLATE_LANGUAGE`, `META_API_VERSION` | Use Meta's WhatsApp Cloud API instead of AiSensy (see `PHASE-14-META-CLOUD-API.md`). Default provider is AiSensy |
| `AISENSY_WEBHOOK_SECRET` | 16+ random characters. Delivery callbacks are accepted only at `/api/webhooks/aisensy/<this value>`; put that full URL in AiSensy's webhook settings |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API key pair (use *test mode* keys first). Set only here. Empty = no online fee payments, manual receipts only |
| `RAZORPAY_WEBHOOK_SECRET` | A secret you choose (8+ chars); enter the same value in Razorpay → Webhooks with URL `https://<domain>/api/webhooks/razorpay`, event *Payment Link: paid* |
| `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | Zoom Server-to-Server OAuth app (see `PHASE-11-LIVE-CLASSES.md`). Empty = classes keep plain links, attendance stays manual |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | The event subscription's Secret Token (8+ chars); endpoint `https://<domain>/api/webhooks/zoom` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Outgoing e-mail (password reset, e-mail reminders). Empty = e-mail stays off (see `PHASE-13-CERTIFICATES-CALENDAR-EMAIL.md`) |
| `APP_URL` | Public address (e.g. `https://os.robokalam.in`) used in e-mail links, calendar feeds and certificate QR codes |
| `EMAIL_WORKER` | `true` (default) runs the e-mail sender on this server |
| `ZOOM_HOST_USER` | Optional: the host's e-mail (default: the account owner) |
| `REMINDERS` | `true` (default) runs automatic reminders every 5 minutes; needs `COMMS_WORKER=true` |
| `COMMS_WORKER` | `true` (default) runs the WhatsApp sender inside the app. Run it on exactly **one** instance |
| `WHATSAPP_RATE_PER_SECOND` | `5` (default) messages per second |
| `MAINTENANCE` | `true` (default) runs the 6-hourly cleanup job (expired sessions, orphan uploads, old webhook logs). Never touches learner data |
| `BACKUP_PASSPHRASE` | 12+ characters; encrypts backup files (see *Backups*). Needed again to restore |
| `DATABASE_SSL` | `true` when the database is a remote host that requires TLS (e.g. `srv…hstgr.io`) |
| `UPLOAD_MAX_MB` | `5` (1-20) |

Do **not** set `PORT` — Hostinger injects it.

At start the app checks its own configuration and logs `[config] CODE: message` lines (never values). It refuses to start in production with a trivially weak `JWT_SECRET`, and warns about: `TRUST_PROXY` off behind a proxy, `localhost`/`http` in `CORS_ORIGINS`, `SUPER_ADMIN_PASSWORD` still set, low `BCRYPT_COST`, a missing webhook secret, and a remote database without TLS. The same findings show under **Settings → System Status**.

### 4. Deploy, then verify
Open `https://<your-domain>/api/health` → `{"ok":true,"data":{"status":"up"}}` and `/api/health/ready` (database + all migrations applied), then sign in with the owner email/password → **Organizations → New organization**.

Every later `git push` to `main` redeploys; migrations run automatically on start.

---

## B. Hostinger VPS / Cloud with SSH (PM2 + nginx)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs nginx certbot python3-certbot-nginx mariadb-server
sudo npm i -g pm2
sudo mysql <<'SQL'
CREATE DATABASE robokalam CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'robokalam'@'localhost' IDENTIFIED BY 'GENERATE-A-LONG-RANDOM-PASSWORD';
GRANT ALL ON robokalam.* TO 'robokalam'@'localhost';
SQL
git clone https://github.com/abhinayame/robokalamos /var/www/robokalam && cd /var/www/robokalam
cp server/.env.example server/.env && chmod 600 server/.env && nano server/.env     # same variables as the table above
npm ci && npm run build
pm2 start server/dist/server.js --name robokalam --cwd server && pm2 save && pm2 startup
```

nginx (`/etc/nginx/sites-available/robokalam`), then `sudo certbot --nginx -d os.robokalam.in`:

```nginx
server {
  server_name os.robokalam.in;
  client_max_body_size 12m;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

---

## Domain & SSL
Point a DNS record for the subdomain (`os.robokalam.in`) at Hostinger (hPanel → Domains → DNS; the Node app wizard usually does this for you). Hostinger issues the SSL certificate automatically for Node apps (hPanel → Security → SSL). On a VPS use certbot as above. After SSL is active, confirm `CORS_ORIGINS` uses the `https://` origin — sign-in cookies are `Secure` in production and will not work over plain HTTP.

## Database migrations
Plain numbered SQL files in `server/migrations/`, applied in order by `npm run migrate:prod -w server` and recorded in `schema_migrations` (guarded by `GET_LOCK`, so two instances cannot migrate at once). MySQL cannot roll back DDL: a migration is recorded only after it fully succeeds, and files are kept small. **Back up before any release that adds a migration.**

## Backups
The app ships its own backup tool (no `mysqldump` needed). It takes **one consistent snapshot** of every table, compresses it, optionally encrypts it (AES-256-GCM, key derived from `BACKUP_PASSPHRASE`) and keeps the newest N files.

```bash
# Hostinger SSH (or the app's terminal), from the app directory
BACKUP_PASSPHRASE='…' npm run backup:prod -w server -- --out ~/backups --keep 14
```
Cron (hPanel → Advanced → Cron Jobs), daily 02:00 — put the passphrase in the cron line or a `chmod 600` env file, never in git:
```
0 2 * * * cd ~/domains/os.robokalam.in/nodejs && BACKUP_PASSPHRASE='…' node server/dist/scripts/backup.js --out ~/backups --keep 14
```
**Copy the files off the server** (another cloud drive, S3, your laptop) — a backup on the same machine does not survive losing the machine. Backups contain children's personal data: always set the passphrase and store it in a password manager *separately* from the files.

| What | How | Frequency |
|---|---|---|
| Database (incl. uploaded files, which live in the DB) | `backup:prod` as above, copied off-server | daily + before each release |
| Hostinger's own database backup (hPanel → Databases) | second, independent copy | weekly |
| Environment variables, `BACKUP_PASSPHRASE` | password manager (never git) | on change |

### Restore (and the quarterly drill)
```bash
# 1. check the file is complete and untampered (changes nothing)
BACKUP_PASSPHRASE='…' node server/dist/scripts/restore.js FILE --verify-only
# 2. DRILL: restore into a separate EMPTY database (create it in hPanel first) and compare
DATABASE_URL='mysql://USER:PASS@HOST:3306/restore_test' BACKUP_PASSPHRASE='…' node server/dist/scripts/restore.js FILE
# 3. REAL disaster: replace the live database (typed confirmation required)
BACKUP_PASSPHRASE='…' node server/dist/scripts/restore.js FILE --wipe --confirm-database LIVE_DB_NAME
```
Restore verifies the file first, refuses a non-empty database without `--wipe` + the database name, and finishes by comparing every table's row count with the backup. Measured: 203,000 rows / 53 tables back up in ~3 s and restore in ~9 s. **A backup you have never restored is not a backup — run the drill every quarter.**

## Rotating secrets
| Secret | How | Effect |
|---|---|---|
| `JWT_SECRET` | set a new value, restart | everybody signs in again (safe) |
| Database password | hPanel → Databases → change password, then update `DATABASE_URL`/`DB_PASSWORD`, restart | brief downtime |
| Owner password | sign in → *My account → change password*; delete `SUPER_ADMIN_PASSWORD` | other sessions are signed out |
| `AISENSY_WEBHOOK_SECRET` | set new value, restart, update the webhook URL in AiSensy | callbacks to the old URL are rejected |
| `AISENSY_API_KEY` | regenerate in AiSensy, update variable, restart | — |
| `BACKUP_PASSPHRASE` | change for new backups; keep the old one for old files | — |

Rotate immediately if a secret was ever pasted into chat, email or a ticket. Also restrict Remote MySQL (hPanel → Databases → Remote MySQL) to the app's IP instead of `%`.

## Logging & monitoring
- **Logs:** structured JSON (pino) on stdout — hPanel *Logs* or `pm2 logs`. Every request line has a `request_id` (also returned in the `X-Request-Id` header and in the body of any 500) so one failing click can be traced; no request bodies, tokens or passwords are logged. Queries slower than 1.5 s and requests slower than 2 s are logged as warnings.
- **Uptime monitor** (UptimeRobot etc.): `GET /api/health/ready` every minute — 200 only when the database answers and all migrations are applied (503 otherwise). `/api/health` is the cheaper liveness check.
- **Settings → System Status** (owner / org admin): database latency, pending migrations, traffic and latency percentiles, slowest routes, WhatsApp queue and last callback, active sessions, failed sign-ins, configuration warnings, and **eight data-integrity checks that must all be zero**.
- **Business audit trail:** `audit_logs` table and *Settings → Audit log*.
- Alert on: `/api/health/ready` not 200 for 3 minutes · System Status integrity not all-clear · no backup file newer than 26 hours.

## Go-live checklist
- [ ] `NODE_ENV=production`, HTTPS only, `JWT_SECRET` unique and ≥ 32 chars
- [ ] `SUPER_ADMIN_PASSWORD` variable removed after the first start; owner password is long and unique
- [ ] `CORS_ORIGINS` = your real https origin only; `TRUST_PROXY=true`
- [ ] MySQL user has rights on its own database only; database not exposed publicly
- [ ] Daily encrypted backups running, copied off-server, **and** one restore drill done
- [ ] Uptime monitor on `/api/health/ready`
- [ ] Any secret ever shared in chat/email has been rotated
- [ ] `server/dev/` seed scripts are never run in production (they refuse when `NODE_ENV=production`)
