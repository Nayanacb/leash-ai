import {
  formatMinorAsDecimal,
  type Currency,
  type Decision,
  type MerchantCategory,
  type Period,
  type PolicyDocument,
  type PolicyRule,
  type RuleAction,
  type TaskStatus,
} from '@leash/shared';
import { zonedParts } from '../budget/periods.js';

/**
 * The deterministic spending-policy engine.
 *
 * A pure function of its inputs: no I/O, no clock reads, no randomness and —
 * enforced by lint — no access to the LLM or the AI evaluation pipeline. Given
 * the same policy, purchase and spend snapshot it always returns the same
 * decision. AI signals (Phase 5) can only make this decision stricter.
 */

export interface PurchaseFacts {
  amountMinor: number;
  currency: Currency;
  merchantId: string;
  merchantCategory: MerchantCategory;
  merchantArchived: boolean;
  /** When the purchase is being evaluated (supplied by the caller, never read from the clock). */
  at: Date;
}

export interface TaskFacts {
  /** Effective status (ACTIVE tasks past expiry are EXPIRED). */
  status: TaskStatus;
  currency: Currency;
  budgetMinor: number;
  /** Already committed against this task (ledger), excluding this purchase. */
  committedMinor: number;
  allowedMerchantIds: readonly string[];
}

export interface SpendSnapshot {
  /** Committed spend and reservation count in the current calendar periods, excluding this purchase. */
  periods: Record<Period, { committedMinor: number; transactionCount: number }>;
  /** Whether the user has ever had an authorized purchase from this merchant. */
  merchantHasHistory: boolean;
  /** Reservation times of earlier purchases with the same merchant, amount and currency (still held). */
  similarPurchaseTimes: readonly Date[];
}

export interface EngineLimits {
  /** Hard per-transaction ceiling in minor units of the purchase currency (sandbox: 50,000). */
  sandboxMaxTransactionMinor: number;
}

export interface RuleResult {
  ruleId: string;
  ruleType: string;
  /** Built-in rules apply to every purchase and cannot be removed by a policy. */
  builtIn: boolean;
  /** True when the rule's condition matched, triggering its action. */
  matched: boolean;
  action: RuleAction;
  reasonCode: string;
  detail: string;
}

export interface PolicyEvaluation {
  decision: Decision;
  /** Reason codes of matched rules, BLOCK reasons first. */
  reasonCodes: string[];
  results: RuleResult[];
}

const money = (minor: number, currency: Currency) =>
  formatMinorAsDecimal(Math.max(0, minor), currency);

function builtIn(ruleId: string, matched: boolean, reasonCode: string, detail: string): RuleResult {
  return {
    ruleId,
    ruleType: 'built_in',
    builtIn: true,
    matched,
    action: 'BLOCK',
    reasonCode,
    detail,
  };
}

function evaluateBuiltIns(
  policy: PolicyDocument | null,
  purchase: PurchaseFacts,
  task: TaskFacts,
  limits: EngineLimits,
): RuleResult[] {
  const remaining = task.budgetMinor - task.committedMinor;
  const fmt = (minor: number) => money(minor, purchase.currency);
  return [
    builtIn(
      'active_policy',
      policy === null,
      'NO_ACTIVE_POLICY',
      policy === null
        ? 'No confirmed spending policy is active, so all purchases are blocked.'
        : 'A confirmed policy is active.',
    ),
    builtIn(
      'sandbox_ceiling',
      purchase.amountMinor > limits.sandboxMaxTransactionMinor,
      'SANDBOX_CEILING_EXCEEDED',
      `Purchase ${fmt(purchase.amountMinor)} vs ceiling ${fmt(limits.sandboxMaxTransactionMinor)}.`,
    ),
    builtIn(
      'policy_currency',
      policy !== null && purchase.currency !== policy.currency,
      'CURRENCY_NOT_ALLOWED',
      policy
        ? `Purchase in ${purchase.currency}; policy currency is ${policy.currency}.`
        : 'No policy.',
    ),
    builtIn(
      'task_active',
      task.status !== 'ACTIVE',
      'TASK_NOT_ACTIVE',
      `Task is ${task.status.toLowerCase()}.`,
    ),
    builtIn(
      'task_currency',
      purchase.currency !== task.currency,
      'TASK_CURRENCY_MISMATCH',
      `Purchase in ${purchase.currency}; task budget is in ${task.currency}.`,
    ),
    builtIn(
      'task_merchant',
      !task.allowedMerchantIds.includes(purchase.merchantId),
      'MERCHANT_NOT_IN_TASK',
      'The merchant must be one of the task’s allowed merchants.',
    ),
    builtIn(
      'merchant_archived',
      purchase.merchantArchived,
      'MERCHANT_ARCHIVED',
      'Archived merchants cannot be paid.',
    ),
    builtIn(
      'task_budget',
      purchase.amountMinor > remaining,
      'TASK_BUDGET_EXCEEDED',
      `Purchase ${fmt(purchase.amountMinor)} vs remaining task budget ${fmt(Math.max(0, remaining))}.`,
    ),
  ];
}

