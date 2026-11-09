import type { ApiError } from '@leash/shared';
import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

export interface RateLimitSettings {
  /** All /api requests, per client IP. */
  apiPerMinute: number;
  /** Login + register attempts, per client IP, per 15 minutes. */
  authPerIpPer15Min: number;
  /** Failed logins against one email, per 15 minutes. */
  loginFailuresPerAccountPer15Min: number;
  /** Agent API requests, per API key, per minute. */
  agentPerKeyPerMinute: number;
  /** Policy compilations (paid LLM calls), per user, per hour. */
  policyCompilesPerUserPerHour: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  apiPerMinute: 300,
  authPerIpPer15Min: 30,
  loginFailuresPerAccountPer15Min: 10,
  agentPerKeyPerMinute: 120,
  policyCompilesPerUserPerHour: 20,
};

const FIFTEEN_MINUTES = 15 * 60_000;

function limiter(options: {
  windowMs: number;
  limit: number;
  keyGenerator?: (req: Parameters<RequestHandler>[0]) => string;
  skipSuccessfulRequests?: boolean;
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    keyGenerator: options.keyGenerator ?? ((req) => ipKeyGenerator(req.ip ?? 'unknown')),
    handler: (req, res) => {
      const body: ApiError = {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Try again later.',
          requestId: req.requestId,
        },
      };
      res.status(429).json(body);
    },
  });
}

/**
 * In-memory stores: correct for a single server process. Multi-instance
 * deployments need a shared store (e.g. Postgres) — tracked for Phase 9.
 */
export function createRateLimiters(settings: RateLimitSettings) {
  return {
    api: limiter({ windowMs: 60_000, limit: settings.apiPerMinute }),
    authPerIp: limiter({ windowMs: FIFTEEN_MINUTES, limit: settings.authPerIpPer15Min }),
    loginPerAccount: limiter({
      windowMs: FIFTEEN_MINUTES,
      limit: settings.loginFailuresPerAccountPer15Min,
      skipSuccessfulRequests: true,
      keyGenerator: (req) => {
        const email = (req.body as { email?: unknown } | undefined)?.email;
        return `login:${typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : ''}`;
      },
    }),
    policyCompilePerUser: limiter({
      windowMs: 60 * 60_000,
      limit: settings.policyCompilesPerUserPerHour,
      keyGenerator: (req) => `policy-compile:${req.auth?.user.id ?? 'anonymous'}`,
    }),
    agentPerKey: limiter({
      windowMs: 60_000,
      limit: settings.agentPerKeyPerMinute,
      keyGenerator: (req) => `agent-key:${req.agentAuth?.keyId ?? 'anonymous'}`,
    }),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;
