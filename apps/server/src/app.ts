import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config/env.js';
import type { DatabaseProbe } from './db.js';
import type { Logger } from './lib/logger.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  db: DatabaseProbe;
  version: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  // Not behind a proxy in development. Revisit (and restrict) when deploying behind one.
  app.set('trust proxy', false);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
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
  app.use(express.json({ limit: '100kb', strict: true }));

  app.use(healthRouter({ db: deps.db, version: deps.version, logger: deps.logger }));
  app.use('/api', healthRouter({ db: deps.db, version: deps.version, logger: deps.logger }));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ exposeInternalErrors: !deps.config.isProduction }));

  return app;
}
