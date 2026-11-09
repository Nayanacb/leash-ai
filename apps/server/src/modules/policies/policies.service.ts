import {
  parseDecimalToMinor,
  PolicyDocumentSchema,
  renderBuiltInRules,
  renderPolicy,
  MoneyParseError,
  UnmappedClauseSchema,
  type BudgetStatusResponse,
  type Currency,
  type MerchantCategory,
  type PolicyDocument,
  type PolicyVersionDto,
  type PolicyValidationResponse,
  type SimulationResponse,
} from '@leash/shared';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db.js';
import type { PolicyVersion, Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/prismaErrors.js';
import type { Actor } from '../agents/agents.service.js';
import { appendAuditEvent, recordAuditEvent } from '../audit/auditLog.js';
import { verifyPassword } from '../auth/passwords.js';
import { evaluatePolicy } from '../authorization/policyEngine.js';
import {
  committedByTask,
  effectiveTaskStatus,
  loadSpendSnapshot,
  lockUserBudget,
  periodSpend,
} from '../budget/ledger.js';
import { PERIODS, periodBounds } from '../budget/periods.js';
import { PolicyCompilerError, type PolicyCompiler } from './compiler.js';
import { policyRulesHash, validatePolicyDocument } from './validation.js';

interface Deps {
  db: Database;
  config: AppConfig;
}

async function merchantContext(db: Database, userId: string) {
  const merchants = await db.merchant.findMany({
    where: { userId },
    select: { id: true, displayName: true, category: true, archivedAt: true },
  });
  return {
    merchants,
    ids: new Set(merchants.map((m) => m.id)),
    names: Object.fromEntries(
      merchants.map((m) => [m.id, m.archivedAt ? `${m.displayName} (archived)` : m.displayName]),
    ),
  };
}

function toDto(
  version: PolicyVersion,
  merchantNames: Record<string, string>,
  config: AppConfig,
): PolicyVersionDto {
  // Stored documents were validated on write; re-parse to keep the API contract honest.
  const document = PolicyDocumentSchema.parse(version.compiledRules);
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    sourceText: version.sourceText,
    compiledRules: document,
    rulesHash: version.rulesHash,
    rendered: renderPolicy(document, { merchantNames }),
    builtInRules: renderBuiltInRules(config.limits.sandboxMaxTransactionMinor, document.currency),
    unmappedClauses: z.array(UnmappedClauseSchema).catch([]).parse(version.unmappedClauses),
    assumptions: z.array(z.string()).catch([]).parse(version.assumptions),
    compilerModel: version.compilerModel,
    promptVersion: version.promptVersion,
    editedManually: version.editedManually,
    confirmedAt: version.confirmedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
  };
}

export async function listPolicyVersions(
  { db, config }: Deps,
  userId: string,
): Promise<PolicyVersionDto[]> {
  const [versions, ctx] = await Promise.all([
    db.policyVersion.findMany({ where: { userId }, orderBy: { version: 'desc' } }),
    merchantContext(db, userId),
  ]);
  return versions.map((v) => toDto(v, ctx.names, config));
}

export async function getPolicyVersion(
  { db, config }: Deps,
  userId: string,
  id: string,
): Promise<PolicyVersionDto> {
  const version = await db.policyVersion.findFirst({ where: { id, userId } });
  if (!version) throw AppError.notFound('Policy version not found');
  return toDto(version, (await merchantContext(db, userId)).names, config);
}

export async function getActivePolicy(
  { db, config }: Deps,
  userId: string,
): Promise<PolicyVersionDto | null> {
  const version = await db.policyVersion.findFirst({ where: { userId, status: 'ACTIVE' } });
  return version ? toDto(version, (await merchantContext(db, userId)).names, config) : null;
}

export async function validateForUser(
  { db }: Deps,
  userId: string,
  raw: unknown,
): Promise<PolicyValidationResponse> {
  const ctx = await merchantContext(db, userId);
  const result = validatePolicyDocument(raw, ctx.ids);
  return result.valid
    ? {
        valid: true,
        errors: [],
        rendered: renderPolicy(result.document, { merchantNames: ctx.names }),
        rulesHash: result.rulesHash,
      }
    : { valid: false, errors: result.errors, rendered: [], rulesHash: null };
}

