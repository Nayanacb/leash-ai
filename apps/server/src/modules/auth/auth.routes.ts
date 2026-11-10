import {
  LoginInputSchema,
  RegisterInputSchema,
  StepUpInputSchema,
  type SessionResponse,
  type StepUpResponse,
  type UserDto,
} from '@leash/shared';
import { Router, type Request, type Response } from 'express';
import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/prismaErrors.js';
import { requestMeta } from '../../lib/requestMeta.js';
import { requireCsrf } from '../../middleware/csrf.js';
import { currentUser, readSessionToken, requireUser } from '../../middleware/session.js';
import { validateBody } from '../../middleware/validate.js';
import { appendAuditEvent, recordAuditEvent } from '../audit/auditLog.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import {
  createSession,
  csrfTokenFor,
  sessionCookieName,
  sessionCookieOptions,
  stepUpExpiresAt,
} from './sessions.js';
import { sha256Hex } from '../../lib/crypto.js';

function toUserDto(user: { id: string; email: string; createdAt: Date }): UserDto {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

export function authRouter(ctx: AppContext): Router {
  const { db, config, limiters } = ctx;
  const router = Router();
  const cookieName = sessionCookieName(config);
  const cookieOptions = sessionCookieOptions(config);
  const { maxAge: _maxAge, ...clearCookieOptions } = cookieOptions;

  /** Ends whatever session the browser already had, so logging in always rotates the session. */
  async function endPreviousSession(req: Request) {
    const previous = readSessionToken(req.get('cookie'), cookieName);
    if (previous) await db.session.deleteMany({ where: { tokenHash: sha256Hex(previous) } });
  }

  function sendSession(res: Response, status: number, user: UserDto, token: string) {
    res.cookie(cookieName, token, cookieOptions);
    // A new session never inherits a step-up.
    const body: SessionResponse = { user, csrfToken: csrfTokenFor(token), stepUpExpiresAt: null };
    res.status(status).json(body);
  }

  router.post(
    '/auth/register',
    limiters.authPerIp,
    validateBody(RegisterInputSchema),
    async (req, res) => {
      const { email, password } = RegisterInputSchema.parse(req.body);
      if (
        password.toLowerCase().includes(email.split('@')[0]!) &&
        email.split('@')[0]!.length >= 4
      ) {
        throw AppError.badRequest('Password must not contain your email name');
      }
      const meta = requestMeta(req);
      const passwordHash = await hashPassword(password);

      let created;
      try {
        created = await db.$transaction(async (tx) => {
          const user = await tx.user.create({ data: { email, passwordHash } });
          const session = await createSession(tx, config, user.id, meta);
          await appendAuditEvent(tx, {
            actorType: 'USER',
            actorId: user.id,
            userId: user.id,
            action: 'user.registered',
            data: { email, ...meta },
          });
          return { user, session };
        });
      } catch (err) {
        if (isUniqueViolation(err))
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
        throw err;
      }

      await endPreviousSession(req);
      sendSession(res, 201, toUserDto(created.user), created.session.token);
    },
  );

  router.post(
    '/auth/login',
    limiters.authPerIp,
    validateBody(LoginInputSchema),
    limiters.loginPerAccount,
    async (req, res) => {
      const { email, password } = LoginInputSchema.parse(req.body);
      const meta = requestMeta(req);
      const user = await db.user.findUnique({ where: { email } });
      const ok = user
        ? await verifyPassword(user.passwordHash, password)
        : await verifyAgainstDummy(password);

      if (!user || !ok) {
        if (user) {
          await recordAuditEvent(db, {
            actorType: 'USER',
            actorId: null,
            userId: user.id,
            action: 'user.login_failed',
            data: meta,
          });
        }
        ctx.logger.info({ requestId: req.requestId }, 'login failed');
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }

      const session = await db.$transaction(async (tx) => {
        const s = await createSession(tx, config, user.id, meta);
        await appendAuditEvent(tx, {
          actorType: 'USER',
          actorId: user.id,
          userId: user.id,
          action: 'user.login_succeeded',
          data: meta,
        });
        return s;
      });

      await endPreviousSession(req);
      sendSession(res, 200, toUserDto(user), session.token);
    },
  );

  router.get('/auth/session', requireUser, (req, res) => {
    const auth = req.auth!;
    const body: SessionResponse = {
      user: toUserDto(auth.user),
      csrfToken: csrfTokenFor(auth.sessionToken),
      stepUpExpiresAt: stepUpExpiresAt(config, auth.stepUpAt)?.toISOString() ?? null,
    };
    res.json(body);
  });

  /**
   * Step-up re-authentication: confirms the password for THIS session and
   * unlocks sensitive actions (approving purchases) for STEP_UP_WINDOW_MINUTES.
   * Shares the per-IP auth limiter so it can't be used to guess passwords.
   */
  router.post('/auth/step-up', requireUser, requireCsrf, limiters.authPerIp, async (req, res) => {
    const { password } = StepUpInputSchema.parse(req.body);
    const user = currentUser(req);
    const meta = requestMeta(req);
    const stored = await db.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!(await verifyPassword(stored.passwordHash, password))) {
      await recordAuditEvent(db, {
        actorType: 'USER',
        actorId: user.id,
        userId: user.id,
        action: 'user.step_up_failed',
        data: { purpose: 'step_up', ...meta },
      });
      throw new AppError(401, 'INVALID_PASSWORD', 'Password is incorrect');
    }
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.session.update({ where: { id: req.auth!.sessionId }, data: { stepUpAt: now } });
      await appendAuditEvent(tx, {
        actorType: 'USER',
        actorId: user.id,
        userId: user.id,
        action: 'user.step_up_succeeded',
        data: meta,
      });
    });
    const body: StepUpResponse = {
      stepUpExpiresAt: stepUpExpiresAt(config, now, now)!.toISOString(),
    };
    res.json(body);
  });

  router.post('/auth/logout', requireUser, requireCsrf, async (req, res) => {
    const user = currentUser(req);
    await db.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { id: req.auth!.sessionId } });
      await appendAuditEvent(tx, {
        actorType: 'USER',
        actorId: user.id,
        userId: user.id,
        action: 'user.logged_out',
        data: requestMeta(req),
      });
    });
    res.clearCookie(cookieName, clearCookieOptions);
    res.status(204).end();
  });

  /** Ends every session for this user — the response to a suspected session compromise. */
  router.post('/auth/logout-all', requireUser, requireCsrf, async (req, res) => {
    const user = currentUser(req);
    await db.$transaction(async (tx) => {
      const { count } = await tx.session.deleteMany({ where: { userId: user.id } });
      await appendAuditEvent(tx, {
        actorType: 'USER',
        actorId: user.id,
        userId: user.id,
        action: 'user.logged_out_everywhere',
        data: { ...requestMeta(req), sessionsEnded: count },
      });
    });
    res.clearCookie(cookieName, clearCookieOptions);
    res.status(204).end();
  });

  return router;
}
