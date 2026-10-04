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

Do **not** set `PORT` — Hostinger injects it. Leave the `AISENSY_*` variables empty until Phase 7.

### 4. Deploy, then verify
Open `https://<your-domain>/api/health` → `{"ok":true,"data":{"status":"up"}}`, then sign in with the owner email/password → **Organizations → New organization**.

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
| What | How | Frequency |
|---|---|---|
| MySQL database | hPanel → Databases → *Backups* (or `mysqldump --single-transaction --routines DB_NAME \| gzip`) copied **off the server** | daily + before each release |
| Uploaded files (Phase 2) | rsync / object storage | daily |
| Environment variables | password manager (never git) | on change |

```bash
# VPS cron, 02:00 daily, keep 14 days
0 2 * * * root mysqldump --single-transaction -u robokalam -p'…' robokalam | gzip > /backups/robokalam-$(date +\%F).sql.gz && find /backups -mtime +14 -delete
```
**Test a restore quarterly** (`gunzip -c file.sql.gz | mysql -u … restore_test`). A backup you have never restored is not a backup.

## Logging & monitoring
Structured JSON logs (pino) go to stdout — in hPanel use the app's *Logs* view; on a VPS `pm2 logs robokalam`. Authorization headers, cookies and passwords are redacted. `GET /api/health` returns 200 only when the database answers — point an uptime monitor at it. Business audit trail: `audit_logs` table and *Settings → Audit log*.

## Go-live checklist
- [ ] `NODE_ENV=production`, HTTPS only, `JWT_SECRET` unique and ≥ 32 chars
- [ ] `SUPER_ADMIN_PASSWORD` variable removed after the first start; owner password is long and unique
- [ ] `CORS_ORIGINS` = your real https origin only; `TRUST_PROXY=true`
- [ ] MySQL user has rights on its own database only; database not exposed publicly
- [ ] Backups running **and** one restore tested
- [ ] `server/dev/` seed scripts are never run in production (they refuse when `NODE_ENV=production`)
