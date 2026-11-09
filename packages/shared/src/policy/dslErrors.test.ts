import { describe, expect, it } from 'vitest';
import { PolicyDocumentSchema } from './dsl.js';

describe('validation error paths', () => {
  it('point at the offending field inside a rule', () => {
    const result = PolicyDocumentSchema.safeParse({
      dslVersion: 1,
      currency: 'USD',
      timezone: 'UTC',
      rules: [
        { id: 'cap', type: 'max_amount_per_transaction', amountMinor: 'lots', action: 'BLOCK' },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path.join('.'))).toEqual(['rules.0.amountMinor']);
  });

  it('name the discriminator when the rule type is unknown', () => {
    const result = PolicyDocumentSchema.safeParse({
      dslVersion: 1,
      currency: 'USD',
      timezone: 'UTC',
      rules: [{ id: 'x', type: 'approve_everything', action: 'BLOCK' }],
    });
    expect(result.error!.issues[0]!.path.join('.')).toBe('rules.0.type');
  });
});
