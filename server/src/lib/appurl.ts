import { env } from '../config/env.js';

/** The public address of the app, used in links that leave it (e-mails, calendar feeds, certificate QR codes). */
export function appUrl(): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, '');
  const origins = String(env.CORS_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  return (origins.find((o) => o.startsWith('https://')) ?? origins[0] ?? 'http://localhost:4000').replace(/\/+$/, '');
}
