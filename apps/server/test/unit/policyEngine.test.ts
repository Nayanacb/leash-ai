import type { PolicyDocument, PolicyRule } from '@leash/shared';
import { describe, expect, it } from 'vitest';
import {
  evaluatePolicy,
  type PurchaseFacts,
  type SpendSnapshot,
  type TaskFacts,
} from '../../src/modules/authorization/policyEngine.js';

const MERCHANT = '0196a1b2-c3d4-7e5f-8a9b-000000000001';
const OTHER = '0196a1b2-c3d4-7e5f-8a9b-000000000002';

function policy(rules: PolicyRule[], overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return { dslVersion: 1, currency: 'USD', timezone: 'UTC', rules, ...overrides };
}

const purchase = (o: Partial<PurchaseFacts> = {}): PurchaseFacts => ({
  amountMinor: 1500,
  currency: 'USD',
  merchantId: MERCHANT,
  merchantCategory: 'electronics',
  merchantArchived: false,
  at: new Date('2026-11-11T14:00:00Z'), // Wednesday 14:00 UTC
  ...o,
});

const task = (o: Partial<TaskFacts> = {}): TaskFacts => ({
  status: 'ACTIVE',
  currency: 'USD',
  budgetMinor: 10_000,
  committedMinor: 0,
  allowedMerchantIds: [MERCHANT, OTHER],
  ...o,
});

const spend = (o: Partial<SpendSnapshot> = {}): SpendSnapshot => ({
  periods: {
    day: { committedMinor: 0, transactionCount: 0 },
    week: { committedMinor: 0, transactionCount: 0 },
    month: { committedMinor: 0, transactionCount: 0 },
  },
  merchantHasHistory: true,
  similarPurchaseTimes: [],
  ...o,
});

const LIMITS = { sandboxMaxTransactionMinor: 50_000 };

function run(
  rules: PolicyRule[],
  p = purchase(),
  t = task(),
  s = spend(),
  pol?: PolicyDocument | null,
) {
  return evaluatePolicy(pol === undefined ? policy(rules) : pol, p, t, s, LIMITS);
}

