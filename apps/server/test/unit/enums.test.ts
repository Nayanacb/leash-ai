import * as shared from '@leash/shared';
import { describe, expect, it } from 'vitest';
import * as prismaEnums from '../../src/generated/prisma/enums.js';

/** Every Prisma enum must match the shared Zod enum of the same name, value for value. */
const pairs = [
  ['Decision', shared.DecisionSchema],
  ['TransactionStatus', shared.TransactionStatusSchema],
  ['EvaluationLayer', shared.EvaluationLayerSchema],
  ['Verdict', shared.VerdictSchema],
  ['ApprovalStatus', shared.ApprovalStatusSchema],
  ['PolicyVersionStatus', shared.PolicyVersionStatusSchema],
  ['LedgerEntryType', shared.LedgerEntryTypeSchema],
  ['ActorType', shared.ActorTypeSchema],
  ['AgentStatus', shared.AgentStatusSchema],
  ['TaskStatus', shared.TaskStatusSchema],
  ['RefundStatus', shared.RefundStatusSchema],
] as const;

describe('Prisma enums mirror shared enums', () => {
  it.each(pairs)('%s', (name, schema) => {
    const prismaEnum = (prismaEnums as Record<string, Record<string, string>>)[name];
    expect(prismaEnum, `Prisma enum ${name} missing`).toBeDefined();
    expect(Object.values(prismaEnum!).sort()).toEqual([...schema.options].sort());
  });
});
