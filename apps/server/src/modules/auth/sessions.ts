import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { hmacBase64Url, randomToken, safeEqual, sha256Hex } from '../../lib/crypto.js';

/** Session lookups touch lastSeenAt at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60_000;

export function sessionCookieName(config: AppConfig): string {
  // __Host- forces Secure, Path=/ and no Domain — only usable over HTTPS.
  return config.session.secureCookie ? '__Host-leash_session' : 'leash_session';
}

export function sessionCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    secure: config.session.secureCookie,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: config.session.absoluteTtlMs,
  };
}

/**
 * CSRF token bound to the session: HMAC keyed by the session token. Only a
 * holder of the (httpOnly) session cookie value can compute it, and it changes
 * whenever the session does. Nothing extra needs to be stored.
 */
export function csrfTokenFor(sessionToken: string): string {
  return hmacBase64Url(sessionToken, 'leash-csrf-v1');
}

export function isValidCsrfToken(sessionToken: string, provided: string | undefined): boolean {
  return typeof provided === 'string' && safeEqual(csrfTokenFor(sessionToken), provided);
}

export async function createSession(
  tx: Prisma.TransactionClient,
  config: AppConfig,
  userId: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const session = await tx.session.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + config.session.absoluteTtlMs),
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  });
  return { token, sessionId: session.id };
}

export interface ResolvedSession {
  sessionId: string;
  /** Last successful step-up re-authentication for this session, if any. */
  stepUpAt: Date | null;
  user: { id: string; email: string; createdAt: Date };
}

/** When this session's step-up stops counting, or null if there is no valid step-up. */
export function stepUpExpiresAt(
  config: AppConfig,
  stepUpAt: Date | null,
  now = new Date(),
): Date | null {
  if (!stepUpAt) return null;
  const expires = new Date(stepUpAt.getTime() + config.session.stepUpWindowMs);
  return expires.getTime() > now.getTime() ? expires : null;
}

/** Returns the session for a raw cookie token, or null if unknown, expired or idle too long. */
export async function resolveSession(
  db: Database,
  config: AppConfig,
  token: string,
): Promise<ResolvedSession | null> {
  if (token.length < 32 || token.length > 128) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: { select: { id: true, email: true, createdAt: true } } },
  });
  if (!session) return null;

  const now = Date.now();
  if (
    session.expiresAt.getTime() <= now ||
    session.lastSeenAt.getTime() + config.session.idleTimeoutMs <= now
  ) {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }
  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.session.updateMany({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
  }
  return { sessionId: session.id, stepUpAt: session.stepUpAt, user: session.user };
}
