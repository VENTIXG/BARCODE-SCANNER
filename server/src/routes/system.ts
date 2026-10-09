import { Router } from 'express';
import { getDb } from '../db/index.js';
import { actorOf } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { readUpdateStatus, requestUpdateCheck } from '../lib/system.js';

export const systemRouter = Router();

systemRouter.get('/update', (_req, res) => {
  res.json({ data: readUpdateStatus() });
});

systemRouter.post('/update/check', (req, res) => {
  const actor = actorOf(req);
  requestUpdateCheck(actor.username);
  audit(getDb(), actor, { action: 'SYSTEM.UPDATE_CHECK', entityType: 'system', description: `${actor.username} asked the server to check for updates.` });
  res.status(202).json({ data: readUpdateStatus() });
});
