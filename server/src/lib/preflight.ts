import { corsOrigins as realCors, env as realEnv, isProd as realProd } from '../config/env.js';

export interface Finding { level: 'error' | 'warn'; code: string; message: string }

/**
 * Production configuration checks. Errors stop the server from starting in production; warnings are logged and shown
 * on the System status page (names only, never values).
 */
export function preflight(cfg: { env: typeof realEnv; isProd: boolean; corsOrigins: string[] } = { env: realEnv, isProd: realProd, corsOrigins: realCors }): Finding[] {
  const { env, isProd, corsOrigins } = cfg;
  const out: Finding[] = [];
  const add = (level: Finding['level'], code: string, message: string) => out.push({ level, code, message });
  if (!isProd) return out;
  const secret = env.JWT_SECRET;
  // Only an obviously low-entropy secret stops the server; a keyword hit is a warning (a random secret may contain one by chance).
  if (new Set(secret).size < 8 || /^(.)\1+$/.test(secret)) add('error', 'WEAK_JWT_SECRET', 'JWT_SECRET has almost no variety. Generate 48+ random characters: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  else if (/^(change|secret|password|example|test)/i.test(secret) || /change-?me|change-this/i.test(secret)) add('warn', 'JWT_SECRET_PLACEHOLDER', 'JWT_SECRET looks like a placeholder. Replace it with 48+ random characters.');
  if (corsOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o))) add('warn', 'CORS_LOCALHOST', 'CORS_ORIGINS still lists localhost. Use only your real https origin.');
  if (corsOrigins.some((o) => o.startsWith('http://'))) add('warn', 'CORS_HTTP', 'CORS_ORIGINS has an http:// origin. Sign-in cookies are Secure in production and need https.');
  if (env.TRUST_PROXY !== 'true') add('warn', 'TRUST_PROXY_OFF', 'TRUST_PROXY is not "true". Behind Hostinger\'s proxy every visitor then shares one IP, so rate limits and audit IPs are wrong.');
  if (env.SUPER_ADMIN_PASSWORD) add('warn', 'OWNER_PASSWORD_IN_ENV', 'SUPER_ADMIN_PASSWORD is still set. Remove it from the environment after the first successful start.');
  if ((env.RAZORPAY_KEY_ID || env.RAZORPAY_KEY_SECRET) && !(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)) add('warn', 'RAZORPAY_INCOMPLETE', 'Only one of RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET is set: online payments stay off until both are.');
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && !env.RAZORPAY_WEBHOOK_SECRET) add('warn', 'RAZORPAY_WEBHOOK_MISSING', 'Online payments are configured but RAZORPAY_WEBHOOK_SECRET is not: payments made by learners can never be recorded automatically.');
  if (env.BCRYPT_COST < 10) add('warn', 'BCRYPT_LOW', 'BCRYPT_COST is below 10.');
  if (env.AISENSY_API_KEY && !env.AISENSY_WEBHOOK_SECRET) add('warn', 'WEBHOOK_SECRET_MISSING', 'WhatsApp is configured but AISENSY_WEBHOOK_SECRET is not: delivery status can never be received.');
  if (env.DATABASE_SSL !== 'true' && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST ?? (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : 'localhost'))) add('warn', 'DB_NO_TLS', 'The database is on another host but DATABASE_SSL is not "true".');
  return out;
}
