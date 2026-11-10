import { z } from 'zod';
import {
  ApprovalStatusSchema,
  DecisionSchema,
  EvaluationLayerSchema,
  TransactionStatusSchema,
  VerdictSchema,
} from '../enums.js';
import { CurrencySchema, MoneyInputSchema } from '../money.js';

/**
 * Purchase requests submitted by agents. EVERYTHING in a request other than
 * the IDs is untrusted, agent-supplied text: it is validated for shape and
 * size only, never interpreted as instructions, and rendered as plain text.
 */

export const SOURCE_CONTEXT_MAX_ITEMS = 10;
export const SOURCE_CONTEXT_MAX_ITEM_CHARS = 20_000;
/** Combined cap across all source-context items (content + title + url). */
export const SOURCE_CONTEXT_MAX_TOTAL_CHARS = 60_000;
/** Actual HTTP body limit for purchase-request routes. */
export const PURCHASE_REQUEST_MAX_BODY_BYTES = 256 * 1024;

export const SourceContextKindSchema = z.enum(['web_page', 'email', 'document', 'chat', 'other']);

/** A URL the agent says it read. Never fetched by Leash; stored and shown as text. */
const UntrustedUrlSchema = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

export const SourceContextItemSchema = z.strictObject({
  kind: SourceContextKindSchema,
  url: UntrustedUrlSchema.optional(),
  title: z.string().max(300).optional(),
  content: z.string().max(SOURCE_CONTEXT_MAX_ITEM_CHARS),
});
export type SourceContextItem = z.infer<typeof SourceContextItemSchema>;

export const PurchaseRequestInputSchema = z
  .strictObject({
    taskId: z.uuid(),
    merchantId: z.uuid(),
    amount: MoneyInputSchema,
    item: z.strictObject({
      description: z.string().trim().min(1).max(500),
      quantity: z.number().int().min(1).max(1000),
      category: z.string().trim().max(64).optional(),
    }),
    justification: z.string().max(2000).optional(),
    sourceContext: z.array(SourceContextItemSchema).max(SOURCE_CONTEXT_MAX_ITEMS).default([]),
  })
  .superRefine((input, ctx) => {
    const total = input.sourceContext.reduce(
      (sum, item) =>
        sum + item.content.length + (item.title?.length ?? 0) + (item.url?.length ?? 0),
      0,
    );
    if (total > SOURCE_CONTEXT_MAX_TOTAL_CHARS) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceContext'],
        message: `source context totals ${total} characters; the limit is ${SOURCE_CONTEXT_MAX_TOTAL_CHARS}`,
      });
    }
  });
export type PurchaseRequestInput = z.infer<typeof PurchaseRequestInputSchema>;

/** Idempotency keys: 8–128 URL-safe characters (a UUID is ideal). */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_\-:.]{8,128}$/, 'Idempotency-Key must be 8–128 URL-safe characters');

/**
 * Coarse reasons shown to agents. They say what kind of outcome happened, not
 * which threshold or detector fired, so an agent can't tune its requests to
 * slip under a limit or past a detector.
 */
export const AgentReasonCodeSchema = z.enum([
  'SPENDING_PAUSED',
  'LIMIT_EXCEEDED',
  'CURRENCY_NOT_ALLOWED',
  'TASK_NOT_ACTIVE',
  'MERCHANT_NOT_ALLOWED',
  'POLICY_RULE',
  'REQUIRES_APPROVAL',
  'NOT_PERMITTED',
  'EVALUATION_TIMEOUT',
  'APPROVAL_EXPIRED',
  'AUTHORIZATION_EXPIRED',
  'CANCELLED',
  'APPROVED',
  'REJECTED',
  'PAID',
  'PAYMENT_FAILED',
]);
export type AgentReasonCode = z.infer<typeof AgentReasonCodeSchema>;

