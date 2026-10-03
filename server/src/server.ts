import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from './config.js';
import { closeDb, getDb } from './db/index.js';
import { createApp } from './app.js';
import { startBackupScheduler, stopBackupScheduler } from './lib/backup.js';

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

function listen(server: http.Server, port: number, host?: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * Open the database, start daily backups and serve API + web app.
 * Used by `npm start` and by the Windows desktop app.
 */
export async function startServer(
  opts: { port?: number; host?: string; fallbackToFreePort?: boolean } = {},
): Promise<RunningServer> {
  getDb(); // open + migrate before accepting requests
  startBackupScheduler();
  const server = http.createServer(createApp());
  const port = opts.port ?? config.port;
  try {
    await listen(server, port, opts.host);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !opts.fallbackToFreePort) throw err;
    await listen(server, 0, opts.host);
  }
  const actual = (server.address() as AddressInfo).port;
  return {
    port: actual,
    url: `http://${opts.host ?? 'localhost'}:${actual}`,
    close: () =>
      new Promise<void>((resolve) => {
        stopBackupScheduler();
        server.closeAllConnections?.();
        server.close(() => {
          closeDb();
          resolve();
        });
      }),
  };
}
