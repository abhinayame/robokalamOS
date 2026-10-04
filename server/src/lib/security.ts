import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const hashPassword = (pw: string) => bcrypt.hash(pw, env.BCRYPT_COST);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function generatePassword(): string {
  // 14 chars, guaranteed mix, no ambiguous characters.
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const all = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chars = [pick('ABCDEFGHJKLMNPQRSTUVWXYZ'), pick('abcdefghjkmnpqrstuvwxyz'), pick('23456789'), pick('!@#$%')];
  while (chars.length < 14) chars.push(pick(all));
  return chars.sort(() => crypto.randomInt(3) - 1).join('');
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password is too long.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Use upper case, lower case and a number.';
  return null;
}

export interface AccessClaims { sub: string; sid: string }
export const signAccess = (c: AccessClaims) =>
  jwt.sign(c, env.JWT_SECRET, { expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`, issuer: 'robokalam' });
export function verifyAccess(token: string): AccessClaims | null {
  try { return jwt.verify(token, env.JWT_SECRET, { issuer: 'robokalam' }) as AccessClaims; }
  catch { return null; }
}

/** Neutralise spreadsheet formula injection for CSV/Excel exports. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
