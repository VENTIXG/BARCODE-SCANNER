import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import type { Actor } from '../lib/audit.js';
import { HttpError, forbidden } from '../lib/errors.js';
import { can, type Permission, type Role } from '../lib/permissions.js';

export const COOKIE_NAME = 'ims_session';

export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  email: string | null;
  role: Role;
  is_active: number;
  token_version: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface TokenPayload {
  sub: number;
  tv: number;
}

export function issueSession(res: Response, user: { id: number; token_version: number }) {
  const token = jwt.sign({ sub: user.id, tv: user.token_version } satisfies TokenPayload, config.jwtSecret, {
    expiresIn: `${config.sessionHours}h`,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600 * 1000,
    path: '/',
  });
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Verifies the session cookie and re-loads the user on every request so
 *  deactivation, role changes and password resets take effect immediately. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (!token) return next(new HttpError(401, 'Authentication required', 'UNAUTHENTICATED'));
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as unknown as TokenPayload;
  } catch {
    return next(new HttpError(401, 'Session expired, please sign in again', 'UNAUTHENTICATED'));
  }
  const user = getDb()
    .prepare(
      'SELECT id, username, full_name, email, role, is_active, token_version FROM users WHERE id = ?',
    )
    .get(payload.sub) as AuthUser | undefined;
  if (!user || !user.is_active || user.token_version !== payload.tv)
    return next(new HttpError(401, 'Session is no longer valid', 'UNAUTHENTICATED'));
  req.user = user;
  next();
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required', 'UNAUTHENTICATED'));
    if (!permissions.every((p) => can(req.user!.role, p))) return next(forbidden());
    next();
  };
}

export function actorOf(req: Request): Actor {
  const u = req.user!;
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    role: u.role,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}
