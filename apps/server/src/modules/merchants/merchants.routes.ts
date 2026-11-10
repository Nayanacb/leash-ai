import { CreateMerchantInputSchema, IdParamSchema, UpdateMerchantInputSchema } from '@leash/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { currentUser } from '../../middleware/session.js';
import { actorFrom } from '../agents/agents.routes.js';
import { createMerchant, getMerchant, listMerchants, updateMerchant } from './merchants.service.js';

const ListQuerySchema = z.object({ includeArchived: z.enum(['true', 'false']).optional() });

export function merchantsRouter({ db }: AppContext): Router {
  const router = Router();

  router.get('/merchants', async (req, res) => {
    const { includeArchived } = ListQuerySchema.parse(req.query);
    res.json({
      merchants: await listMerchants(db, currentUser(req).id, includeArchived === 'true'),
    });
  });

  router.post('/merchants', async (req, res) => {
    const input = CreateMerchantInputSchema.parse(req.body);
    res.status(201).json(await createMerchant(db, actorFrom(req), input));
  });

  router.get('/merchants/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await getMerchant(db, currentUser(req).id, id));
  });

  router.patch('/merchants/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const patch = UpdateMerchantInputSchema.parse(req.body);
    res.json(await updateMerchant(db, actorFrom(req), id, patch));
  });

  return router;
}
