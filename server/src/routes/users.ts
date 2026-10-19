import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb, nowIso } from '../db/index.js';
import { actorOf } from '../middleware/auth.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam } from '../lib/http.js';
import { ROLES } from '../lib/permissions.js';

export const usersRouter = Router();

const USER_COLS = 'id, username, full_name, email, role, is_active, last_login_at, created_at, updated_at';

const baseUser = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Za-z0-9._-]+$/, 'Username may contain letters, digits, dot, dash and underscore'),
  fullName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200).nullish().or(z.literal('').transform(() => null)),
  role: z.enum(ROLES as [string, ...string[]]),
  isActive: z.boolean().default(true),
});

usersRouter.get('/', async (_req, res) => {
  res.json({ data: await getDb().all(`SELECT ${USER_COLS} FROM users ORDER BY username`) });
});

usersRouter.post('/', async (req, res) => {
  const db = getDb();
  const body = baseUser.extend({ password: z.string().min(8, 'Password must be at least 8 characters').max(200) }).parse(req.body);
  const hash = await bcrypt.hash(body.password, 10);
  const id = await db.tx(async (t) => {
    if (await t.get('SELECT 1 FROM users WHERE username = ?', body.username)) throw conflict('Username already exists');
    const newId = (await t.value<number>(
      'INSERT INTO users (username, full_name, email, password_hash, role, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id',
      body.username,
      body.fullName,
      body.email ?? null,
      hash,
      body.role,
      body.isActive ? 1 : 0,
    )) as number;
    await audit(t, actorOf(req), {
      action: 'USER.CREATE',
      entityType: 'user',
      entityId: newId,
      description: `${req.user!.username} created user ${body.username} with role ${body.role}.`,
      newValue: { username: body.username, role: body.role },
    });
    return newId;
  });
  res.status(201).json({ data: await db.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id) });
});

usersRouter.put('/:id', async (req, res) => {
  const db = getDb();
  const id = idParam(req.params.id);
  const body = baseUser.extend({ password: z.string().min(8).max(200).optional().or(z.literal('')) }).parse(req.body);
  const hash = body.password ? await bcrypt.hash(body.password, 10) : null;
  await db.tx(async (t) => {
    const before = await t.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', id);
    if (!before) throw notFound('User not found');
    if (id === req.user!.id && (body.role !== 'ADMIN' || !body.isActive))
      throw badRequest('You cannot remove your own admin role or deactivate yourself');
    if (before.role === 'ADMIN' && (body.role !== 'ADMIN' || !body.isActive)) {
      const admins = await t.value<number>(`SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND is_active = 1 AND id <> ?`, id);
      if (admins === 0) throw badRequest('At least one active administrator is required');
    }
    if (await t.get('SELECT 1 FROM users WHERE username = ? AND id <> ?', body.username, id)) throw conflict('Username already exists');

    const after = {
      username: body.username,
      full_name: body.fullName,
      email: body.email ?? null,
      role: body.role,
      is_active: body.isActive ? 1 : 0,
    };
    const d = diff(before, after, { username: 'username', full_name: 'name', email: 'email', role: 'role', is_active: 'active' });
    // Role change, deactivation or password reset invalidates existing sessions.
    const bump = before.role !== body.role || !body.isActive || Boolean(body.password);
    await t.run(
      `UPDATE users SET username = ?, full_name = ?, email = ?, role = ?, is_active = ?, updated_at = ?,
         token_version = token_version + ? WHERE id = ?`,
      after.username,
      after.full_name,
      after.email,
      after.role,
      after.is_active,
      nowIso(),
      bump ? 1 : 0,
      id,
    );
    // A password set by an administrator for someone else is temporary: that user changes it at next sign-in.
    if (hash) await t.run('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?', hash, id === req.user!.id ? 0 : 1, id);
    if (d.changed || body.password) {
      await audit(t, actorOf(req), {
        action: 'USER.UPDATE',
        entityType: 'user',
        entityId: id,
        description: `${req.user!.username} updated user ${body.username}: ${[...d.phrases, ...(body.password ? ['password reset'] : [])].join('; ')}.`,
        oldValue: d.oldValue,
        newValue: d.newValue,
      });
    }
  });
  res.json({ data: await db.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, id) });
});
