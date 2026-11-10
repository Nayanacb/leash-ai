import { IdParamSchema } from '@leash/shared';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { requestMeta } from '../../lib/requestMeta.js';
import { currentUser } from '../../middleware/session.js';
import { completeCheckout, startCheckout, type PaymentDeps } from './checkout.service.js';

/**
 * Dashboard-only payment routes (session + CSRF, mounted in the user API).
 * Agents have no route here: they never see PayPal links, orders or credentials.
 */
export function paymentsRouter(ctx: AppContext): Router {
  const router = Router();
  const deps: PaymentDeps = {
    db: ctx.db,
    config: ctx.config,
    provider: ctx.paymentProvider,
    logger: ctx.logger,
  };

  router.post('/transactions/:id/checkout', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const user = currentUser(req);
    res.json(await startCheckout(deps, { userId: user.id, meta: requestMeta(req) }, id));
  });

  /** Called by the dashboard's PayPal return page. Nothing from PayPal's redirect is trusted. */
  router.post('/transactions/:id/checkout/complete', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const user = currentUser(req);
    res.json(await completeCheckout(deps, { userId: user.id, meta: requestMeta(req) }, id));
  });

  return router;
}
