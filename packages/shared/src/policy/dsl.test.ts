import { describe, expect, it } from 'vitest';
import { PolicyDocumentSchema, type PolicyDocument } from './dsl.js';
import { renderBuiltInRules, renderPolicy } from './render.js';

const M1 = '0196a1b2-c3d4-7e5f-8a9b-000000000001';
const M2 = '0196a1b2-c3d4-7e5f-8a9b-000000000002';

const doc = (rules: unknown[], extra: Record<string, unknown> = {}) => ({
  dslVersion: 1,
  currency: 'USD',
  timezone: 'America/New_York',
  rules,
  ...extra,
});

describe('PolicyDocumentSchema', () => {
  it('accepts every rule type', () => {
    const result = PolicyDocumentSchema.safeParse(
      doc([
        { id: 'a', type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' },
        {
          id: 'b',
          type: 'max_spend_per_period',
          period: 'week',
          amountMinor: 20000,
          action: 'ESCALATE',
        },
        { id: 'c', type: 'max_transactions_per_period', period: 'day', count: 3, action: 'BLOCK' },
        { id: 'd', type: 'merchant_allowlist', merchantIds: [M1], action: 'BLOCK' },
        { id: 'e', type: 'merchant_blocklist', merchantIds: [M2], action: 'BLOCK' },
        {
          id: 'f',
          type: 'category_allowlist',
          categories: ['books', 'software'],
          action: 'ESCALATE',
        },
        { id: 'g', type: 'category_blocklist', categories: ['travel'], action: 'BLOCK' },
        { id: 'h', type: 'new_merchant', action: 'ESCALATE' },
        {
          id: 'i',
          type: 'time_window',
          days: [1, 2, 3, 4, 5],
          startHour: 9,
          endHour: 17,
          action: 'ESCALATE',
        },
        { id: 'j', type: 'duplicate_window', minutes: 30, action: 'BLOCK' },
      ]),
    );
    expect(result.success).toBe(true);
  });

  it.each([
    ['wrong DSL version', doc([], { dslVersion: 2 })],
    ['unknown currency', doc([], { currency: 'BTC' })],
    ['unknown time zone', doc([], { timezone: 'Mars/Olympus' })],
    ['extra top-level field', doc([], { override: true })],
    ['unknown rule type', doc([{ id: 'a', type: 'allow_all', action: 'BLOCK' }])],
    ['ALLOW action', doc([{ id: 'a', type: 'new_merchant', action: 'ALLOW' }])],
    [
      'zero amount',
      doc([{ id: 'a', type: 'max_amount_per_transaction', amountMinor: 0, action: 'BLOCK' }]),
    ],
    [
      'float amount',
      doc([{ id: 'a', type: 'max_amount_per_transaction', amountMinor: 1.5, action: 'BLOCK' }]),
    ],
    [
      'string amount',
      doc([{ id: 'a', type: 'max_amount_per_transaction', amountMinor: '50', action: 'BLOCK' }]),
    ],
    [
      'huge amount',
      doc([{ id: 'a', type: 'max_amount_per_transaction', amountMinor: 1e15, action: 'BLOCK' }]),
    ],
    [
      'bad period',
      doc([
        { id: 'a', type: 'max_spend_per_period', period: 'year', amountMinor: 1, action: 'BLOCK' },
      ]),
    ],
    [
      'empty merchant list',
      doc([{ id: 'a', type: 'merchant_allowlist', merchantIds: [], action: 'BLOCK' }]),
    ],
    [
      'non-uuid merchant',
      doc([{ id: 'a', type: 'merchant_allowlist', merchantIds: ['amazon'], action: 'BLOCK' }]),
    ],
    [
      'unknown category',
      doc([{ id: 'a', type: 'category_blocklist', categories: ['weapons'], action: 'BLOCK' }]),
    ],
    [
      'bad weekday',
      doc([
        { id: 'a', type: 'time_window', days: [7], startHour: 9, endHour: 17, action: 'BLOCK' },
      ]),
    ],
    [
      'empty time window',
      doc([{ id: 'a', type: 'time_window', days: [1], startHour: 9, endHour: 9, action: 'BLOCK' }]),
    ],
    ['bad rule id', doc([{ id: 'Has Spaces', type: 'new_merchant', action: 'BLOCK' }])],
    [
      'duplicate ids',
      doc([
        { id: 'a', type: 'new_merchant', action: 'BLOCK' },
        { id: 'a', type: 'new_merchant', action: 'BLOCK' },
      ]),
    ],
    [
      'merchant both allowed and blocked',
      doc([
        { id: 'a', type: 'merchant_allowlist', merchantIds: [M1], action: 'BLOCK' },
        { id: 'b', type: 'merchant_blocklist', merchantIds: [M1], action: 'BLOCK' },
      ]),
    ],
    [
      'too many rules',
      doc(
        Array.from({ length: 51 }, (_, i) => ({
          id: `r${i}`,
          type: 'new_merchant',
          action: 'BLOCK',
        })),
      ),
    ],
  ])('rejects %s', (_name, value) => {
    expect(PolicyDocumentSchema.safeParse(value).success).toBe(false);
  });
});

describe('renderPolicy', () => {
  const policy = PolicyDocumentSchema.parse(
    doc([
      { id: 'a', type: 'max_amount_per_transaction', amountMinor: 5000, action: 'BLOCK' },
      {
        id: 'b',
        type: 'max_spend_per_period',
        period: 'month',
        amountMinor: 50000,
        action: 'ESCALATE',
      },
      { id: 'c', type: 'max_transactions_per_period', period: 'day', count: 1, action: 'BLOCK' },
      { id: 'd', type: 'merchant_allowlist', merchantIds: [M1, M2], action: 'BLOCK' },
      {
        id: 'f',
        type: 'category_blocklist',
        categories: ['food_delivery', 'travel'],
        action: 'BLOCK',
      },
      { id: 'h', type: 'new_merchant', action: 'ESCALATE' },
      { id: 'i', type: 'time_window', days: [5, 1], startHour: 9, endHour: 17, action: 'ESCALATE' },
      { id: 'j', type: 'duplicate_window', minutes: 1, action: 'BLOCK' },
    ]),
  ) as PolicyDocument;

  it('renders every rule in plain English, deterministically', () => {
    const names = { [M1]: 'Cable Co', [M2]: 'Paper Planet' };
    const rendered = renderPolicy(policy, { merchantNames: names }).map((r) => r.text);
    expect(rendered).toEqual([
      'Block any single purchase over 50.00 USD.',
      'Ask me to approve purchases that would take total spending above 500.00 USD per calendar month.',
      'Block more than 1 purchase per day.',
      'Block purchases from any merchant other than Cable Co and Paper Planet.',
      'Block purchases in these categories: food delivery and travel.',
      "Ask me to approve the first purchase from any merchant I haven't bought from before.",
      'Ask me to approve purchases outside Monday and Friday, 09:00–17:00 (America/New_York).',
      'Block a purchase with the same merchant and amount as another within 1 minute.',
    ]);
    expect(renderPolicy(policy, { merchantNames: names })).toEqual(
      renderPolicy(policy, { merchantNames: names }),
    );
  });

  it('flags merchant IDs it cannot name instead of hiding them', () => {
    const [, , , allow] = renderPolicy(policy, { merchantNames: { [M1]: 'Cable Co' } });
    expect(allow!.text).toContain('unknown merchant (0196a1b2…)');
  });

  it('lists the built-in rules', () => {
    expect(renderBuiltInRules(50_000, 'USD')[0]).toContain('500.00 USD');
  });
});
