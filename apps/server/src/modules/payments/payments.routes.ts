import { IdempotencyKeySchema, IdParamSchema, RefundInputSchema } from '@leash/shared';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { requestMeta } from '../../lib/requestMeta.js';
import { currentUser } from '../../middleware/session.js';
import { completeCheckout, startCheckout, type PaymentDeps } from './checkout.service.js';
import { requestRefund } from './refunds.service.js';

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

  /** Refund all or part of a captured purchase (user only; agents can't refund). */
  router.post('/transactions/:id/refunds', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const key = IdempotencyKeySchema.safeParse(req.get('idempotency-key'));
    if (!key.success) {
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send a unique Idempotency-Key header (8–128 URL-safe characters) with every refund',
      );
    }
    const input = RefundInputSchema.parse(req.body ?? {});
    const user = currentUser(req);
    res.json(
      await requestRefund(deps, { userId: user.id, meta: requestMeta(req) }, id, input, key.data),
    );
  });

  return router;
}
