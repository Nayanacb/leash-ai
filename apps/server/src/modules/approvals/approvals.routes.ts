import {
  ApprovalListQuerySchema,
  ApproveInputSchema,
  IdParamSchema,
  RejectInputSchema,
} from '@leash/shared';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { currentUser, requireRecentStepUp } from '../../middleware/session.js';
import { actorFrom } from '../agents/agents.routes.js';
import { approvePurchase, listApprovals, rejectPurchase } from './approvals.service.js';

/**
 * Human approval of escalated purchases. Session + CSRF (applied by the user
 * API router); approving additionally requires a recent step-up. Agents can
 * never reach these routes: agent keys are not accepted by the user API.
 */
export function approvalsRouter(ctx: AppContext): Router {
  const { db, config } = ctx;
  const router = Router();

  router.get('/approvals', async (req, res) => {
    const query = ApprovalListQuerySchema.parse(req.query);
    res.json(await listApprovals(db, currentUser(req).id, query));
  });

  router.post('/approvals/:id/approve', requireRecentStepUp(config), async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const input = ApproveInputSchema.parse(req.body);
    res.json(
      await approvePurchase(
        { db, config },
        { ...actorFrom(req), stepUpAt: req.auth!.stepUpAt },
        id,
        input,
      ),
    );
  });

  router.post('/approvals/:id/reject', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const input = RejectInputSchema.parse(req.body ?? {});
    res.json(await rejectPurchase({ db, config }, actorFrom(req), id, input));
  });

  return router;
}