/** Creates the next DRAFT version for a user. Retries once if a concurrent draft took the number. */
async function createDraft(
  db: Database,
  actor: Actor,
  data: {
    sourceText: string;
    document: PolicyDocument;
    rulesHash: string;
    compilerModel: string;
    promptVersion: string;
    unmappedClauses: unknown[];
    assumptions: string[];
    editedManually: boolean;
  },
  audit: { action: string; data: Record<string, unknown> },
): Promise<PolicyVersion> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const latest = await tx.policyVersion.findFirst({
          where: { userId: actor.userId },
          orderBy: { version: 'desc' },
        });
        const created = await tx.policyVersion.create({
          data: {
            userId: actor.userId,
            version: (latest?.version ?? 0) + 1,
            status: 'DRAFT',
            sourceText: data.sourceText,
            compiledRules: data.document as unknown as Prisma.InputJsonObject,
            rulesHash: data.rulesHash,
            compilerModel: data.compilerModel,
            promptVersion: data.promptVersion,
            unmappedClauses: data.unmappedClauses as Prisma.InputJsonArray,
            assumptions: data.assumptions,
            editedManually: data.editedManually,
          },
        });
        await appendAuditEvent(tx, {
          actorType: 'USER',
          actorId: actor.userId,
          userId: actor.userId,
          action: audit.action,
          data: {
            policyVersionId: created.id,
            version: created.version,
            rulesHash: data.rulesHash,
            ...audit.data,
            ...actor.meta,
          },
        });
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err) && attempt === 0) continue;
      if (isUniqueViolation(err))
        throw AppError.conflict('Another draft was created at the same time; try again');
      throw err;
    }
  }
}

const COMPILER_STATUS: Record<PolicyCompilerError['code'], number> = {
  LLM_REFUSED: 422,
  LLM_TRUNCATED: 422,
  LLM_INVALID_OUTPUT: 502,
  LLM_UNAVAILABLE: 502,
  LLM_AUTH_FAILED: 502,
  LLM_MODEL_NOT_FOUND: 502,
  LLM_RATE_LIMITED: 503,
};

/**
 * Natural language → DRAFT policy. The draft is inert: nothing is enforced
 * until the user reviews and confirms it.
 */
export async function compilePolicy(
  deps: Deps & { compiler: PolicyCompiler | null },
  actor: Actor,
  input: { sourceText: string; timezone: string; currency: Currency },
): Promise<PolicyVersionDto> {
  const { db, config, compiler } = deps;
  if (!compiler) {
    throw new AppError(
      503,
      'LLM_NOT_CONFIGURED',
      'Policy compilation is not configured. Set ANTHROPIC_API_KEY and LLM_MODEL_POLICY_COMPILER on the server.',
    );
  }
  const ctx = await merchantContext(db, actor.userId);

  let output;
  try {
    output = await compiler.compile({
      sourceText: input.sourceText,
      defaultCurrency: input.currency,
      defaultTimezone: input.timezone,
      merchants: ctx.merchants
        .filter((m) => m.archivedAt === null)
        .map((m) => ({
          id: m.id,
          displayName: m.displayName,
          category: m.category as MerchantCategory,
        })),
    });
  } catch (err) {
    if (err instanceof PolicyCompilerError) {
      await recordAuditEvent(db, {
        actorType: 'USER',
        actorId: actor.userId,
        userId: actor.userId,
        action: 'policy.compile_failed',
        data: { reason: err.code, ...actor.meta },
      });
      throw new AppError(COMPILER_STATUS[err.code], err.code, err.message);
    }
    throw err;
  }

  const result = validatePolicyDocument(output.policy, ctx.ids);
  if (!result.valid) {
    await recordAuditEvent(db, {
      actorType: 'LLM',
      actorId: output.model,
      userId: actor.userId,
      action: 'policy.compile_rejected',
      data: {
        model: output.model,
        promptVersion: output.promptVersion,
        errors: result.errors.slice(0, 20),
      },
    });
    throw new AppError(
      422,
      'COMPILED_POLICY_INVALID',
      'The compiler produced a policy that failed validation. Try rephrasing your rules.',
      result.errors,
    );
  }

  const created = await createDraft(
    db,
    actor,
    {
      sourceText: input.sourceText,
      document: result.document,
      rulesHash: result.rulesHash,
      compilerModel: output.model,
      promptVersion: output.promptVersion,
      unmappedClauses: output.unmappedClauses,
      assumptions: output.assumptions,
      editedManually: false,
    },
    {
      action: 'policy.draft_compiled',
      data: { model: output.model, promptVersion: output.promptVersion },
    },
  );
  return toDto(created, ctx.names, config);
}

