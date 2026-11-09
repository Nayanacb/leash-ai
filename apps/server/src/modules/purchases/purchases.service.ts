import {
  formatMinorAsDecimal,
  MoneyParseError,
  parseDecimalToMinor,
  type Currency,
  type PurchaseRequestInput,
  type PurchaseRequestResponse,
} from '@leash/shared';
import type { AppConfig } from '../../config/env.js';
import { AI_DEADLINE_GRACE_MS } from '../../config/env.js';
import type { Database } from '../../db.js';
import type {
  Approval,
  Prisma,
  Transaction,
  TransactionStatus,
} from '../../generated/prisma/client.js';
import { sha256Hex } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { appendAuditEvent } from '../audit/auditLog.js';
import { canonicalJson } from '../audit/canonicalJson.js';
import { combineDecision, type CombinedDecision } from '../authorization/combiner.js';
import type { PolicyEvaluation } from '../authorization/policyEngine.js';
import { lockUserBudget, releaseWithinTransaction, reserveForPurchase } from '../budget/ledger.js';
import type { PurchaseEvaluators, PurchaseForEvaluation } from '../evaluation/evaluators.js';
import { runAiEvaluation, type AiEvaluationResult } from '../evaluation/pipeline.js';
import { agentReasonCodes } from './reasons.js';

export interface PurchaseDeps {
  db: Database;
  config: AppConfig;
  logger: Logger;
  evaluators: PurchaseEvaluators | null;
}

type TxWithApproval = Transaction & { approval: Approval | null };

/** Removes NUL characters (Postgres can't store them) from every string, recursively. */
function stripNul<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('\u0000', '') as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripNul(v)])) as T;
  }
  return value;
}

export function toAgentResponse(tx: TxWithApproval): PurchaseRequestResponse {
  return {
    id: tx.id,
    status: tx.status,
    decision: tx.decision,
    reasonCodes: agentReasonCodes(tx.reasonCodes, tx.decision, tx.status),
    amount: {
      currency: tx.currency as Currency,
      value: formatMinorAsDecimal(tx.amountMinor, tx.currency as Currency),
    },
    approvalExpiresAt:
      tx.status === 'PENDING_APPROVAL' ? (tx.approval?.expiresAt.toISOString() ?? null) : null,
    authorizationExpiresAt:
      tx.status === 'AUTHORIZED' ? (tx.authorizationExpiresAt?.toISOString() ?? null) : null,
    createdAt: tx.createdAt.toISOString(),
  };
}

export interface SubmitResult {
  httpStatus: 200 | 201 | 202;
  body: PurchaseRequestResponse;
}

async function currentState(db: Database, transactionId: string): Promise<TxWithApproval> {
  return db.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    include: { approval: true },
  });
}

/**
 * Agent purchase request: deterministic policy + reservation, then the AI
 * layers WITHOUT holding any lock, then the final decision under the lock.
 *
 * Idempotent: the same agent + Idempotency-Key + body always maps to the same
 * transaction (and the same outcome); a different body is rejected (409). A
 * retry that arrives while the original is still being evaluated gets 202
 * with status EVALUATING and never triggers a second evaluation.
 */
