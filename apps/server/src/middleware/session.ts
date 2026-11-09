import type { RequestHandler } from 'express';
import { parseCookie } from 'cookie';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../db.js';
import { AppError } from '../lib/errors.js';
import { resolveSession, sessionCookieName } from '../modules/auth/sessions.js';

export interface SessionAuth {
  sessionId: string;
  /** Raw cookie value; used only to derive/verify the CSRF token. Never logged or returned. */
  sessionToken: string;
  user: { id: string; email: string; createdAt: Date };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: SessionAuth;
    }
  }
}

export function readSessionToken(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  return parseCookie(cookieHeader)[name];
}

/** Attaches `req.auth` when a valid session cookie is present. Never rejects. */
export function sessionAuth(deps: { db: Database; config: AppConfig }): RequestHandler {
  const cookieName = sessionCookieName(deps.config);
  return async (req, _res, next) => {
    const token = readSessionToken(req.get('cookie'), cookieName);
    if (token) {
      const resolved = await resolveSession(deps.db, deps.config, token);
      if (resolved) req.auth = { ...resolved, sessionToken: token };
    }
    next();
  };
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  next();
};

/** For handlers placed after requireUser. */
export function currentUser(req: Express.Request): SessionAuth['user'] {
  if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  return req.auth.user;
}
