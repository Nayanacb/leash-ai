import { z } from 'zod';

/**
 * Canonical enums. The Prisma schema mirrors these exactly; a server test
 * asserts they stay in sync.
 */

export const DecisionSchema = z.enum(['ALLOW', 'ESCALATE', 'BLOCK']);
export type Decision = z.infer<typeof DecisionSchema>;

export const TransactionStatusSchema = z.enum([
  'EVALUATING',
  'BLOCKED',
  'PENDING_APPROVAL',
  'REJECTED',
  'EXPIRED',
  'AUTHORIZED',
  'ORDER_CREATED',
  'BUYER_APPROVED',
  'CAPTURING',
  'CAPTURED',
  'PAYMENT_FAILED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REVERSED',
  'CANCELLED',
]);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

export const EvaluationLayerSchema = z.enum(['POLICY', 'INJECTION', 'INTENT']);
export type EvaluationLayer = z.infer<typeof EvaluationLayerSchema>;

export const VerdictSchema = z.enum(['PASS', 'ESCALATE', 'BLOCK', 'ERROR']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ApprovalStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const PolicyVersionStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'SUPERSEDED', 'REJECTED']);
export type PolicyVersionStatus = z.infer<typeof PolicyVersionStatusSchema>;

export const LedgerEntryTypeSchema = z.enum(['RESERVE', 'RELEASE', 'REFUND']);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;

export const ActorTypeSchema = z.enum(['USER', 'AGENT', 'SYSTEM', 'PAYPAL', 'LLM']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const AgentStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const TaskStatusSchema = z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const RefundStatusSchema = z.enum(['PENDING', 'COMPLETED', 'FAILED']);
export type RefundStatus = z.infer<typeof RefundStatusSchema>;