export async function submitPurchaseRequest(
  deps: PurchaseDeps,
  agent: { agentId: string; userId: string },
  idempotencyKey: string,
  rawInput: PurchaseRequestInput,
): Promise<SubmitResult> {
  const { db, config } = deps;
  const input = stripNul(rawInput);

  let amountMinor: number;
  try {
    amountMinor = parseDecimalToMinor(input.amount.value, input.amount.currency);
  } catch (err) {
    if (err instanceof MoneyParseError) throw new AppError(400, 'VALIDATION_ERROR', err.message);
    throw err;
  }
  if (amountMinor <= 0)
    throw new AppError(400, 'VALIDATION_ERROR', 'Amount must be greater than zero');

  // 1. Deterministic policy + reservation, atomically under the budget lock.
  const reservation = await reserveForPurchase(
    db,
    {
      userId: agent.userId,
      agentId: agent.agentId,
      taskId: input.taskId,
      merchantId: input.merchantId,
      idempotencyKey,
      requestHash: sha256Hex(canonicalJson(rawInput)),
      amountMinor,
      currency: input.amount.currency,
      itemDescription: input.item.description,
      quantity: input.item.quantity,
      category: input.item.category ?? null,
      agentJustification: input.justification ?? null,
      untrustedContext: { sourceContext: input.sourceContext } as unknown as Prisma.InputJsonObject,
    },
    { sandboxMaxTransactionMinor: config.limits.sandboxMaxTransactionMinor },
  );

  if (reservation.replayed) {
    const tx = await currentState(db, reservation.transactionId);
    return { httpStatus: tx.status === 'EVALUATING' ? 202 : 200, body: toAgentResponse(tx) };
  }
  if (reservation.policyDecision === 'BLOCK') {
    // Final already; nothing reserved, no AI calls made.
    return {
      httpStatus: 201,
      body: toAgentResponse(await currentState(db, reservation.transactionId)),
    };
  }

  // 2. Advisory AI layers. No database lock is held here.
  const [task, merchant] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: input.taskId }, select: { instruction: true } }),
    db.merchant.findUniqueOrThrow({
      where: { id: input.merchantId },
      select: { displayName: true, category: true, paypalEmail: true },
    }),
  ]);
  const forEvaluation: PurchaseForEvaluation = {
    taskInstruction: task.instruction,
    merchant: { displayName: merchant.displayName, category: merchant.category },
    amount: { currency: input.amount.currency, value: input.amount.value },
    item: input.item,
    justification: input.justification,
    sourceContext: input.sourceContext,
  };
  let ai: AiEvaluationResult | null = null;
  try {
    ai = await runAiEvaluation(deps.evaluators, forEvaluation, {
      deadlineMs: config.llm.classifierTimeoutMs + AI_DEADLINE_GRACE_MS,
    });
  } catch (err) {
    // runAiEvaluation never throws by design; if it somehow does, fail closed.
    deps.logger.error(
      { err, transactionId: reservation.transactionId },
      'AI evaluation failed unexpectedly',
    );
  }

  // 3. Deterministic combination; AI can only make it stricter.
  const combined = combineDecision(reservation.evaluation, ai?.signals);

  // 4. Finalize under the lock, only if still EVALUATING.
  await finalizeEvaluation(deps, {
    userId: agent.userId,
    transactionId: reservation.transactionId,
    policy: reservation.evaluation,
    combined,
    ai,
    snapshot: {
      amountMinor,
      currency: input.amount.currency,
      merchantId: input.merchantId,
      payee: merchant.paypalEmail,
      itemDescription: input.item.description,
      quantity: input.item.quantity,
      taskId: input.taskId,
      taskInstruction: task.instruction,
    },
  });

  const tx = await currentState(db, reservation.transactionId);
  return { httpStatus: 201, body: toAgentResponse(tx) };
}

/**
 * Applies the final decision. Returns false (and changes nothing) if the
 * purchase already left EVALUATING — e.g. the sweep expired it, or it was
 * cancelled while the AI layers ran.
 */
