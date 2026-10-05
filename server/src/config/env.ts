import 'dotenv/config';
import { z } from 'zod';

/** An empty value in the host's environment panel means "not set", not "invalid". */
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  // Either one URL ...
  DATABASE_URL: z.string().optional(),
  // ... or separate fields (easier: no URL-encoding of special characters in the password)
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_NAME: z.string().optional(),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  DATABASE_POOL_MAX: z.coerce.number().default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  BCRYPT_COST: z.coerce.number().min(4).max(15).default(12),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_DOMAIN: z.string().optional(),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(10),
  MAX_FAILED_LOGINS: z.coerce.number().default(8),
  LOCKOUT_MINUTES: z.coerce.number().default(15),
  LOG_LEVEL: z.string().default('info'),
  // Max size of one uploaded file. Files are stored in the database, so keep this below your
  // MySQL max_allowed_packet / 2 (a binary value is sent as hex). 5 MB is safe on Hostinger.
  UPLOAD_MAX_MB: z.coerce.number().min(1).max(20).default(5),
  // WhatsApp via AiSensy (backend only; never sent to the browser). Without AISENSY_API_KEY nothing is sent and the UI says so.
  AISENSY_API_KEY: z.preprocess(blank, z.string().optional()),
  AISENSY_BASE_URL: z.preprocess(blank, z.string().url().default('https://backend.aisensy.com')),
  AISENSY_WA_NUMBER: z.preprocess(blank, z.string().optional()),
  // Delivery-status webhooks are accepted only at /api/webhooks/aisensy/<this secret>. Use a long random value.
  AISENSY_WEBHOOK_SECRET: z.preprocess(blank, z.string().min(16, 'must be at least 16 characters').optional()),
  AISENSY_CAMPAIGN_PATH: z.preprocess(blank, z.string().startsWith('/').default('/campaign/t1/api/v2')),
  WHATSAPP_RATE_PER_SECOND: z.coerce.number().min(0.1).max(50).default(5),
  // The campaign sender runs inside this process. Set to false to run it elsewhere.
  // Online fee payments via Razorpay Payment Links (backend only). Without the key id + secret the app records manual payments only.
  RAZORPAY_KEY_ID: z.preprocess(blank, z.string().optional()),
  RAZORPAY_KEY_SECRET: z.preprocess(blank, z.string().optional()),
  RAZORPAY_BASE_URL: z.preprocess(blank, z.string().url().default('https://api.razorpay.com')),
  // Webhooks are accepted at /api/webhooks/razorpay only with a valid X-Razorpay-Signature made with this secret.
  RAZORPAY_WEBHOOK_SECRET: z.preprocess(blank, z.string().min(8, 'must be at least 8 characters').optional()),
  // Zoom (Server-to-Server OAuth app): creates meetings and receives join/leave/recording webhooks. Backend only.
  ZOOM_ACCOUNT_ID: z.preprocess(blank, z.string().optional()),
  ZOOM_CLIENT_ID: z.preprocess(blank, z.string().optional()),
  ZOOM_CLIENT_SECRET: z.preprocess(blank, z.string().optional()),
  ZOOM_WEBHOOK_SECRET_TOKEN: z.preprocess(blank, z.string().min(8, 'must be at least 8 characters').optional()),
  ZOOM_HOST_USER: z.preprocess(blank, z.string().default('me')),
  ZOOM_API_URL: z.preprocess(blank, z.string().url().default('https://api.zoom.us')),
  ZOOM_OAUTH_URL: z.preprocess(blank, z.string().url().default('https://zoom.us')),
  // Daily-ish clean-up of expired sessions, unattached uploads and old webhook payloads (see modules/system/maintenance.ts).
  MAINTENANCE: z.enum(['true', 'false']).default('true'),
  COMMS_WORKER: z.enum(['true', 'false']).default('true'),
  // Automatic reminders (fee due/overdue, class, absence) are queued by a pass every 5 minutes inside the comms worker.
  REMINDERS: z.enum(['true', 'false']).default('true'),
  // Apply migrations and create the owner login on start (idempotent). Set to false to run them manually.
  AUTO_MIGRATE: z.enum(['true', 'false']).default('true'),
  SUPER_ADMIN_EMAIL: z.string().optional(),
  SUPER_ADMIN_PASSWORD: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Never print values — only which variables are wrong.
  const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
  console.error(`Invalid environment configuration:\n  ${problems}`);
  process.exit(1);
}

export const env = parsed.data;

export interface DbConfig { host: string; port: number; user: string; password: string; database: string }
function dbConfig(): DbConfig {
  const e = parsed.data!;
  if (e.DB_USER && e.DB_NAME) {
    return { host: e.DB_HOST, port: e.DB_PORT, user: e.DB_USER, password: e.DB_PASSWORD ?? '', database: e.DB_NAME };
  }
  if (e.DATABASE_URL) {
    let u: URL;
    try { u = new URL(e.DATABASE_URL); } catch {
      console.error('Invalid environment configuration:\n  DATABASE_URL is not a valid URL. A password with symbols (@ : / # ? %) must be URL-encoded — or use DB_HOST, DB_USER, DB_PASSWORD and DB_NAME instead.');
      process.exit(1);
    }
    if (u.protocol !== 'mysql:') { console.error('Invalid environment configuration:\n  DATABASE_URL must start with mysql://'); process.exit(1); }
    return { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)) };
  }
  console.error('Invalid environment configuration:\n  Set DB_USER, DB_PASSWORD and DB_NAME (and DB_HOST if needed), or DATABASE_URL.');
  process.exit(1);
}
export const db = dbConfig();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
