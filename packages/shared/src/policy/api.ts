import { z } from 'zod';
import { PolicyVersionStatusSchema } from '../enums.js';
import { CurrencySchema, MoneyInputSchema } from '../money.js';
import { IsoDateTimeSchema, plainText } from '../schemas/common.js';
import {
  PeriodSchema,
  PolicyDocumentSchema,
  RuleActionSchema,
  TimeZoneSchema,
  UnmappedClauseSchema,
} from './dsl.js';

export const MAX_POLICY_SOURCE_LENGTH = 4000;

export const CompilePolicyInputSchema = z.object({
  sourceText: plainText(1, MAX_POLICY_SOURCE_LENGTH),
  /** Defaults for the compiler when the text doesn't say. The dashboard sends the browser's time zone. */
  timezone: TimeZoneSchema.default('UTC'),
  currency: CurrencySchema.default('USD'),
});

export const ValidatePolicyInputSchema = z.object({ compiledRules: z.unknown() });

export const PolicyValidationResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
  rendered: z.array(z.object({ id: z.string(), action: RuleActionSchema, text: z.string() })),
  rulesHash: z.string().nullable(),
});
export type PolicyValidationResponse = z.infer<typeof PolicyValidationResponseSchema>;

/** Replace a draft's rules with hand-edited JSON. Validated exactly like compiler output. */
export const UpdateDraftInputSchema = z.object({
  compiledRules: z.unknown(),
});

export const ConfirmPolicyInputSchema = z.object({
  /** The hash of the rules the user reviewed: confirmation fails if the draft changed since. */
  rulesHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Required when the compiler reported clauses it could not express. */
  acknowledgeUnmapped: z.boolean().default(false),
  /** Step-up re-authentication. */
  password: z.string().min(1).max(256),
});

export const PausePolicyInputSchema = z.object({ password: z.string().min(1).max(256) });

export const RenderedRuleSchema = z.object({
  id: z.string(),
  action: RuleActionSchema,
  text: z.string(),
});

export const PolicyVersionDtoSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  status: PolicyVersionStatusSchema,
  sourceText: z.string(),
  compiledRules: PolicyDocumentSchema,
  rulesHash: z.string(),
  /** Deterministic rendering of compiledRules. */
  rendered: z.array(RenderedRuleSchema),
  builtInRules: z.array(z.string()),
  unmappedClauses: z.array(UnmappedClauseSchema),
  assumptions: z.array(z.string()),
  compilerModel: z.string(),
  promptVersion: z.string(),
  editedManually: z.boolean(),
  confirmedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PolicyVersionDto = z.infer<typeof PolicyVersionDtoSchema>;

export const PolicyVersionListResponseSchema = z.object({
  versions: z.array(PolicyVersionDtoSchema),
});
export const ActivePolicyResponseSchema = z.object({ policy: PolicyVersionDtoSchema.nullable() });

export const PolicyValidationErrorSchema = z.object({ path: z.string(), message: z.string() });

export const SimulatePurchaseInputSchema = z.object({
  /** Defaults to the active policy. */
  policyVersionId: z.uuid().optional(),
  taskId: z.uuid(),
  merchantId: z.uuid(),
  amount: MoneyInputSchema,
  /** Defaults to now. */
  at: IsoDateTimeSchema.optional(),
});

export const RuleResultSchema = z.object({
  ruleId: z.string(),
  ruleType: z.string(),
  builtIn: z.boolean(),
  matched: z.boolean(),
  action: RuleActionSchema,
  reasonCode: z.string(),
  detail: z.string(),
});
export type RuleResultDto = z.infer<typeof RuleResultSchema>;

export const SimulationResponseSchema = z.object({
  decision: z.enum(['ALLOW', 'ESCALATE', 'BLOCK']),
  reasonCodes: z.array(z.string()),
  results: z.array(RuleResultSchema),
  note: z.string(),
});
export type SimulationResponse = z.infer<typeof SimulationResponseSchema>;

export const BudgetPeriodStatusSchema = z.object({
  period: PeriodSchema,
  periodStart: z.string(),
  periodEnd: z.string(),
  currency: CurrencySchema,
  committedMinor: z.number().int(),
  transactionCount: z.number().int(),
  /** The tightest spend limit for this period in the active policy, if any. */
  limitMinor: z.number().int().nullable(),
  limitAction: RuleActionSchema.nullable(),
  remainingMinor: z.number().int().nullable(),
});
export type BudgetPeriodStatus = z.infer<typeof BudgetPeriodStatusSchema>;

export const BudgetStatusResponseSchema = z.object({
  hasActivePolicy: z.boolean(),
  timezone: z.string().nullable(),
  periods: z.array(BudgetPeriodStatusSchema),
});
export type BudgetStatusResponse = z.infer<typeof BudgetStatusResponseSchema>;