/** Hand-edited JSON replaces a draft's rules. Validated exactly like compiler output. */
export async function updateDraft(
  { db, config }: Deps,
  actor: Actor,
  id: string,
  raw: unknown,
): Promise<PolicyVersionDto> {
  const ctx = await merchantContext(db, actor.userId);
  const result = validatePolicyDocument(raw, ctx.ids);
  if (!result.valid)
    throw new AppError(400, 'POLICY_INVALID', 'The policy JSON is invalid', result.errors);

  const updated = await db.$transaction(async (tx) => {
    const draft = await tx.policyVersion.findFirst({ where: { id, userId: actor.userId } });
    if (!draft) throw AppError.notFound('Policy version not found');
    if (draft.status !== 'DRAFT') throw AppError.conflict('Only drafts can be edited');
    const saved = await tx.policyVersion.update({
      where: { id },
      data: {
        compiledRules: result.document as unknown as Prisma.InputJsonObject,
        rulesHash: result.rulesHash,
        editedManually: true,
      },
    });
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: 'policy.draft_edited',
      data: {
        policyVersionId: id,
        fromHash: draft.rulesHash,
        toHash: result.rulesHash,
        ...actor.meta,
      },
    });
    return saved;
  });
  return toDto(updated, ctx.names, config);
}

/** Copies any of the user's versions into a new DRAFT (e.g. to restore a paused or superseded policy). */
export async function duplicateVersion(
  { db, config }: Deps,
  actor: Actor,
  id: string,
): Promise<PolicyVersionDto> {
  const source = await db.policyVersion.findFirst({ where: { id, userId: actor.userId } });
  if (!source) throw AppError.notFound('Policy version not found');
  const ctx = await merchantContext(db, actor.userId);
  const result = validatePolicyDocument(source.compiledRules, ctx.ids);
  if (!result.valid)
    throw new AppError(400, 'POLICY_INVALID', 'That version no longer validates', result.errors);
  const created = await createDraft(
    db,
    actor,
    {
      sourceText: source.sourceText,
      document: result.document,
      rulesHash: result.rulesHash,
      compilerModel: source.compilerModel,
      promptVersion: source.promptVersion,
      unmappedClauses: z.array(UnmappedClauseSchema).catch([]).parse(source.unmappedClauses),
      assumptions: z.array(z.string()).catch([]).parse(source.assumptions),
      editedManually: source.editedManually,
    },
    {
      action: 'policy.draft_duplicated',
      data: { fromPolicyVersionId: source.id, fromVersion: source.version },
    },
  );
  return toDto(created, ctx.names, config);
}

async function requirePassword(db: Database, actor: Actor, password: string, purpose: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (!(await verifyPassword(user.passwordHash, password))) {
    await recordAuditEvent(db, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: 'user.step_up_failed',
      data: { purpose, ...actor.meta },
    });
    throw new AppError(401, 'INVALID_PASSWORD', 'Password is incorrect');
  }
}

/**
 * Makes a draft the enforced policy. Requires the password (step-up), the
 * exact rulesHash the user reviewed, and acknowledgement of unmapped clauses.
 * Runs under the user's budget lock so no purchase is evaluated mid-switch.
 */
