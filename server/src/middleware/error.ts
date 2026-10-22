import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { message: `Route ${req.method} ${req.path} not found`, code: 'NOT_FOUND' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    return res.status(400).json({
      error: {
        message: first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid input',
        code: 'VALIDATION_ERROR',
        details: issues,
      },
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code, details: err.details } });
  }
  const e = err as { code?: string; message?: string; type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Request is too large', code: 'TOO_LARGE' } });
  }
  if (e?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Malformed JSON body', code: 'BAD_JSON' } });
  }
  // PostgreSQL integrity errors (class 23): unique, foreign key, check, not null.
  if (typeof e?.code === 'string' && /^23[0-9A-Z]{3}$/.test(e.code)) {
    const constraint = (err as { constraint?: string }).constraint ?? '';
    let message = 'The operation violates a data constraint';
    if (constraint === 'products_sku_key') message = 'A product with this SKU already exists';
    else if (e.code === '23505') message = 'A record with the same unique value already exists';
    else if (e.code === '23503' || e.code === '23001') message = 'This record is referenced by other data and cannot be changed';
    return res.status(409).json({ error: { message, code: 'CONSTRAINT' } });
  }
  // PostgreSQL data exceptions (class 22): a number out of range, text the database cannot
  // hold, an invalid date ... The request was wrong, nothing was written.
  if (typeof e?.code === 'string' && /^22[0-9A-Z]{3}$/.test(e.code)) {
    return res.status(400).json({ error: { message: 'A value in the request is out of range or invalid', code: 'INVALID_VALUE' } });
  }
  if (e?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: { message: 'File is too large', code: 'TOO_LARGE' } });
  }
  console.error(err);
  res.status(500).json({ error: { message: 'Internal server error', code: 'INTERNAL' } });
}
