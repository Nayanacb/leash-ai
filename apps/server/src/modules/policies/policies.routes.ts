import {
  CompilePolicyInputSchema,
  ConfirmPolicyInputSchema,
  IdParamSchema,
  PausePolicyInputSchema,
  SimulatePurchaseInputSchema,
  UpdateDraftInputSchema,
  ValidatePolicyInputSchema,
} from '@leash/shared';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { currentUser } from '../../middleware/session.js';
import { actorFrom } from '../agents/agents.routes.js';
import {
  budgetStatus,
  compilePolicy,
  confirmPolicy,
  duplicateVersion,
  getActivePolicy,
  getPolicyVersion,
  listPolicyVersions,
  pauseSpending,
  rejectDraft,
  simulatePurchase,
  updateDraft,
  validateForUser,
} from './policies.service.js';

export function policiesRouter(ctx: AppContext): Router {
  const { limiters } = ctx;
  const deps = { db: ctx.db, config: ctx.config };
  const router = Router();

  router.get('/policies/versions', async (req, res) => {
    res.json({ versions: await listPolicyVersions(deps, currentUser(req).id) });
  });

  router.get('/policies/active', async (req, res) => {
    res.json({ policy: await getActivePolicy(deps, currentUser(req).id) });
  });

  router.get('/policies/budget-status', async (req, res) => {
    res.json(await budgetStatus(deps, currentUser(req).id));
  });

  router.get('/policies/versions/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await getPolicyVersion(deps, currentUser(req).id, id));
  });

  /** Natural language → DRAFT. Calls the LLM; rate-limited per user. */
  router.post('/policies/compile', limiters.policyCompilePerUser, async (req, res) => {
    const input = CompilePolicyInputSchema.parse(req.body);
    res
      .status(201)
      .json(await compilePolicy({ ...deps, compiler: ctx.policyCompiler }, actorFrom(req), input));
  });

  /** Deterministic validation + rendering of hand-edited JSON, without saving. */
  router.post('/policies/validate', async (req, res) => {
    const { compiledRules } = ValidatePolicyInputSchema.parse(req.body);
    res.json(await validateForUser(deps, currentUser(req).id, compiledRules));
  });

  router.patch('/policies/versions/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const { compiledRules } = UpdateDraftInputSchema.parse(req.body);
    res.json(await updateDraft(deps, actorFrom(req), id, compiledRules));
  });

  // Step-up endpoints share the per-IP auth limiter, so they can't be used to guess passwords.
  router.post('/policies/versions/:id/confirm', limiters.authPerIp, async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const input = ConfirmPolicyInputSchema.parse(req.body);
    res.json(await confirmPolicy(deps, actorFrom(req), id, input));
  });

  router.post('/policies/versions/:id/reject', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await rejectDraft(deps, actorFrom(req), id));
  });

  router.post('/policies/versions/:id/duplicate', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.status(201).json(await duplicateVersion(deps, actorFrom(req), id));
  });

  router.post('/policies/pause', limiters.authPerIp, async (req, res) => {
    const { password } = PausePolicyInputSchema.parse(req.body);
    await pauseSpending(deps, actorFrom(req), password);
    res.status(204).end();
  });

  router.post('/policies/simulate', async (req, res) => {
    const input = SimulatePurchaseInputSchema.parse(req.body);
    res.json(await simulatePurchase(deps, currentUser(req).id, input));
  });

  return router;
}
