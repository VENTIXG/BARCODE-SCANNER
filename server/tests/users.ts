import { expect } from 'vitest';
import type request from 'supertest';

/**
 * A user created by the administrator (`admin` agent) who already chose their own password at
 * the first sign-in, signed in on `agent` with `password`.
 */
export async function addUser(
  admin: request.Agent,
  agent: request.Agent,
  user: { username: string; fullName?: string; role: string; password: string },
) {
  const temporary = `${user.password}-temp`;
  const res = await admin
    .post('/api/users')
    .send({ username: user.username, fullName: user.fullName ?? user.username, role: user.role, password: temporary, isActive: true });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect((await agent.post('/api/auth/login').send({ username: user.username, password: temporary })).status).toBe(200);
  const changed = await agent.post('/api/auth/change-password').send({ currentPassword: temporary, newPassword: user.password });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  return res.body.data as { id: number; username: string };
}
