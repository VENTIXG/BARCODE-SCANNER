import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getDb, getSetting, nowIso } from '../db/index.js';
import { actorOf, clearSession, issueSession, requireAuth, type AuthUser } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { PERMISSIONS, can, type Permission } from '../lib/permissions.js';

export const authRouter = Router();

/** Compared against when the user does not exist, so timing does not reveal valid usernames. */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: { message: 'Too many login attempts. Try again in a few minutes.', code: 'RATE_LIMITED' } },
});

export function publicUser(u: AuthUser) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    email: u.email,
    role: u.role,
    mustChangePassword: Boolean(u.must_change_password),
    permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(u.role, p)),
  };
}

authRouter.post('/login', loginLimiter, (req, res) => {
  const { username, password } = z
    .object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) })
    .parse(req.body);
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | (AuthUser & { password_hash: string })
    | undefined;
  // Always run bcrypt to keep response time constant for unknown users.
  const ok = bcrypt.compareSync(password, user?.password_hash ?? DUMMY_HASH);
  const meta = { id: 0, username, fullName: '', role: 'WAREHOUSE_USER' as const, ip: req.ip, userAgent: req.get('user-agent') };
  if (!user || !ok) {
    audit(db, user ? { ...meta, id: user.id } : null, {
      action: 'AUTH.LOGIN_FAILED',
      entityType: 'user',
      entityId: user?.id,
      description: `Failed login attempt for "${username}" from ${req.ip ?? 'unknown IP'}.`,
    });
    throw new HttpError(401, 'Invalid username or password', 'INVALID_CREDENTIALS');
  }
  if (!user.is_active) throw new HttpError(403, 'This account is disabled', 'ACCOUNT_DISABLED');
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  issueSession(res, user);
  audit(db, { ...meta, id: user.id, username: user.username, fullName: user.full_name, role: user.role }, {
    action: 'AUTH.LOGIN',
    entityType: 'user',
    entityId: user.id,
    description: `${user.username} signed in.`,
  });
  res.json({ data: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({
    data: publicUser(req.user!),
    settings: {
      companyName: getSetting('company_name'),
      currency: getSetting('currency'),
      allowNegativeStock: getSetting('allow_negative_stock') === 'true',
      defaultUnit: getSetting('default_unit'),
    },
  });
});

authRouter.post('/change-password', requireAuth, (req, res) => {
  const body = z
    .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200) })
    .parse(req.body);
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
  if (!bcrypt.compareSync(body.currentPassword, row.password_hash)) throw badRequest('Current password is incorrect');
  if (body.newPassword === body.currentPassword) throw badRequest('The new password must be different from the current one');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, updated_at = ? WHERE id = ?').run(
    bcrypt.hashSync(body.newPassword, 10),
    nowIso(),
    req.user!.id,
  );
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as AuthUser;
  issueSession(res, user); // keep this session valid, invalidate all others
  audit(db, actorOf(req), {
    action: 'USER.PASSWORD_CHANGE',
    entityType: 'user',
    entityId: user.id,
    description: `${user.username} changed their password.`,
  });
  res.json({ ok: true });
});
