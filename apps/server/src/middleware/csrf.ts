import { CSRF_HEADER } from '@leash/shared';
import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { isValidCsrfToken } from '../modules/auth/sessions.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Layer 1 — origin check for state-changing browser requests. A request that
 * declares a foreign Origin, or is marked cross-site by Sec-Fetch-Site, is
 * refused. Requests with neither header are not from a browser and so are not
 * a CSRF vector; they still need the CSRF token on authenticated routes.
 */
export function originGuard(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin !== undefined && !allowed.has(origin)) {
      throw new AppError(403, 'FORBIDDEN_ORIGIN', 'Cross-origin request refused');
    }
    const fetchSite = req.get('sec-fetch-site');
    if (
      origin === undefined &&
      fetchSite !== undefined &&
      fetchSite !== 'same-origin' &&
      fetchSite !== 'none'
    ) {
      throw new AppError(403, 'FORBIDDEN_ORIGIN', 'Cross-site request refused');
    }
    next();
  };
}

/**
 * Layer 2 — JSON-only bodies. HTML forms cannot send application/json without
 * a CORS preflight, which this server never approves.
 */
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const hasBody =
    Number(req.get('content-length') ?? 0) > 0 || req.get('transfer-encoding') !== undefined;
  if (hasBody && !req.is('application/json')) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request body must be application/json');
  }
  next();
};

/** Layer 3 — session-bound CSRF token on every authenticated state-changing request. */
export const requireCsrf: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.auth || !isValidCsrfToken(req.auth.sessionToken, req.get(CSRF_HEADER))) {
    throw new AppError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token');
  }
  next();
};