describe('policy engine: decisions', () => {
  it('allows a purchase that matches no rule', () => {
    expect(run([])).toMatchObject({ decision: 'ALLOW', reasonCodes: [] });
  });

  it('BLOCK beats ESCALATE, and both report their reasons (BLOCK first)', () => {
    const result = run([
      { id: 'ask', type: 'max_amount_per_transaction', amountMinor: 1000, action: 'ESCALATE' },
      { id: 'cat', type: 'category_blocklist', categories: ['electronics'], action: 'BLOCK' },
    ]);
    expect(result.decision).toBe('BLOCK');
    expect(result.reasonCodes).toEqual(['CATEGORY_BLOCKED', 'AMOUNT_OVER_LIMIT']);
  });

  it('escalates when only ESCALATE rules match', () => {
    expect(
      run([
        { id: 'ask', type: 'max_amount_per_transaction', amountMinor: 1000, action: 'ESCALATE' },
      ]).decision,
    ).toBe('ESCALATE');
  });

  it('is deterministic', () => {
    const rules: PolicyRule[] = [
      { id: 'w', type: 'max_spend_per_period', period: 'week', amountMinor: 5000, action: 'BLOCK' },
    ];
    expect(run(rules)).toEqual(run(rules));
  });

  it('reports every rule, matched or not, for review', () => {
    const result = run([
      { id: 'r1', type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' },
    ]);
    expect(result.results.find((r) => r.ruleId === 'r1')).toMatchObject({
      matched: false,
      builtIn: false,
    });
    expect(result.results.filter((r) => r.builtIn).length).toBeGreaterThan(5);
  });
});

describe('policy engine: built-in rules (cannot be overridden)', () => {
  it('blocks everything when no policy is active', () => {
    expect(run([], purchase(), task(), spend(), null)).toMatchObject({
      decision: 'BLOCK',
      reasonCodes: ['NO_ACTIVE_POLICY'],
    });
  });

  it('enforces the sandbox ceiling at exactly the boundary', () => {
    expect(
      run([], purchase({ amountMinor: 50_000 }), task({ budgetMinor: 100_000 })).decision,
    ).toBe('ALLOW');
    expect(
      run([], purchase({ amountMinor: 50_001 }), task({ budgetMinor: 100_000 })).reasonCodes,
    ).toContain('SANDBOX_CEILING_EXCEEDED');
  });

  it('blocks a currency other than the policy currency and the task currency', () => {
    const result = run([], purchase({ currency: 'EUR' }));
    expect(result.decision).toBe('BLOCK');
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['CURRENCY_NOT_ALLOWED', 'TASK_CURRENCY_MISMATCH']),
    );
  });

  it.each(['EXPIRED', 'CANCELLED', 'COMPLETED'] as const)(
    'blocks when the task is %s',
    (status) => {
      expect(run([], purchase(), task({ status })).reasonCodes).toContain('TASK_NOT_ACTIVE');
    },
  );

  it('blocks merchants the task does not allow, and archived merchants', () => {
    expect(run([], purchase(), task({ allowedMerchantIds: [OTHER] })).reasonCodes).toContain(
      'MERCHANT_NOT_IN_TASK',
    );
    expect(run([], purchase({ merchantArchived: true })).reasonCodes).toContain(
      'MERCHANT_ARCHIVED',
    );
  });

  it('enforces the remaining task budget at exactly the boundary', () => {
    expect(
      run([], purchase({ amountMinor: 2000 }), task({ budgetMinor: 5000, committedMinor: 3000 }))
        .decision,
    ).toBe('ALLOW');
    expect(
      run([], purchase({ amountMinor: 2001 }), task({ budgetMinor: 5000, committedMinor: 3000 }))
        .reasonCodes,
    ).toContain('TASK_BUDGET_EXCEEDED');
  });

  it('a user rule can never turn a built-in BLOCK into anything else', () => {
    const result = run(
      [{ id: 'ask', type: 'max_amount_per_transaction', amountMinor: 1, action: 'ESCALATE' }],
      purchase({ amountMinor: 60_000 }),
      task({ budgetMinor: 100_000 }),
    );
    expect(result.decision).toBe('BLOCK');
  });
});

