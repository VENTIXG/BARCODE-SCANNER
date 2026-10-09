/**
 * Shared helpers for the end-to-end tests: a real server on its own port and data folder,
 * and a real Chromium (set PW_CHROMIUM to its path, or run `npx playwright install chromium`).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const log = (...a) => console.log('[e2e]', ...a);

/** A server process on `port` with its own empty data folder. */
export function testServer(port) {
  const base = `http://127.0.0.1:${port}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-e2e-'));
  let child = null;
  return {
    base,
    data,
    start() {
      child = spawn(process.execPath, ['server/dist/index.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
      return waitForHealth(base);
    },
    stop() {
      child?.kill('SIGTERM');
      child = null;
    },
    cleanup() {
      child?.kill('SIGTERM');
      fs.rmSync(data, { recursive: true, force: true });
    },
  };
}

export async function waitForHealth(base, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

export function launchBrowser() {
  return chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
}

export async function apiLogin(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `API login ${username}`);
  return res.headers.get('set-cookie').split(';')[0];
}

/** Poll until fn() returns true or the timeout passes. */
export async function until(fn, label, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => undefined);
    if (last === true) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
}

export async function uiLogin(page, base, username, password) {
  await page.goto(`${base}/login`);
  await page.fill('input[autocomplete=username]', username);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/`);
}
