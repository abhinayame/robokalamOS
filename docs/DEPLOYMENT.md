# Deployment — Hostinger Cloud

Robokalam Learner OS ships as **one Node.js process** (API + built web app) plus **PostgreSQL 16**.
Requirements: Node.js ≥ 20 (22 recommended), PostgreSQL ≥ 14 (with `pgcrypto`; `pg_trgm` recommended for fast search), a domain.

> **Database note.** Hostinger's shared/"Web" plans provide MySQL only. Use a **Cloud/VPS plan** where you can install PostgreSQL, or a managed Postgres (Neon, Supabase, Aiven…) and set `DATABASE_SSL=true`. The app does not run on MySQL.

## 1. Prepare the server

```bash
# Ubuntu VPS / Cloud (SSH)
sudo apt update && sudo apt install -y postgresql postgresql-contrib nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2
```

## 2. Database setup

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE robokalam LOGIN PASSWORD 'GENERATE-A-LONG-RANDOM-PASSWORD';
CREATE DATABASE robokalam OWNER robokalam;
\c robokalam
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
```

Keep Postgres listening on localhost only (`listen_addresses = 'localhost'`) unless you use a managed DB.

## 3. Get the code and configure

```bash
git clone <repo> /var/www/robokalam && cd /var/www/robokalam/robokalam-learner-os
cp server/.env.example server/.env && chmod 600 server/.env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # → JWT_SECRET
nano server/.env
```

Required production values in `server/.env`:

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (enables Secure cookies + HSTS) |
| `PORT` | e.g. `4000` (nginx proxies to it) |
| `DATABASE_URL` | `postgres://robokalam:<password>@localhost:5432/robokalam` |
| `DATABASE_SSL` | `true` for managed/remote Postgres, `false` for local |
| `JWT_SECRET` | ≥ 32 random chars — **unique per environment, never committed** |
| `CORS_ORIGINS` | `https://learn.yourdomain.com` (comma separated, exact origins) |
| `TRUST_PROXY` | `true` (behind nginx/Hostinger proxy so rate limiting sees real IPs) |
| `BCRYPT_COST` | `12` |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | used once by `seed:prod`; remove the password afterwards |
| `AISENSY_*` | reserved for Phase 7 — leave empty now |

## 4. Build, migrate, seed, run

```bash
npm ci                         # installs both workspaces
npm run build                  # server → server/dist, web → web/dist
npm run migrate:prod -w server # applies pending SQL migrations (idempotent, advisory-locked)
npm run seed:prod -w server    # creates the platform super admin once
pm2 start server/dist/server.js --name robokalam --cwd server --update-env
pm2 save && pm2 startup        # restart on reboot
curl -s localhost:4000/api/health
```

The Node process serves `web/dist` itself (SPA fallback + immutable asset caching) — nothing else to host.

**First login:** sign in as the super admin → *Organizations → New organization* (creates the org admin with a one-time temporary password) → open the org → create branches, programs, courses, teachers, batches, learners.

## 5. Domain & SSL

1. Point an `A` record (`learn.yourdomain.com`) to the server IP in hPanel → DNS.
2. nginx site `/etc/nginx/sites-available/robokalam`:

```nginx
server {
  server_name learn.yourdomain.com;
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
3. `sudo ln -s /etc/nginx/sites-available/robokalam /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx`
4. `sudo certbot --nginx -d learn.yourdomain.com` (auto-renews). Then confirm `CORS_ORIGINS` uses the `https://` origin.

If you use Hostinger's managed **Node.js app** feature instead of a VPS: set the same environment variables in hPanel, build command `npm ci && npm run build`, start command `node server/dist/server.js`, and run `npm run migrate:prod -w server` from the SSH terminal after each deploy.

## 6. Updating (zero-surprise releases)

```bash
git pull && npm ci && npm run build
npm run migrate:prod -w server      # migrations are forward-only and run in a transaction
pm2 reload robokalam
curl -s https://learn.yourdomain.com/api/health
```
Take a database backup **before** every release that contains a new migration.

## 7. Backup strategy

| What | How | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | `pg_dump -Fc` to an off-server location | daily (cron, 02:00) + before each release | 14 daily, 8 weekly, 6 monthly |
| Uploaded files (Phase 2) | rsync/object-storage versioning | daily | 30 days |
| `server/.env` | password manager / secrets vault (never git) | on change | – |

```bash
# /etc/cron.d/robokalam-backup   (0600, owned by postgres' operator)
0 2 * * * root PGPASSWORD=… pg_dump -h localhost -U robokalam -Fc robokalam | gzip > /backups/robokalam-$(date +\%F).dump.gz && find /backups -mtime +14 -delete
```
**Test the restore quarterly:** `createdb restore_test && pg_restore -d restore_test file.dump` and run `npm test` style smoke checks against it. A backup you have never restored is not a backup.

## 8. Logging & monitoring

* The API logs structured JSON (pino) to stdout; PM2 captures it: `pm2 logs robokalam`, rotate with `pm2 install pm2-logrotate`. Authorization headers, cookies and passwords are redacted.
* `GET /api/health` returns 200 only when the database answers — point an uptime monitor (UptimeRobot/Better Stack) at it.
* Business audit trail is in the `audit_logs` table (and *Settings → Audit log* in the UI).
* Alert on: health check failures, 5xx rate, disk < 15 %, failed backups, repeated `auth.login_failed` bursts.

## 9. Security checklist before go-live

- [ ] `NODE_ENV=production`, HTTPS only, `JWT_SECRET` unique and ≥ 32 chars
- [ ] `server/.env` is `chmod 600`, not in git; `SUPER_ADMIN_PASSWORD` removed after seeding
- [ ] Postgres not exposed publicly; DB user has no superuser rights
- [ ] `CORS_ORIGINS` lists only your real origin(s); `TRUST_PROXY=true` behind nginx
- [ ] Firewall: only 22 (SSH key auth), 80, 443 open
- [ ] Super admin password is long and unique; change temp passwords on first sign-in
- [ ] Backups running **and** one restore tested
- [ ] `dev/` seed scripts never run in production (they refuse when `NODE_ENV=production`)
