import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import { config } from './config.js';
import { requireAuth, requirePermission } from './middleware/auth.js';
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
  app.use(compression());
  app.use(express.json({ limit: '30mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.use('/auth', authRouter);

  // Everything below requires a signed-in user.
  api.use(requireAuth);
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