export async function confirmPolicy(
  { db, config }: Deps,
  actor: Actor,
  id: string,
  input: { rulesHash: string; acknowledgeUnmapped: boolean; password: string },
): Promise<PolicyVersionDto> {
  await requirePassword(db, actor, input.password, 'policy.confirm');
  const ctx = await merchantContext(db, actor.userId);

  let confirmed: PolicyVersion;
  try {
    confirmed = await db.$transaction(async (tx) => {
      await lockUserBudget(tx, actor.userId);
      const draft = await tx.policyVersion.findFirst({ where: { id, userId: actor.userId } });
      if (!draft) throw AppError.notFound('Policy version not found');
      if (draft.status !== 'DRAFT')
        throw AppError.conflict(`This version is ${draft.status.toLowerCase()}, not a draft`);
      if (draft.rulesHash !== input.rulesHash) {
        throw new AppError(
          409,
          'POLICY_CHANGED',
          'The draft changed since you reviewed it. Review it again before confirming.',
        );
      }
      const unmapped = z.array(UnmappedClauseSchema).catch([]).parse(draft.unmappedClauses);
      if (unmapped.length > 0 && !input.acknowledgeUnmapped) {
        throw new AppError(
          400,
          'UNMAPPED_NOT_ACKNOWLEDGED',
          'Acknowledge the rules Leash could not enforce before confirming',
        );
      }
      // Re-validate at the moment of confirmation, not just at compile time.
      const result = validatePolicyDocument(draft.compiledRules, ctx.ids);
      if (!result.valid || policyRulesHash(result.document) !== draft.rulesHash) {
        throw new AppError(
          400,
          'POLICY_INVALID',
          'This draft no longer validates',
          result.valid ? [] : result.errors,
        );
      }

      const previous = await tx.policyVersion.findFirst({
        where: { userId: actor.userId, status: 'ACTIVE' },
      });
      if (previous)
        await tx.policyVersion.update({
          where: { id: previous.id },
          data: { status: 'SUPERSEDED' },
        });
      const activated = await tx.policyVersion.update({
        where: { id },
        data: { status: 'ACTIVE', confirmedAt: new Date() },
      });
      await appendAuditEvent(tx, {
        actorType: 'USER',
        actorId: actor.userId,
        userId: actor.userId,
        action: 'policy.confirmed',
        data: {
          policyVersionId: id,
          version: activated.version,
          rulesHash: activated.rulesHash,
          rules: renderPolicy(result.document, { merchantNames: ctx.names }).map((r) => r.text),
          supersededPolicyVersionId: previous?.id ?? null,
          unmappedAcknowledged: unmapped.length > 0,
          ...actor.meta,
        },
      });
      return activated;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw AppError.conflict(
        'Another policy was confirmed at the same time; reload and try again',
      );
    throw err;
  }
  return toDto(confirmed, ctx.names, config);
}

export async function rejectDraft(
  { db, config }: Deps,
  actor: Actor,
  id: string,
): Promise<PolicyVersionDto> {
  const rejected = await db.$transaction(async (tx) => {
    const { count } = await tx.policyVersion.updateMany({
      where: { id, userId: actor.userId, status: 'DRAFT' },
      data: { status: 'REJECTED' },
    });
    if (count === 0) {
      const exists = await tx.policyVersion.findFirst({ where: { id, userId: actor.userId } });
      if (!exists) throw AppError.notFound('Policy version not found');
      throw AppError.conflict('Only drafts can be rejected');
    }
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: 'policy.draft_rejected',
      data: { policyVersionId: id, ...actor.meta },
    });
    return tx.policyVersion.findUniqueOrThrow({ where: { id } });
  });
  return toDto(rejected, (await merchantContext(db, actor.userId)).names, config);
}

/** Emergency stop: deactivates the active policy, so every purchase is blocked until a new one is confirmed. */
export async function pauseSpending({ db }: Deps, actor: Actor, password: string): Promise<void> {
  await requirePassword(db, actor, password, 'policy.pause');
  await db.$transaction(async (tx) => {
    await lockUserBudget(tx, actor.userId);
    const active = await tx.policyVersion.findFirst({
      where: { userId: actor.userId, status: 'ACTIVE' },
    });
    if (!active) throw AppError.conflict('No policy is active; spending is already paused');
    await tx.policyVersion.update({ where: { id: active.id }, data: { status: 'SUPERSEDED' } });
    await appendAuditEvent(tx, {
      actorType: 'USER',
      actorId: actor.userId,
      userId: actor.userId,
      action: 'policy.paused',
      data: { policyVersionId: active.id, version: active.version, ...actor.meta },
    });
  });
}

