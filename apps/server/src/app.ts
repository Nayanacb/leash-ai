import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config/env.js';
import type { AppContext } from './context.js';
import { databaseProbe, type Database, type DatabaseProbe } from './db.js';
import type { Logger } from './lib/logger.js';
import { originGuard, requireCsrf, requireJsonBody } from './middleware/csrf.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import {
  createRateLimiters,
  DEFAULT_RATE_LIMITS,
  type RateLimitSettings,
} from './middleware/rateLimit.js';
import { requestId } from './middleware/requestId.js';
import { requireUser, sessionAuth } from './middleware/session.js';
import { agentApiRouter } from './modules/agentApi/agentApi.routes.js';
import { agentsRouter } from './modules/agents/agents.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { merchantsRouter } from './modules/merchants/merchants.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { policiesRouter } from './modules/policies/policies.routes.js';
import type { PolicyCompiler } from './modules/policies/compiler.js';
import { policyCompilerFromConfig, purchaseEvaluatorsFromConfig } from './llm/index.js';
import type { PurchaseEvaluators } from './modules/evaluation/evaluators.js';
import { transactionsRouter } from './modules/purchases/transactions.routes.js';
import { PURCHASE_REQUEST_MAX_BODY_BYTES } from '@leash/shared';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  db: Database;
  /** Readiness probe; defaults to a `SELECT 1` against `db`. */
  probe?: DatabaseProbe;
  version: string;
  rateLimits?: Partial<RateLimitSettings>;
  /** Override the policy compiler (tests). Defaults to the configured Anthropic compiler, or null. */
  policyCompiler?: PolicyCompiler | null;
  /** Override the AI purchase evaluators (tests). Defaults to the configured Anthropic evaluators, or null. */
  purchaseEvaluators?: PurchaseEvaluators | null;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger, db } = deps;
  const app = express();
  const limiters = createRateLimiters({ ...DEFAULT_RATE_LIMITS, ...deps.rateLimits });
  const policyCompiler =
    deps.policyCompiler !== undefined ? deps.policyCompiler : policyCompilerFromConfig(config);
  const purchaseEvaluators =
    deps.purchaseEvaluators !== undefined
      ? deps.purchaseEvaluators
      : purchaseEvaluatorsFromConfig(config);
  const ctx: AppContext = { config, db, logger, limiters, policyCompiler, purchaseEvaluators };
  const probe = deps.probe ?? databaseProbe(db);

  app.disable('x-powered-by');
  // Not behind a proxy in development. Revisit (and restrict) when deploying behind one.
  app.set('trust proxy', false);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      // Health probes are noisy; keep them out of the logs unless they fail.
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
    }),
  );

  // The API serves JSON only, so lock the browser down completely.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );

  // No CORS middleware on purpose: the dashboard is served from the same origin
  // (Vite proxies /api in development), so cross-origin requests are refused by default.
  // PayPal webhooks (Phase 8) will mount a raw-body route *before* this parser.
  // Purchase requests carry source context, so they get a larger (but still bounded) body limit.
  // Mounted first: the global parser below skips bodies that are already parsed.
  app.use(
    '/api/agent/v1/purchase-requests',
    express.json({ limit: PURCHASE_REQUEST_MAX_BODY_BYTES, strict: true }),
  );
  app.use(express.json({ limit: '100kb', strict: true }));

  app.use(healthRouter({ db: probe, version: deps.version, logger }));
  app.use('/api', limiters.api);
  app.use('/api', healthRouter({ db: probe, version: deps.version, logger }));
  app.use('/api', (_req, res, next) => {
    // API responses contain account data; never cache them.
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ── User (dashboard) API: session cookie + CSRF ─────────────────────────
  const userApi = Router();
  userApi.use(originGuard(config.allowedOrigins), requireJsonBody, sessionAuth({ db, config }));
  userApi.use(authRouter(ctx));
  // Everything below requires a signed-in user, and a CSRF token on mutations.
  userApi.use(requireUser, requireCsrf);
  userApi.use(
    agentsRouter(ctx),
    merchantsRouter(ctx),
    tasksRouter(ctx),
    policiesRouter(ctx),
    transactionsRouter(ctx),
    auditRouter(ctx),
  );
  app.use('/api/v1', userApi);

  // ── Agent API: bearer API keys only ─────────────────────────────────────
  app.use('/api/agent/v1', agentApiRouter(ctx));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ exposeInternalErrors: !config.isProduction }));

  return app;
}