export const PurchaseRequestResponseSchema = z.object({
  id: z.uuid(),
  status: TransactionStatusSchema,
  /** Null while the purchase is still being evaluated. */
  decision: DecisionSchema.nullable(),
  reasonCodes: z.array(AgentReasonCodeSchema),
  amount: z.object({ currency: CurrencySchema, value: z.string() }),
  approvalExpiresAt: z.string().nullable(),
  authorizationExpiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PurchaseRequestResponse = z.infer<typeof PurchaseRequestResponseSchema>;

// ── Dashboard (user API) ────────────────────────────────────────────────────

export const TransactionListQuerySchema = z.object({
  status: TransactionStatusSchema.optional(),
  decision: DecisionSchema.optional(),
  agentId: z.uuid().optional(),
  /** Cursor: ISO timestamp; returns transactions created before it. */
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const TransactionSummaryDtoSchema = z.object({
  id: z.uuid(),
  status: TransactionStatusSchema,
  decision: DecisionSchema.nullable(),
  amountMinor: z.number().int(),
  currency: CurrencySchema,
  itemDescription: z.string(),
  agent: z.object({ id: z.uuid(), name: z.string() }),
  merchant: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  taskId: z.uuid(),
  reasonCodes: z.array(z.string()),
  createdAt: z.string(),
});
export type TransactionSummaryDto = z.infer<typeof TransactionSummaryDtoSchema>;

export const TransactionListResponseSchema = z.object({
  transactions: z.array(TransactionSummaryDtoSchema),
  nextBefore: z.string().nullable(),
});

export const EvaluationDtoSchema = z.object({
  layer: EvaluationLayerSchema,
  verdict: VerdictSchema,
  confidence: z.number().nullable(),
  details: z.unknown(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

export const TransactionDetailDtoSchema = TransactionSummaryDtoSchema.extend({
  quantity: z.number().int(),
  category: z.string().nullable(),
  /** Untrusted, agent-written. */
  agentJustification: z.string().nullable(),
  /** Untrusted, agent-supplied. */
  sourceContext: z.array(SourceContextItemSchema),
  task: z.object({
    id: z.uuid(),
    instruction: z.string(),
    budgetMinor: z.number().int(),
    currency: CurrencySchema,
  }),
  merchantDetail: z
    .object({
      id: z.uuid(),
      displayName: z.string(),
      paypalEmail: z.string(),
      category: z.string(),
      archived: z.boolean(),
    })
    .nullable(),
  policyVersion: z.number().int().nullable(),
  evaluations: z.array(EvaluationDtoSchema),
  approval: z
    .object({
      id: z.uuid(),
      status: ApprovalStatusSchema,
      requestedAt: z.string(),
      expiresAt: z.string(),
      decidedAt: z.string().nullable(),
      note: z.string().nullable(),
      /** What the approver must confirm against (approve-what-you-saw). */
      snapshotHash: z.string(),
    })
    .nullable(),
  authorizedAt: z.string().nullable(),
  authorizationExpiresAt: z.string().nullable(),
  ledger: z.array(
    z.object({ type: z.string(), amountMinor: z.number().int(), createdAt: z.string() }),
  ),
  heldMinor: z.number().int(),
  /** PayPal checkout state. Never includes the buyer-approval link or credentials. */
  payment: z.object({
    payee: z.string().nullable(),
    paypalOrderId: z.string().nullable(),
    orderCreatedAt: z.string().nullable(),
    paypalCaptureId: z.string().nullable(),
    capturedMinor: z.number().int().nullable(),
    capturedAt: z.string().nullable(),
    failureReason: z.string().nullable(),
  }),
  audit: z.array(
    z.object({
      action: z.string(),
      actorType: z.string(),
      createdAt: z.string(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  updatedAt: z.string(),
});
export type TransactionDetailDto = z.infer<typeof TransactionDetailDtoSchema>;

// ── Approvals (user API) ───────────────────────────────────────────────────

export const ApprovalListQuerySchema = z.object({
  status: ApprovalStatusSchema.default('PENDING'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ApprovalDtoSchema = z.object({
  id: z.uuid(),
  status: ApprovalStatusSchema,
  requestedAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  note: z.string().nullable(),
  snapshotHash: z.string(),
  /** Who would be paid: the merchant's PayPal account (from the registry). */
  payee: z.string().nullable(),
  transaction: TransactionSummaryDtoSchema,
});
export type ApprovalDto = z.infer<typeof ApprovalDtoSchema>;

export const ApprovalListResponseSchema = z.object({
  approvals: z.array(ApprovalDtoSchema),
  /** Count of approvals still waiting (for the navigation badge). */
  pendingCount: z.number().int().nonnegative(),
});

const ApprovalNoteSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v ? v : undefined));

export const ApproveInputSchema = z.object({
  /** The snapshot hash shown on screen; approval fails if the purchase changed since. */
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  note: ApprovalNoteSchema,
});

export const RejectInputSchema = z.object({ note: ApprovalNoteSchema });

// ── Payments (user API) ────────────────────────────────────────────────────

/**
 * Starting checkout either sends the user to PayPal to approve the order, or
 * (if they already approved it) straight to completing it.
 */
export const CheckoutStartResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('REDIRECT'), approveUrl: z.url() }),
  z.object({ status: z.literal('APPROVED') }),
]);
export type CheckoutStartResponse = z.infer<typeof CheckoutStartResponseSchema>;
