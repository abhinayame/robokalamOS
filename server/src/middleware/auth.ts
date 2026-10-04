import type { NextFunction, Request, Response } from 'express';
import { query, queryOne } from '../db/pool.js';
import { forbidden, unauthorized, badRequest } from '../lib/errors.js';
import { verifyAccess } from '../lib/security.js';
import { uuid } from '../lib/http.js';

export interface Access {
  orgWide: boolean;      // sees everything in the organization
  branchIds: string[];   // sees everything in these branches
  teacher: boolean;      // sees assigned batches and their learners
  ownLearnerIds: string[]; // learner self, or parent's linked children
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  userOrgId: string | null;
  roles: string[];
  isSuperAdmin: boolean;
  permissions: Set<string>;
  access: Access;
  sessionId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    /** Organization all queries for this request are scoped to. */
    orgId?: string;
  }
}

export const ACCESS_COOKIE = 'rk_at';

function readToken(req: Request): { token: string; fromCookie: boolean } | null {
  const h = req.get('authorization');
  if (h?.startsWith('Bearer ')) return { token: h.slice(7), fromCookie: false };
  const c = req.cookies?.[ACCESS_COOKIE];
  return c ? { token: c, fromCookie: true } : null;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const t = readToken(req);
    if (!t) throw unauthorized();
    const claims = verifyAccess(t.token);
    if (!claims) throw unauthorized('Your session has expired. Please sign in again.');

    const session = await queryOne(
      `SELECT 1 FROM auth_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [claims.sid, claims.sub],
    );
    if (!session) throw unauthorized('Your session has ended. Please sign in again.');

    const u = await queryOne(
      `SELECT id, email, full_name, org_id, status FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [claims.sub],
    );
    if (!u || u.status !== 'active') throw unauthorized('This account is not active.');

    if (u.org_id) {
      const org = await queryOne(`SELECT status FROM organizations WHERE id = $1 AND deleted_at IS NULL`, [u.org_id]);
      if (!org || org.status !== 'active') throw forbidden('This organization is not active.');
    }

    const roleRows = await query<{ key: string; branch_id: string | null }>(
      `SELECT r.key, ur.branch_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [u.id],
    );
    const permRows = await query<{ key: string }>(
      `SELECT DISTINCT p.key FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1`,
      [u.id],
    );

    const roles = [...new Set(roleRows.map((r) => r.key))];
    const isSuperAdmin = roles.includes('super_admin');
    const access: Access = { orgWide: isSuperAdmin, branchIds: [], teacher: false, ownLearnerIds: [] };
    for (const r of roleRows) {
      if (['org_admin', 'counsellor', 'accountant'].includes(r.key)) {
        if (r.branch_id) access.branchIds.push(r.branch_id); else access.orgWide = true;
      } else if (r.key === 'branch_admin') {
        if (r.branch_id) access.branchIds.push(r.branch_id);   // a branch admin without a branch has no scope
      } else if (r.key === 'teacher') access.teacher = true;
    }
    if (roles.includes('learner')) {
      const rows = await query(`SELECT id FROM learners WHERE user_id = $1 AND deleted_at IS NULL`, [u.id]);
      access.ownLearnerIds.push(...rows.map((r) => r.id));
    }
    if (roles.includes('parent')) {
      const rows = await query(
        `SELECT lp.learner_id AS id FROM parents p
           JOIN learner_parents lp ON lp.parent_id = p.id
           JOIN learners l ON l.id = lp.learner_id AND l.deleted_at IS NULL
          WHERE p.user_id = $1 AND p.deleted_at IS NULL`,
        [u.id],
      );
      access.ownLearnerIds.push(...rows.map((r) => r.id));
    }

    req.user = {
      id: u.id, email: u.email, fullName: u.full_name, userOrgId: u.org_id, roles, isSuperAdmin,
      permissions: new Set(permRows.map((p) => p.key)), access, sessionId: claims.sid,
    };

    // Resolve tenant: normal users are pinned to their own org; super admins pick one explicitly.
    if (u.org_id) req.orgId = u.org_id;
    else {
      const hdr = req.get('x-org-id');
      if (hdr) {
        if (!uuid.safeParse(hdr).success) throw badRequest('Invalid organization id.');
        const org = await queryOne(`SELECT id FROM organizations WHERE id = $1 AND deleted_at IS NULL`, [hdr]);
        if (!org) throw badRequest('Unknown organization.');
        req.orgId = hdr;
      }
    }
    next();
  } catch (e) { next(e); }
}

export const requirePerm = (...perms: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u) return next(unauthorized());
  if (u.isSuperAdmin || perms.every((p) => u.permissions.has(p))) return next();
  next(forbidden());
};

export const requireAnyPerm = (...perms: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u) return next(unauthorized());
  if (u.isSuperAdmin || perms.some((p) => u.permissions.has(p))) return next();
  next(forbidden());
};

export const requireSuperAdmin = (req: Request, _res: Response, next: NextFunction) =>
  req.user?.isSuperAdmin ? next() : next(forbidden());

/** Org-scoped routes need a tenant; super admins must send X-Org-Id. */
export const requireOrg = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.orgId) return next(badRequest('Select an organization first (X-Org-Id header).'));
  next();
};

export const orgIdOf = (req: Request): string => req.orgId!;