describe('policy engine: user rules', () => {
  it('max_amount_per_transaction matches strictly above the limit', () => {
    const rules: PolicyRule[] = [
      { id: 'm', type: 'max_amount_per_transaction', amountMinor: 1500, action: 'BLOCK' },
    ];
    expect(run(rules, purchase({ amountMinor: 1500 })).decision).toBe('ALLOW');
    expect(run(rules, purchase({ amountMinor: 1501 })).decision).toBe('BLOCK');
  });

  it.each(['day', 'week', 'month'] as const)(
    'max_spend_per_period (%s) counts committed spend plus this purchase',
    (period) => {
      const rules: PolicyRule[] = [
        { id: 'p', type: 'max_spend_per_period', period, amountMinor: 10_000, action: 'BLOCK' },
      ];
      const at = (committed: number) => {
        const s = spend();
        s.periods[period] = { committedMinor: committed, transactionCount: 1 };
        return s;
      };
      expect(run(rules, purchase({ amountMinor: 1500 }), task(), at(8500)).decision).toBe('ALLOW');
      expect(run(rules, purchase({ amountMinor: 1500 }), task(), at(8501)).decision).toBe('BLOCK');
    },
  );

  it('max_transactions_per_period allows exactly `count` purchases', () => {
    const rules: PolicyRule[] = [
      {
        id: 't',
        type: 'max_transactions_per_period',
        period: 'week',
        count: 3,
        action: 'ESCALATE',
      },
    ];
    const withCount = (n: number) => {
      const s = spend();
      s.periods.week = { committedMinor: 0, transactionCount: n };
      return s;
    };
    expect(run(rules, purchase(), task(), withCount(2)).decision).toBe('ALLOW');
    expect(run(rules, purchase(), task(), withCount(3)).decision).toBe('ESCALATE');
  });

  it('merchant allow- and blocklists', () => {
    expect(
      run([{ id: 'a', type: 'merchant_allowlist', merchantIds: [OTHER], action: 'BLOCK' }])
        .reasonCodes,
    ).toEqual(['MERCHANT_NOT_ALLOWED']);
    expect(
      run([{ id: 'a', type: 'merchant_allowlist', merchantIds: [MERCHANT], action: 'BLOCK' }])
        .decision,
    ).toBe('ALLOW');
    expect(
      run([{ id: 'b', type: 'merchant_blocklist', merchantIds: [MERCHANT], action: 'BLOCK' }])
        .reasonCodes,
    ).toEqual(['MERCHANT_BLOCKED']);
  });

  it('category allow- and blocklists', () => {
    expect(
      run([{ id: 'a', type: 'category_allowlist', categories: ['books'], action: 'ESCALATE' }])
        .decision,
    ).toBe('ESCALATE');
    expect(
      run([{ id: 'a', type: 'category_allowlist', categories: ['electronics'], action: 'BLOCK' }])
        .decision,
    ).toBe('ALLOW');
    expect(
      run([{ id: 'b', type: 'category_blocklist', categories: ['travel'], action: 'BLOCK' }])
        .decision,
    ).toBe('ALLOW');
  });

  it('new_merchant matches only without history', () => {
    const rules: PolicyRule[] = [{ id: 'n', type: 'new_merchant', action: 'ESCALATE' }];
    expect(run(rules, purchase(), task(), spend({ merchantHasHistory: false })).decision).toBe(
      'ESCALATE',
    );
    expect(run(rules, purchase(), task(), spend({ merchantHasHistory: true })).decision).toBe(
      'ALLOW',
    );
  });

  it('time_window uses the policy time zone and is end-exclusive', () => {
    const rules: PolicyRule[] = [
      {
        id: 'tw',
        type: 'time_window',
        days: [1, 2, 3, 4, 5],
        startHour: 9,
        endHour: 17,
        action: 'ESCALATE',
      },
    ];
    const at = (iso: string) => purchase({ at: new Date(iso) });
    expect(run(rules, at('2026-11-11T09:00:00Z')).decision).toBe('ALLOW'); // Wed 09:00
    expect(run(rules, at('2026-11-11T16:59:59Z')).decision).toBe('ALLOW');
    expect(run(rules, at('2026-11-11T17:00:00Z')).decision).toBe('ESCALATE');
    expect(run(rules, at('2026-11-14T12:00:00Z')).decision).toBe('ESCALATE'); // Saturday
    // 14:00 UTC is 06:00 in Los Angeles — outside the window there.
    expect(
      evaluatePolicy(
        policy(rules, { timezone: 'America/Los_Angeles' }),
        at('2026-11-11T14:00:00Z'),
        task(),
        spend(),
        LIMITS,
      ).decision,
    ).toBe('ESCALATE');
  });

  it('duplicate_window looks back exactly N minutes', () => {
    const rules: PolicyRule[] = [
      { id: 'd', type: 'duplicate_window', minutes: 10, action: 'BLOCK' },
    ];
    const now = new Date('2026-11-11T14:00:00Z');
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    expect(
      run(rules, purchase({ at: now }), task(), spend({ similarPurchaseTimes: [ago(10)] }))
        .decision,
    ).toBe('BLOCK');
    expect(
      run(rules, purchase({ at: now }), task(), spend({ similarPurchaseTimes: [ago(10.01)] }))
        .decision,
    ).toBe('ALLOW');
  });
});
