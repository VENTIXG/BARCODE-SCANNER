import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { getDb, getSetting } from '../db/index.js';
import { actorOf } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { BACKUP_FILE_RE, backupDir, defaultBackupDir, listBackups, restoreFrom, runBackup } from '../lib/backup.js';
import { badRequest, notFound } from '../lib/errors.js';

export const backupsRouter = Router();

const fileParam = (name: unknown) => {
  const n = String(name ?? '');
  if (!BACKUP_FILE_RE.test(n)) throw badRequest('Invalid backup file name');
  const file = path.join(backupDir(), n);
  if (!fs.existsSync(file)) throw notFound('Backup not found');
  return { name: n, file };
};

backupsRouter.get('/', (_req, res) => {
  const db = getDb();
  res.json({
    data: {
      dir: backupDir(db),
      defaultDir: defaultBackupDir(),
      enabled: getSetting('backup_enabled', db) === 'true',
      keep: Number(getSetting('backup_keep', db)) || 30,
      lastBackupAt: getSetting('last_backup_at', db) || null,
      files: listBackups(db),
    },
  });
});

backupsRouter.post('/', async (req, res) => {
  const file = await runBackup('manual');
  audit(getDb(), actorOf(req), { action: 'BACKUP.CREATE', entityType: 'backup', description: `${req.user!.username} created backup ${file.name}.` });
  res.status(201).json({ data: file });
});

backupsRouter.get('/:name/download', (req, res) => {
  const { name, file } = fileParam(req.params.name);
  res.download(file, name);
});

backupsRouter.post('/:name/restore', async (req, res) => {
  const { name, file } = fileParam(req.params.name);
  const actor = actorOf(req);
  const result = await restoreFrom(file);
  audit(getDb(), actor, {
    action: 'BACKUP.RESTORE',
    entityType: 'backup',
    description: `${actor.username} restored backup ${name}. Previous data saved as ${result.safetyBackup}.`,
  });
  res.json({ data: { restored: name, ...result } });
});

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

backupsRouter.post('/restore-upload', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const actor = actorOf(req);
  try {
    const result = await restoreFrom(req.file.path);
    audit(getDb(), actor, {
      action: 'BACKUP.RESTORE',
      entityType: 'backup',
      description: `${actor.username} restored the uploaded backup "${req.file.originalname}". Previous data saved as ${result.safetyBackup}.`,
    });
    res.json({ data: { restored: req.file.originalname, ...result } });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
});

