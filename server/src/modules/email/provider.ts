import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * E-mail over SMTP, backend only. The SMTP password is read from the environment, used only to sign in to the mail server, and never logged,
 * returned or stored. Anything that fails is reported as retriable (network, 4xx) or permanent (5xx: bad address, rejected).
 */
export interface EmailMessage { to: string; toName?: string | null; subject: string; text: string; html?: string | null; headers?: Record<string, string> }
export type EmailResult = { ok: true; id: string | null } | { ok: false; retriable: boolean; code: string; message: string };
export interface EmailProvider { send(m: EmailMessage): Promise<EmailResult> }

export const fromAddress = () => env.SMTP_FROM ?? null;
export const isConfigured = () => !!(env.SMTP_HOST && env.SMTP_FROM);
const redact = (s: string) => ([env.SMTP_PASSWORD, env.SMTP_USER] as (string | undefined)[]).reduce<string>((t, k) => (k ? t.split(k).join('[redacted]') : t), s).slice(0, 300);

class SmtpProvider implements EmailProvider {
  private t: Transporter | null = null;
  private transport() {
    return (this.t ??= nodemailer.createTransport({
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE === 'true', auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, pool: true, maxConnections: 2,
    }));
  }
  async send(m: EmailMessage): Promise<EmailResult> {
    if (!isConfigured()) return { ok: false, retriable: false, code: 'NOT_CONFIGURED', message: 'E-mail is not configured.' };
    try {
      const info = await this.transport().sendMail({ from: env.SMTP_FROM, to: m.toName ? { name: m.toName.replace(/[\r\n"<>]/g, ' '), address: m.to } : m.to, subject: m.subject, text: m.text, html: m.html ?? undefined, headers: m.headers });
      return { ok: true, id: info.messageId ?? null };
    } catch (e: any) {
      const code = e?.responseCode ? `SMTP_${e.responseCode}` : String(e?.code ?? 'ERROR');
      const permanent = typeof e?.responseCode === 'number' && e.responseCode >= 500;
      logger.warn({ code, permanent }, 'SMTP rejected a message');
      return { ok: false, retriable: !permanent, code, message: redact(String(e?.message ?? 'Mail error')) };
    }
  }
}

let provider: EmailProvider = new SmtpProvider();
export const getEmailProvider = () => provider;
/** Tests inject a fake; production never calls this. */
export function setEmailProvider(p: EmailProvider | null) { provider = p ?? new SmtpProvider(); }