/** Dry run of the deterministic engine against real spend. Reserves nothing. */
export async function simulatePurchase(
  { db, config }: Deps,
  userId: string,
  input: {
    policyVersionId?: string | undefined;
    taskId: string;
    merchantId: string;
    amount: { currency: Currency; value: string };
    at?: string | undefined;
  },
): Promise<SimulationResponse> {
  let amountMinor: number;
  try {
    amountMinor = parseDecimalToMinor(input.amount.value, input.amount.currency);
  } catch (err) {
    if (err instanceof MoneyParseError) throw AppError.badRequest(err.message);
    throw err;
  }
  const at = input.at ? new Date(input.at) : new Date();

  const version = input.policyVersionId
    ? await db.policyVersion.findFirst({ where: { id: input.policyVersionId, userId } })
    : await db.policyVersion.findFirst({ where: { userId, status: 'ACTIVE' } });
  if (input.policyVersionId && !version) throw AppError.notFound('Policy version not found');
  const document = version ? PolicyDocumentSchema.parse(version.compiledRules) : null;

  const task = await db.task.findFirst({ where: { id: input.taskId, userId } });
  if (!task) throw AppError.notFound('Task not found');
  const merchant = await db.merchant.findFirst({ where: { id: input.merchantId, userId } });
  if (!merchant) throw AppError.notFound('Merchant not found');

  const [committed, spend] = await Promise.all([
    committedByTask(db, [task.id]),
    loadSpendSnapshot(db, {
      userId,
      policy: document,
      currency: input.amount.currency,
      merchantId: merchant.id,
      amountMinor,
      at,
    }),
  ]);
  const evaluation = evaluatePolicy(
    document,
    {
      amountMinor,
      currency: input.amount.currency,
      merchantId: merchant.id,
      merchantCategory: merchant.category as MerchantCategory,
      merchantArchived: merchant.archivedAt !== null,
      at,
    },
    {
      status: effectiveTaskStatus(task, at),
      currency: task.currency as Currency,
      budgetMinor: task.budgetMinor,
      committedMinor: committed.get(task.id) ?? 0,
      allowedMerchantIds: task.allowedMerchantIds,
    },
    spend,
    { sandboxMaxTransactionMinor: config.limits.sandboxMaxTransactionMinor },
  );
  return {
    ...evaluation,
    note: 'Dry run of the deterministic policy layer only: nothing was reserved. Real purchases are also checked by the AI layers, which can only make a decision stricter.',
  };
}

export async function budgetStatus(
  { db }: Deps,
  userId: string,
  now = new Date(),
): Promise<BudgetStatusResponse> {
  const active = await db.policyVersion.findFirst({ where: { userId, status: 'ACTIVE' } });
  const document = active ? PolicyDocumentSchema.parse(active.compiledRules) : null;
  const timezone = document?.timezone ?? 'UTC';
  const currency = document?.currency ?? 'USD';
  const spend = await periodSpend(db, userId, currency, timezone, now);

  return {
    hasActivePolicy: document !== null,
    timezone: document ? timezone : null,
    periods: PERIODS.map((period) => {
      const bounds = periodBounds(now, period, timezone);
      const limits = (document?.rules ?? []).filter(
        (r): r is Extract<PolicyDocument['rules'][number], { type: 'max_spend_per_period' }> =>
          r.type === 'max_spend_per_period' && r.period === period,
      );
      const tightest = limits.sort((a, b) => a.amountMinor - b.amountMinor)[0] ?? null;
      const committed = spend[period].committedMinor;
      return {
        period,
        periodStart: bounds.start.toISOString(),
        periodEnd: bounds.end.toISOString(),
        currency,
        committedMinor: committed,
        transactionCount: spend[period].transactionCount,
        limitMinor: tightest?.amountMinor ?? null,
        limitAction: tightest?.action ?? null,
        remainingMinor: tightest ? Math.max(0, tightest.amountMinor - committed) : null,
      };
    }),
  };
}
