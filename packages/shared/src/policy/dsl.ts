import { z } from 'zod';
import { CurrencySchema, MAX_AMOUNT_MINOR } from '../money.js';
import { MerchantCategorySchema } from '../schemas/merchants.js';

/**
 * Leash Policy DSL, version 1.
 *
 * A policy is a list of rules. Each rule describes a condition that, when it
 * matches a purchase, triggers an action: BLOCK (refuse) or ESCALATE (ask the
 * user). A purchase that matches no rule is allowed by the policy layer.
 *
 * This schema is the contract between the (untrusted) LLM compiler and the
 * deterministic engine: anything that does not validate here never reaches
 * the engine.
 */

export const POLICY_DSL_VERSION = 1;
export const MAX_RULES = 50;

export const RuleActionSchema = z.enum(['BLOCK', 'ESCALATE']);
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const PeriodSchema = z.enum(['day', 'week', 'month']);
export type Period = z.infer<typeof PeriodSchema>;

const RuleIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'rule ids are short lowercase slugs');
const AmountSchema = z.number().int().positive().max(MAX_AMOUNT_MINOR);

const base = { id: RuleIdSchema, action: RuleActionSchema };

export const MaxAmountPerTransactionRule = z.strictObject({
  ...base,
  type: z.literal('max_amount_per_transaction'),
  /** Matches when a single purchase is strictly greater than this. */
  amountMinor: AmountSchema,
});

export const MaxSpendPerPeriodRule = z.strictObject({
  ...base,
  type: z.literal('max_spend_per_period'),
  period: PeriodSchema,
  /** Matches when committed spend in the current period plus this purchase exceeds the limit. */
  amountMinor: AmountSchema,
});

export const MaxTransactionsPerPeriodRule = z.strictObject({
  ...base,
  type: z.literal('max_transactions_per_period'),
  period: PeriodSchema,
  /** Matches when this purchase would be number count+1 or later in the period. */
  count: z.number().int().positive().max(10_000),
});

const MerchantIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'merchant ids must be unique');

export const MerchantAllowlistRule = z.strictObject({
  ...base,
  type: z.literal('merchant_allowlist'),
  /** Matches when the merchant is NOT in this list. */
  merchantIds: MerchantIdsSchema,
});

export const MerchantBlocklistRule = z.strictObject({
  ...base,
  type: z.literal('merchant_blocklist'),
  /** Matches when the merchant IS in this list. */
  merchantIds: MerchantIdsSchema,
});

const CategoriesSchema = z
  .array(MerchantCategorySchema)
  .min(1)
  .refine((c) => new Set(c).size === c.length, 'categories must be unique');

export const CategoryAllowlistRule = z.strictObject({
  ...base,
  type: z.literal('category_allowlist'),
  categories: CategoriesSchema,
});

export const CategoryBlocklistRule = z.strictObject({
  ...base,
  type: z.literal('category_blocklist'),
  categories: CategoriesSchema,
});

export const NewMerchantRule = z.strictObject({
  ...base,
  type: z.literal('new_merchant'),
  /** Matches when the user has never had an authorized purchase from this merchant. */
});

export const TimeWindowRule = z
  .strictObject({
    ...base,
    type: z.literal('time_window'),
    /** Days purchases are permitted, 0 = Sunday … 6 = Saturday, in the policy time zone. */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'days must be unique'),
    /** Permitted hours [startHour, endHour) in the policy time zone. */
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
  })
  .refine((r) => r.startHour < r.endHour, {
    message: 'startHour must be before endHour',
    path: ['endHour'],
  });

export const DuplicateWindowRule = z.strictObject({
  ...base,
  type: z.literal('duplicate_window'),
  /** Matches when a purchase with the same merchant and amount was reserved within this many minutes. */
  minutes: z.number().int().min(1).max(10_080),
});

export const PolicyRuleSchema = z.discriminatedUnion('type', [
  MaxAmountPerTransactionRule,
  MaxSpendPerPeriodRule,
  MaxTransactionsPerPeriodRule,
  MerchantAllowlistRule,
  MerchantBlocklistRule,
  CategoryAllowlistRule,
  CategoryBlocklistRule,
  NewMerchantRule,
  TimeWindowRule,
  DuplicateWindowRule,
]);
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyRuleType = PolicyRule['type'];

export const POLICY_RULE_TYPES = [
  'max_amount_per_transaction',
  'max_spend_per_period',
  'max_transactions_per_period',
  'merchant_allowlist',
  'merchant_blocklist',
  'category_allowlist',
  'category_blocklist',
  'new_merchant',
  'time_window',
  'duplicate_window',
] as const satisfies readonly PolicyRuleType[];

/** IANA time zone names, validated against the runtime's tz database. */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'unknown time zone');

export const PolicyDocumentSchema = z
  .strictObject({
    dslVersion: z.literal(POLICY_DSL_VERSION),
    /** Every amount in the policy is in this currency; purchases in other currencies are blocked. */
    currency: CurrencySchema,
    /** Used for calendar periods (day/week/month) and time windows. */
    timezone: TimeZoneSchema,
    rules: z.array(PolicyRuleSchema).max(MAX_RULES),
  })
  .superRefine((policy, ctx) => {
    const ids = new Set<string>();
    policy.rules.forEach((rule, i) => {
      if (ids.has(rule.id))
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'id'],
          message: `duplicate rule id "${rule.id}"`,
        });
      ids.add(rule.id);
    });

    // Contradictions the user almost certainly did not intend.
    const allowed = new Set(
      policy.rules.flatMap((r) => (r.type === 'merchant_allowlist' ? r.merchantIds : [])),
    );
    policy.rules.forEach((rule, i) => {
      if (rule.type === 'merchant_blocklist') {
        for (const id of rule.merchantIds) {
          if (allowed.has(id)) {
            ctx.addIssue({
              code: 'custom',
              path: ['rules', i, 'merchantIds'],
              message: `merchant ${id} is both allowed and blocked`,
            });
          }
        }
      }
    });
    const allowedCats = new Set(
      policy.rules.flatMap((r) => (r.type === 'category_allowlist' ? r.categories : [])),
    );
    policy.rules.forEach((rule, i) => {
      if (rule.type === 'category_blocklist') {
        for (const c of rule.categories) {
          if (allowedCats.has(c)) {
            ctx.addIssue({
              code: 'custom',
              path: ['rules', i, 'categories'],
              message: `category ${c} is both allowed and blocked`,
            });
          }
        }
      }
    });
  });
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

/** A clause of the user's text the compiler could not express in the DSL. */
export const UnmappedClauseSchema = z.strictObject({
  text: z.string().min(1).max(500),
  reason: z.string().min(1).max(500),
});
export type UnmappedClause = z.infer<typeof UnmappedClauseSchema>;