function evaluateRule(
  rule: PolicyRule,
  policy: PolicyDocument,
  purchase: PurchaseFacts,
  spend: SpendSnapshot,
): Omit<RuleResult, 'ruleId' | 'ruleType' | 'builtIn' | 'action'> {
  const fmt = (minor: number) => money(minor, purchase.currency);
  switch (rule.type) {
    case 'max_amount_per_transaction':
      return {
        matched: purchase.amountMinor > rule.amountMinor,
        reasonCode: 'AMOUNT_OVER_LIMIT',
        detail: `Purchase ${fmt(purchase.amountMinor)} vs limit ${fmt(rule.amountMinor)}.`,
      };
    case 'max_spend_per_period': {
      const committed = spend.periods[rule.period].committedMinor;
      return {
        matched: committed + purchase.amountMinor > rule.amountMinor,
        reasonCode: 'PERIOD_SPEND_LIMIT',
        detail: `${rule.period}: ${fmt(committed)} committed + ${fmt(purchase.amountMinor)} vs limit ${fmt(rule.amountMinor)}.`,
      };
    }
    case 'max_transactions_per_period': {
      const count = spend.periods[rule.period].transactionCount;
      return {
        matched: count + 1 > rule.count,
        reasonCode: 'PERIOD_TRANSACTION_LIMIT',
        detail: `${rule.period}: this would be purchase ${count + 1}; limit ${rule.count}.`,
      };
    }
    case 'merchant_allowlist':
      return {
        matched: !rule.merchantIds.includes(purchase.merchantId),
        reasonCode: 'MERCHANT_NOT_ALLOWED',
        detail: 'Merchant must be on the policy allowlist.',
      };
    case 'merchant_blocklist':
      return {
        matched: rule.merchantIds.includes(purchase.merchantId),
        reasonCode: 'MERCHANT_BLOCKED',
        detail: 'Merchant is on the policy blocklist.',
      };
    case 'category_allowlist':
      return {
        matched: !(rule.categories as readonly string[]).includes(purchase.merchantCategory),
        reasonCode: 'CATEGORY_NOT_ALLOWED',
        detail: `Category ${purchase.merchantCategory} must be one of: ${rule.categories.join(', ')}.`,
      };
    case 'category_blocklist':
      return {
        matched: (rule.categories as readonly string[]).includes(purchase.merchantCategory),
        reasonCode: 'CATEGORY_BLOCKED',
        detail: `Category ${purchase.merchantCategory} is blocked.`,
      };
    case 'new_merchant':
      return {
        matched: !spend.merchantHasHistory,
        reasonCode: 'NEW_MERCHANT',
        detail: spend.merchantHasHistory
          ? 'Merchant has been paid before.'
          : 'First purchase from this merchant.',
      };
    case 'time_window': {
      const local = zonedParts(purchase.at, policy.timezone);
      const inDays = rule.days.includes(local.weekday);
      const inHours = local.hour >= rule.startHour && local.hour < rule.endHour;
      return {
        matched: !(inDays && inHours),
        reasonCode: 'OUTSIDE_TIME_WINDOW',
        detail: `Local time ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')} on day ${local.weekday} (${policy.timezone}).`,
      };
    }
    case 'duplicate_window': {
      const since = purchase.at.getTime() - rule.minutes * 60_000;
      const recent = spend.similarPurchaseTimes.filter(
        (t) => t.getTime() >= since && t.getTime() <= purchase.at.getTime(),
      );
      return {
        matched: recent.length > 0,
        reasonCode: 'DUPLICATE_PURCHASE',
        detail: `${recent.length} purchase(s) with the same merchant and amount in the last ${rule.minutes} minutes.`,
      };
    }
  }
}

export function evaluatePolicy(
  policy: PolicyDocument | null,
  purchase: PurchaseFacts,
  task: TaskFacts,
  spend: SpendSnapshot,
  limits: EngineLimits,
): PolicyEvaluation {
  const results: RuleResult[] = evaluateBuiltIns(policy, purchase, task, limits);
  for (const rule of policy?.rules ?? []) {
    results.push({
      ruleId: rule.id,
      ruleType: rule.type,
      builtIn: false,
      action: rule.action,
      ...evaluateRule(rule, policy!, purchase, spend),
    });
  }

  const matched = results.filter((r) => r.matched);
  const blocks = matched.filter((r) => r.action === 'BLOCK');
  const escalations = matched.filter((r) => r.action === 'ESCALATE');
  const decision: Decision =
    blocks.length > 0 ? 'BLOCK' : escalations.length > 0 ? 'ESCALATE' : 'ALLOW';
  const reasonCodes = [...new Set([...blocks, ...escalations].map((r) => r.reasonCode))];
  return { decision, reasonCodes, results };
}
