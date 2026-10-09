/**
 * Automatic updates of a server installed with deploy/install.sh.
 *
 * The app never updates itself: the `ims` tool on the host does (every night, with a backup
 * first and an automatic rollback if the new version does not start). It writes its status
 * to IMS_STATE_DIR/update.json, which the app shows to administrators. "Check now" in the app
 * leaves a request file in IMS_REQUEST_DIR; a systemd path unit on the host picks it up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { appVersion, config } from '../config.js';
import { latestSchemaVersion } from '../db/migrations.js';
import { badRequest } from './errors.js';

export interface UpdateHistoryEntry {
  at: string;
  from: string;
  to: string;
  result: string;
  message?: string;
}

export interface UpdateStatus {
  /** Installed with install.sh: updates are automatic and can be requested from here. */
  managed: boolean;
  version: string;
  schema: number;
  autoUpdate: boolean | null;
  updateTime: string | null;
  /** idle | checking | updating */
  state: string | null;
  /** up-to-date | updated | available | rolled-back | failed */
  lastResult: string | null;
  message: string | null;
  lastCheckAt: string | null;
  latestVersion: string | null;
  previousVersion: string | null;
  requestPending: boolean;
  history: UpdateHistoryEntry[];
  disk: { freeMb: number; totalMb: number } | null;
}

const stateDir = () => process.env.IMS_STATE_DIR?.trim() || null;
const requestDir = () => process.env.IMS_REQUEST_DIR?.trim() || null;
const REQUEST_FILE = 'update-now';

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function disk(): UpdateStatus['disk'] {
  try {
    const s = fs.statfsSync(config.dataDir);
    return { freeMb: Math.round((s.bavail * s.bsize) / 1048576), totalMb: Math.round((s.blocks * s.bsize) / 1048576) };
  } catch {
    return null;
  }
}

export function readUpdateStatus(): UpdateStatus {
  const dir = stateDir();
  const s = dir ? readJson(path.join(dir, 'update.json')) : null;
  const req = requestDir();
  return {
    managed: Boolean(dir && req),
    version: appVersion,
    schema: latestSchemaVersion,
    autoUpdate: typeof s?.autoUpdate === 'boolean' ? s.autoUpdate : null,
    updateTime: str(s?.updateTime),
    state: str(s?.state),
    lastResult: str(s?.lastResult),
    message: str(s?.message),
    lastCheckAt: str(s?.lastCheckAt),
    latestVersion: str(s?.latestVersion),
    previousVersion: str(s?.previousVersion),
    requestPending: Boolean(req && fs.existsSync(path.join(req, REQUEST_FILE))),
    history: Array.isArray(s?.history) ? (s.history as UpdateHistoryEntry[]).slice(0, 10) : [],
    disk: disk(),
  };
}

/** Ask the host to check for a new version now (and install it). */
export function requestUpdateCheck(username: string) {
  const dir = requestDir();
  if (!dir || !stateDir()) throw badRequest('Updates of this installation are not managed by the server tool', 'UPDATES_NOT_MANAGED');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REQUEST_FILE), `${new Date().toISOString()} ${username}\n`);
}
