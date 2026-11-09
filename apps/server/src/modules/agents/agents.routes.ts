import {
  CreateAgentInputSchema,
  CreateApiKeyInputSchema,
  IdParamSchema,
  UpdateAgentInputSchema,
} from '@leash/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requestMeta } from '../../lib/requestMeta.js';
import { currentUser } from '../../middleware/session.js';
import {
  createAgent,
  createApiKey,
  getAgent,
  listAgents,
  revokeApiKey,
  updateAgent,
  type Actor,
} from './agents.service.js';

const KeyParamsSchema = z.object({ id: z.uuid(), keyId: z.uuid() });

export function actorFrom(req: Request): Actor {
  return { userId: currentUser(req).id, meta: requestMeta(req) };
}

export function agentsRouter({ db }: AppContext): Router {
  const router = Router();

  router.get('/agents', async (req, res) => {
    res.json({ agents: await listAgents(db, currentUser(req).id) });
  });

  router.post('/agents', async (req, res) => {
    const { name } = CreateAgentInputSchema.parse(req.body);
    res.status(201).json(await createAgent(db, actorFrom(req), name));
  });

  router.get('/agents/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await getAgent(db, currentUser(req).id, id));
  });

  router.patch('/agents/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const patch = UpdateAgentInputSchema.parse(req.body);
    res.json(await updateAgent(db, actorFrom(req), id, patch));
  });

  router.post('/agents/:id/keys', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const input = CreateApiKeyInputSchema.parse(req.body);
    // The plaintext key appears in this response only. Make sure nothing caches it.
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(await createApiKey(db, actorFrom(req), id, input));
  });

  router.delete('/agents/:id/keys/:keyId', async (req, res) => {
    const { id, keyId } = KeyParamsSchema.parse(req.params);
    res.json(await revokeApiKey(db, actorFrom(req), id, keyId));
  });

  return router;
}
