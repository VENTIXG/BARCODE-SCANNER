import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { publish, subscribe } from './lib/events.js';
import helmet from 'helmet';
import { appVersion, config } from './config.js';
import { requireAuth, requirePermission } from './middleware/auth.js';
import { getDb } from './db/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { categoriesRouter, locationsRouter, settingsRouter, suppliersRouter, warehousesRouter } from './routes/catalog.js';
import { dashboardRouter } from './routes/dashboard.js';
import { makeDocumentRouter } from './routes/documents.js';
import { exportRouter, importRouter } from './routes/importExport.js';
import { productsRouter } from './routes/products.js';
import { reportsRouter } from './routes/reports.js';
import { searchRouter } from './routes/search.js';
import { stockRouter } from './routes/stock.js';
import { transactionsRouter } from './routes/transactions.js';
import { usersRouter } from './routes/users.js';
import { backupsRouter } from './routes/backups.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Server-Sent Events must not be buffered by compression.
  app.use(compression({ filter: (req, res) => req.path !== '/api/events' && compression.filter(req, res) }));
  app.use(express.json({ limit: '30mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.get('/health', (_req, res) => {
    // Public and cheap: used by Docker, the update script and open browsers to detect a new version.
    getDb().prepare('SELECT 1').get();
    res.json({ ok: true, version: appVersion });
  });
  api.use('/auth', authRouter);

  // Tell open browsers which resource changed after each successful write.
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    // Read the resource name now: req.path changes while the router is handling the request.
    const scope = req.path.split('/').filter(Boolean)[0] ?? 'misc';
    res.on('finish', () => {
      if (res.statusCode < 400) publish(scope);
    });
    next();
  });

  // Everything below requires a signed-in user.
  api.use(requireAuth);

  api.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const send = (e: { scope: string; at: string }) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
    const unsubscribe = subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  api.use('/dashboard', requirePermission('dashboard.view'), dashboardRouter);
  api.use('/search', requirePermission('products.view'), searchRouter);
  api.use('/products', requirePermission('products.view'), productsRouter);
  api.use('/stock', stockRouter);
  api.use('/receipts', requirePermission('stock.in'), makeDocumentRouter('receipt'));
  api.use('/dispatches', requirePermission('stock.out'), makeDocumentRouter('dispatch'));
  api.use('/transactions', transactionsRouter);
  api.use('/categories', requirePermission('catalog.view'), categoriesRouter);
  api.use('/suppliers', requirePermission('catalog.view'), suppliersRouter);
  api.use('/warehouses', requirePermission('catalog.view'), warehousesRouter);
  api.use('/locations', requirePermission('catalog.view'), locationsRouter);
  api.use('/settings', settingsRouter);
  api.use('/import', requirePermission('import.run'), importRouter);
  api.use('/export', requirePermission('export.run'), exportRouter);
  api.use('/reports', requirePermission('reports.view'), reportsRouter);
  api.use('/audit', requirePermission('audit.view'), auditRouter);
  api.use('/users', requirePermission('users.manage'), usersRouter);
  api.use('/backups', requirePermission('settings.manage'), backupsRouter);
  api.use(notFoundHandler);

  app.use('/api', api);

  // Product photos (only for signed-in users).
  app.use('/uploads', requireAuth, express.static(config.uploadsDir, { maxAge: '7d', fallthrough: false }));

  // Serve the built React app in production.
  if (fs.existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
