import {
  SourceContextItemSchema,
  type Currency,
  type TransactionDetailDto,
  type TransactionSummaryDto,
} from '@leash/shared';
import { z } from 'zod';
import type { Database } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';

const summaryInclude = {
  agent: { select: { id: true, name: true } },
  merchant: { select: { id: true, displayName: true } },
} as const;

type SummaryRow = Prisma.TransactionGetPayload<{ include: typeof summaryInclude }>;

function toSummary(t: SummaryRow): TransactionSummaryDto {
  return {
    id: t.id,
    status: t.status,
    decision: t.decision,
    amountMinor: t.amountMinor,
    currency: t.currency as Currency,
    itemDescription: t.itemDescription,
    agent: t.agent,
    merchant: t.merchant,
    taskId: t.taskId,
    reasonCodes: t.reasonCodes,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function listTransactions(
  db: Database,
  userId: string,
  query: {
    status?: string | undefined;
    decision?: string | undefined;
    agentId?: string | undefined;
    before?: string | undefined;
    limit: number;
  },
): Promise<{ transactions: TransactionSummaryDto[]; nextBefore: string | null }> {
  const rows = await db.transaction.findMany({
    where: {
      userId,
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.decision ? { decision: query.decision as never } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    include: summaryInclude,
  });
  const page = rows.slice(0, query.limit);
  return {
    transactions: page.map(toSummary),
    nextBefore: rows.length > query.limit ? page[page.length - 1]!.createdAt.toISOString() : null,
  };
}

const StoredContextSchema = z
  .object({ sourceContext: z.array(SourceContextItemSchema) })
  .catch({ sourceContext: [] });

export async function getTransaction(
  db: Database,
  userId: string,
  id: string,
): Promise<TransactionDetailDto> {
  const t = await db.transaction.findFirst({
    where: { id, userId },
    include: {
      ...summaryInclude,
      task: { select: { id: true, instruction: true, budgetMinor: true, currency: true } },
      policyVersion: { select: { version: true } },
      evaluations: { orderBy: { createdAt: 'asc' } },
      approval: true,
      ledgerEntries: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!t) throw AppError.notFound('Transaction not found');
  const [merchant, audit] = await Promise.all([
    t.merchantId
      ? db.merchant.findFirst({
          where: { id: t.merchantId, userId },
          select: {
            id: true,
            displayName: true,
            paypalEmail: true,
            category: true,
            archivedAt: true,
          },
        })
      : null,
    db.auditEvent.findMany({ where: { transactionId: t.id, userId }, orderBy: { seq: 'asc' } }),
  ]);
  const held = t.ledgerEntries.reduce(
    (sum, l) => sum + (l.type === 'RESERVE' ? l.amountMinor : -l.amountMinor),
    0,
  );

  return {
    ...toSummary(t),
    quantity: t.quantity,
    category: t.category,
    agentJustification: t.agentJustification,
    sourceContext: StoredContextSchema.parse(t.untrustedContext).sourceContext,
    task: { ...t.task, currency: t.task.currency as Currency },
    merchantDetail: merchant
      ? {
          id: merchant.id,
          displayName: merchant.displayName,
          paypalEmail: merchant.paypalEmail,
          category: merchant.category,
          archived: merchant.archivedAt !== null,
        }
      : null,
    policyVersion: t.policyVersion?.version ?? null,
    evaluations: t.evaluations.map((e) => ({
      layer: e.layer,
      verdict: e.verdict,
      confidence: e.confidence,
      details: e.details,
      model: e.model,
      promptVersion: e.promptVersion,
      latencyMs: e.latencyMs,
      error: e.error,
      createdAt: e.createdAt.toISOString(),
    })),
    approval: t.approval
      ? {
          id: t.approval.id,
          note: t.approval.note,
          snapshotHash: t.approval.snapshotHash,
          status: t.approval.status,
          requestedAt: t.approval.requestedAt.toISOString(),
          expiresAt: t.approval.expiresAt.toISOString(),
          decidedAt: t.approval.decidedAt?.toISOString() ?? null,
        }
      : null,
    authorizedAt: t.authorizedAt?.toISOString() ?? null,
    authorizationExpiresAt: t.authorizationExpiresAt?.toISOString() ?? null,
    ledger: t.ledgerEntries.map((l) => ({
      type: l.type,
      amountMinor: l.amountMinor,
      createdAt: l.createdAt.toISOString(),
    })),
    heldMinor: Math.max(0, held),
    audit: audit.map((a) => ({
      action: a.action,
      actorType: a.actorType,
      createdAt: a.createdAt.toISOString(),
      data: (a.data ?? {}) as Record<string, unknown>,
    })),
    updatedAt: t.updatedAt.toISOString(),
  };
}
