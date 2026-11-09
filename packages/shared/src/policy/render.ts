import { formatMinorAsDecimal, type Currency } from '../money.js';
import type { PolicyDocument, PolicyRule } from './dsl.js';

/**
 * Deterministic, plain-English rendering of a policy. This — not anything the
 * LLM wrote — is what the user reviews before confirming, so the summary can
 * never disagree with the rules that will be enforced.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PERIOD_NAMES = {
  day: 'per day',
  week: 'per week (Monday–Sunday)',
  month: 'per calendar month',
} as const;

export interface RenderContext {
  merchantNames: Record<string, string>;
}

function money(amountMinor: number, currency: Currency) {
  return `${formatMinorAsDecimal(amountMinor, currency)} ${currency}`;
}

function verb(rule: PolicyRule) {
  return rule.action === 'BLOCK' ? 'Block' : 'Ask me to approve';
}

function list(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function humanCategory(c: string) {
  return c.replaceAll('_', ' ');
}

function hour(h: number) {
  return `${String(h).padStart(2, '0')}:00`;
}

export function renderRule(
  rule: PolicyRule,
  policy: Pick<PolicyDocument, 'currency' | 'timezone'>,
  ctx: RenderContext,
): string {
  const merchants = (ids: string[]) =>
    list(ids.map((id) => ctx.merchantNames[id] ?? `unknown merchant (${id.slice(0, 8)}…)`));
  switch (rule.type) {
    case 'max_amount_per_transaction':
      return `${verb(rule)} any single purchase over ${money(rule.amountMinor, policy.currency)}.`;
    case 'max_spend_per_period':
      return `${verb(rule)} purchases that would take total spending above ${money(rule.amountMinor, policy.currency)} ${PERIOD_NAMES[rule.period]}.`;
    case 'max_transactions_per_period':
      return `${verb(rule)} more than ${rule.count} purchase${rule.count === 1 ? '' : 's'} ${PERIOD_NAMES[rule.period]}.`;
    case 'merchant_allowlist':
      return `${verb(rule)} purchases from any merchant other than ${merchants(rule.merchantIds)}.`;
    case 'merchant_blocklist':
      return `${verb(rule)} purchases from ${merchants(rule.merchantIds)}.`;
    case 'category_allowlist':
      return `${verb(rule)} purchases outside these categories: ${list(rule.categories.map(humanCategory))}.`;
    case 'category_blocklist':
      return `${verb(rule)} purchases in these categories: ${list(rule.categories.map(humanCategory))}.`;
    case 'new_merchant':
      return `${verb(rule)} the first purchase from any merchant I haven't bought from before.`;
    case 'time_window': {
      const days = [...rule.days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]!);
      return `${verb(rule)} purchases outside ${list(days)}, ${hour(rule.startHour)}–${hour(rule.endHour)} (${policy.timezone}).`;
    }
    case 'duplicate_window':
      return `${verb(rule)} a purchase with the same merchant and amount as another within ${rule.minutes} minute${rule.minutes === 1 ? '' : 's'}.`;
  }
}

export interface RenderedRule {
  id: string;
  action: PolicyRule['action'];
  text: string;
}

export function renderPolicy(policy: PolicyDocument, ctx: RenderContext): RenderedRule[] {
  return policy.rules.map((rule) => ({
    id: rule.id,
    action: rule.action,
    text: renderRule(rule, policy, ctx),
  }));
}

/** Rules every policy gets, regardless of what the user wrote. Shown alongside the user's rules. */
export function renderBuiltInRules(
  sandboxMaxTransactionMinor: number,
  currency: Currency,
): string[] {
  return [
    `Block any single purchase over ${money(sandboxMaxTransactionMinor, currency)} (sandbox ceiling; cannot be changed by a policy).`,
    `Block purchases in any currency other than ${currency}.`,
    'Block purchases that are not part of an active task, exceed the task’s remaining budget, or use a merchant the task does not allow.',
  ];
}
