import { describe, expect, it } from 'vitest';
import {
  formatMinorAsDecimal,
  MoneyParseError,
  parseDecimalToMinor,
  PositiveMoneySchema,
} from './money.js';

describe('parseDecimalToMinor', () => {
  it.each([
    ['18.99', 'USD', 1899],
    ['18.9', 'USD', 1890],
    ['18', 'USD', 1800],
    ['0.01', 'USD', 1],
    ['500.00', 'USD', 50000],
    ['1500', 'JPY', 1500],
  ] as const)('parses %s %s → %d', (value, currency, expected) => {
    expect(parseDecimalToMinor(value, currency)).toBe(expected);
  });

  it.each([
    '',
    ' 1.00',
    '1.00 ',
    '-1.00',
    '+1',
    '1.001',
    '1e3',
    '01.00',
    '1,000.00',
    '.5',
    '1.',
    'NaN',
    '0x10',
  ])('rejects %j', (value) => {
    expect(() => parseDecimalToMinor(value, 'USD')).toThrow(MoneyParseError);
  });

  it('rejects fractional JPY', () => {
    expect(() => parseDecimalToMinor('1.5', 'JPY')).toThrow(MoneyParseError);
  });

  it('rejects amounts beyond the safe range', () => {
    expect(() => parseDecimalToMinor('99999999999999999999', 'USD')).toThrow(MoneyParseError);
  });
});

describe('formatMinorAsDecimal', () => {
  it('round-trips', () => {
    for (const minor of [0, 1, 10, 99, 100, 1899, 50000]) {
      expect(parseDecimalToMinor(formatMinorAsDecimal(minor, 'USD'), 'USD')).toBe(minor);
    }
  });

  it('formats zero-exponent currencies without a decimal point', () => {
    expect(formatMinorAsDecimal(1500, 'JPY')).toBe('1500');
  });

  it('rejects negative and non-integer amounts', () => {
    expect(() => formatMinorAsDecimal(-1, 'USD')).toThrow(MoneyParseError);
    expect(() => formatMinorAsDecimal(1.5, 'USD')).toThrow(MoneyParseError);
  });
});

describe('PositiveMoneySchema', () => {
  it('parses wire money into minor units', () => {
    expect(PositiveMoneySchema.parse({ currency: 'USD', value: '18.99' })).toEqual({
      currency: 'USD',
      amountMinor: 1899,
    });
  });

  it('rejects zero, malformed values and unsupported currencies', () => {
    expect(PositiveMoneySchema.safeParse({ currency: 'USD', value: '0.00' }).success).toBe(false);
    expect(PositiveMoneySchema.safeParse({ currency: 'USD', value: '1.999' }).success).toBe(false);
    expect(PositiveMoneySchema.safeParse({ currency: 'XYZ', value: '1.00' }).success).toBe(false);
  });
});
