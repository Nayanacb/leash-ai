import type { HealthResponse, ReadinessResponse } from '@leash/shared';
import { Router } from 'express';
import type { DatabaseProbe } from '../db.js';
import type { Logger } from '../lib/logger.js';

export function healthRouter(deps: { db: DatabaseProbe; version: string; logger: Logger }): Router {
  const router = Router();

  /** Liveness: the process is up. Never touches dependencies. */
  router.get('/healthz', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'leash-server',
      version: deps.version,
      uptimeSeconds: Math.round(process.uptime()),
      paypalEnvironment: 'sandbox',
    };
    res.json(body);
  });

  /** Readiness: dependencies are reachable. */
  router.get('/readyz', async (_req, res) => {
    let database: ReadinessResponse['checks']['database'] = 'ok';
    try {
      await deps.db.ping();
    } catch (err) {
      deps.logger.warn({ err }, 'readiness check: database unreachable');
      database = 'error';
    }
    const body: ReadinessResponse = {
      status: database === 'ok' ? 'ready' : 'not_ready',
      checks: { database },
    };
    res.status(body.status === 'ready' ? 200 : 503).json(body);
  });

  return router;
}
