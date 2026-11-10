import {
  IdempotencyKeySchema,
  IdParamSchema,
  PurchaseRequestInputSchema,
  TaskListQuerySchema,
} from '@leash/shared';
import { Router, type Request } from 'express';
import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { agentAuth } from '../../middleware/agentAuth.js';
import {
  cancelPurchase,
  getPurchaseForAgent,
  submitPurchaseRequest,
  toAgentResponse,
} from '../purchases/purchases.service.js';
import { getTaskForAgent, listTasksForAgent } from '../tasks/tasks.service.js';

function agentFrom(req: Request) {
  if (!req.agentAuth) throw new AppError(401, 'INVALID_API_KEY', 'Invalid or inactive API key');
  return req.agentAuth;
}

/**
 * The agent-facing API. Authenticated only by agent API keys — session cookies
 * are ignored here, and agent keys are ignored by the user API.
 *
 * Tasks are READ-ONLY for agents: there is deliberately no route that creates,
 * edits, cancels or completes a mandate.
 */
export function agentApiRouter(ctx: AppContext): Router {
  const { db, limiters } = ctx;
  const router = Router();

  router.use(agentAuth({ db }), limiters.agentPerKey);

  router.get('/me', async (req, res) => {
    const { agentId } = agentFrom(req);
    const agent = await db.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { id: true, name: true },
    });
    res.json({ agent });
  });

  router.get('/tasks', async (req, res) => {
    const { status } = TaskListQuerySchema.parse(req.query);
    res.json({ tasks: await listTasksForAgent(db, agentFrom(req), status) });
  });

  router.get('/tasks/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await getTaskForAgent(db, agentFrom(req), id));
  });

  // ── Purchase requests ───────────────────────────────────────────────────
  // Body parsing for these routes (256 KB) is mounted in app.ts ahead of the global 100 KB parser.

  router.post('/purchase-requests', limiters.purchasePerAgent, async (req, res) => {
    const key = IdempotencyKeySchema.safeParse(req.get('idempotency-key'));
    if (!key.success) {
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Send a unique Idempotency-Key header (8–128 URL-safe characters) with every purchase request',
      );
    }
    const input = PurchaseRequestInputSchema.parse(req.body);
    const result = await submitPurchaseRequest(
      { db, config: ctx.config, logger: ctx.logger, evaluators: ctx.purchaseEvaluators },
      agentFrom(req),
      key.data,
      input,
    );
    res.status(result.httpStatus).json(result.body);
  });

  router.get('/purchase-requests/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await getPurchaseForAgent(db, agentFrom(req), id));
  });

  router.post('/purchase-requests/:id/cancel', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const agent = agentFrom(req);
    const tx = await cancelPurchase(db, {
      userId: agent.userId,
      agentId: agent.agentId,
      transactionId: id,
      actor: { type: 'AGENT', id: agent.agentId },
    });
    res.json(toAgentResponse(tx));
  });

  const readOnly = () => {
    throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Agents cannot create or modify tasks');
  };
  router.all('/tasks', readOnly);
  router.all('/tasks/{*rest}', readOnly);

  return router;
}