async function finalizeEvaluation(
  { db, config }: PurchaseDeps,
  input: {
    userId: string;
    transactionId: string;
    policy: PolicyEvaluation;
    combined: CombinedDecision;
    ai: AiEvaluationResult | null;
    snapshot: Record<string, unknown>;
  },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await lockUserBudget(tx, input.userId);
    const now = new Date();
    const { decision, reasonCodes } = input.combined;
    const status: TransactionStatus =
      decision === 'BLOCK'
        ? 'BLOCKED'
        : decision === 'ESCALATE'
          ? 'PENDING_APPROVAL'
          : 'AUTHORIZED';
    // What a human approver will be shown (Phase 6 binds approval to this hash).
    const snapshotHash =
      decision === 'ESCALATE'
        ? sha256Hex(
            canonicalJson({
              transactionId: input.transactionId,
              ...input.snapshot,
              decision,
              reasonCodes,
            }),
          )
        : null;
    const authorizationExpiresAt =
      decision === 'ALLOW'
        ? new Date(now.getTime() + config.limits.authorizationTtlMinutes * 60_000)
        : null;

    const { count } = await tx.transaction.updateMany({
      where: { id: input.transactionId, status: 'EVALUATING' },
      data: {
        status,
        decision,
        reasonCodes,
        snapshotHash,
        ...(decision === 'ALLOW' ? { authorizedAt: now, authorizationExpiresAt } : {}),
        version: { increment: 1 },
      },
    });
    if (count === 0) return false;

    if (input.ai) {
      await tx.evaluation.createMany({
        data: input.ai.records.map((r) => ({
          transactionId: input.transactionId,
          layer: r.layer,
          verdict: r.verdict,
          confidence: r.confidence,
          details: r.details as Prisma.InputJsonObject,
          model: r.model,
          promptVersion: r.promptVersion,
          latencyMs: r.latencyMs,
          error: r.error,
        })),
      });
    }

    let approvalExpiresAt: Date | null = null;
    if (decision === 'ESCALATE') {
      approvalExpiresAt = new Date(now.getTime() + config.limits.approvalTtlMinutes * 60_000);
      await tx.approval.create({
        data: {
          transactionId: input.transactionId,
          snapshotHash: snapshotHash!,
          expiresAt: approvalExpiresAt,
        },
      });
    }
    if (decision === 'BLOCK') {
      await releaseWithinTransaction(tx, {
        userId: input.userId,
        transactionId: input.transactionId,
        reason: 'blocked',
        actor: { type: 'SYSTEM', id: null },
      });
    }

    await appendAuditEvent(tx, {
      actorType: 'SYSTEM',
      actorId: null,
      userId: input.userId,
      transactionId: input.transactionId,
      action: 'purchase.decided',
      data: {
        decision,
        status,
        reasonCodes,
        policyDecision: input.policy.decision,
        layers: input.ai
          ? Object.fromEntries(input.ai.records.map((r) => [r.layer.toLowerCase(), r.verdict]))
          : { injection: 'ERROR', intent: 'ERROR' },
        approvalExpiresAt,
        authorizationExpiresAt,
      },
    });
    return true;
  });
}

const CANCELLABLE: TransactionStatus[] = ['EVALUATING', 'PENDING_APPROVAL', 'AUTHORIZED'];

/**
 * Cancels a purchase that hasn't been paid and releases its funds. Idempotent:
 * cancelling an already-cancelled purchase returns it unchanged.
 */
export async function cancelPurchase(
  db: Database,
  input: {
    userId: string;
    transactionId: string;
    agentId?: string;
    actor: { type: 'USER' | 'AGENT'; id: string };
  },
): Promise<TxWithApproval> {
  await db.$transaction(async (tx) => {
    await lockUserBudget(tx, input.userId);
    const current = await tx.transaction.findFirst({
      where: {
        id: input.transactionId,
        userId: input.userId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      },
    });
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Purchase not found');
    if (current.status === 'CANCELLED') return;
    if (!CANCELLABLE.includes(current.status)) {
      throw new AppError(
        409,
        'PURCHASE_NOT_CANCELLABLE',
        `A ${current.status.toLowerCase().replaceAll('_', ' ')} purchase cannot be cancelled`,
      );
    }

    const { count } = await tx.transaction.updateMany({
      where: { id: current.id, status: current.status },
      data: { status: 'CANCELLED', reasonCodes: { push: 'CANCELLED' }, version: { increment: 1 } },
    });
    if (count === 0) throw AppError.conflict('The purchase changed at the same time; try again');

    await tx.approval.updateMany({
      where: { transactionId: current.id, status: 'PENDING' },
      data: {
        status: 'CANCELLED',
        decidedAt: new Date(),
        ...(input.actor.type === 'USER' ? { decidedByUserId: input.actor.id } : {}),
      },
    });
    await releaseWithinTransaction(tx, {
      userId: input.userId,
      transactionId: current.id,
      reason: 'cancelled',
      actor: { type: input.actor.type, id: input.actor.id },
    });
    await appendAuditEvent(tx, {
      actorType: input.actor.type,
      actorId: input.actor.id,
      userId: input.userId,
      transactionId: current.id,
      action: 'purchase.cancelled',
      data: { fromStatus: current.status },
    });
  });
  return currentState(db, input.transactionId);
}

export async function getPurchaseForAgent(
  db: Database,
  agent: { agentId: string; userId: string },
  id: string,
) {
  const tx = await db.transaction.findFirst({
    where: { id, agentId: agent.agentId, userId: agent.userId },
    include: { approval: true },
  });
  if (!tx) throw new AppError(404, 'NOT_FOUND', 'Purchase not found');
  return toAgentResponse(tx);
}
