import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation ID for logs, audit entries and error responses. */
      requestId: string;
    }
  }
}

/**
 * Accepts a caller-supplied X-Request-Id only if it is short and safe to log;
 * otherwise generates one. The ID is echoed back in the response header.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};
