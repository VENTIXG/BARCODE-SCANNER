export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code?: string, details?: unknown) => new HttpError(400, msg, code, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg: string, code?: string, details?: unknown) => new HttpError(409, msg, code, details);
export const forbidden = (msg = 'You do not have permission to perform this action') =>
  new HttpError(403, msg, 'FORBIDDEN');
