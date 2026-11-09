import { IdParamSchema, TaskListQuerySchema } from '@leash/shared';
import { Router, type Request } from 'express';
import type { AppContext } from '../../context.js';
import { AppError } from '../../lib/errors.js';
import { agentAuth } from '../../middleware/agentAuth.js';
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

  const readOnly = () => {
    throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Agents cannot create or modify tasks');
  };
  router.all('/tasks', readOnly);
  router.all('/tasks/{*rest}', readOnly);

  return router;
}
