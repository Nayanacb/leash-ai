import { CreateTaskInputSchema, IdParamSchema, TaskListQuerySchema } from '@leash/shared';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { currentUser } from '../../middleware/session.js';
import { actorFrom } from '../agents/agents.routes.js';
import { createTask, finishTask, getTask, listTasks } from './tasks.service.js';

export function tasksRouter({ db }: AppContext): Router {
  const router = Router();

  router.get('/tasks', async (req, res) => {
    const { status } = TaskListQuerySchema.parse(req.query);
    res.json({ tasks: await listTasks(db, currentUser(req).id, status) });
  });

  router.post('/tasks', async (req, res) => {
    const input = CreateTaskInputSchema.parse(req.body);
    res.status(201).json(await createTask(db, actorFrom(req), input));
  });

  router.get('/tasks/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await getTask(db, currentUser(req).id, id));
  });

  router.post('/tasks/:id/cancel', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await finishTask(db, actorFrom(req), id, 'CANCELLED'));
  });

  router.post('/tasks/:id/complete', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await finishTask(db, actorFrom(req), id, 'COMPLETED'));
  });

  return router;
}
