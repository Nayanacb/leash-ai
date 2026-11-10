import { z } from 'zod';

/**
 * Money is always handled as integer minor units (e.g. cents) plus an
 * ISO-4217 currency code. Floats are never used for amounts.
 */

/** Number of decimal places for each supported currency. */
export const CURRENCY_EXPONENTS = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
} as const;

export const CurrencySchema = z.enum(
  Object.keys(CURRENCY_EXPONENTS) as [
    keyof typeof CURRENCY_EXPONENTS,
    ...(keyof typeof CURRENCY_EXPONENTS)[],
  ],
);
export type Currency = z.infer<typeof CurrencySchema>;

/** Largest amount we will ever represent ($10M in cents). */
export const MAX_AMOUNT_MINOR = 1_000_000_000; // fits a Postgres INTEGER column

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyParseError';
  }
}

/**
 * Strictly parses a decimal string (as PayPal formats amounts, e.g. "18.99")
 * into integer minor units. Rejects signs, exponents, whitespace, thousands
 * separators, and more fractional digits than the currency allows.
 */
export function parseDecimalToMinor(value: string, currency: Currency): number {
  const exponent = CURRENCY_EXPONENTS[currency];
  const pattern =
    exponent === 0 ? /^(0|[1-9]\d*)$/ : new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(value)) {
    throw new MoneyParseError(`Invalid ${currency} amount: ${JSON.stringify(value)}`);
  }
  const [whole = '0', fraction = ''] = value.split('.');
  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0') || '0');
  if (!Number.isSafeInteger(minor) || minor > MAX_AMOUNT_MINOR) {
    throw new MoneyParseError(`Amount out of range: ${JSON.stringify(value)}`);
  }
  return minor;
}

/** Formats integer minor units as a plain decimal string, e.g. 1899 USD → "18.99". */
export function formatMinorAsDecimal(amountMinor: number, currency: Currency): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new MoneyParseError(`Invalid minor amount: ${amountMinor}`);
  }
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === 0) return String(amountMinor);
  const divisor = 10 ** exponent;
  const whole = Math.floor(amountMinor / divisor);
  const fraction = String(amountMinor % divisor).padStart(exponent, '0');
  return `${whole}.${fraction}`;
}

/** Money as it appears on the wire: `{ currency: "USD", value: "18.99" }`. */
export const MoneyInputSchema = z.object({
  currency: CurrencySchema,
  value: z.string().max(32),
});
export type MoneyInput = z.infer<typeof MoneyInputSchema>;

/** Parses wire money into `{ currency, amountMinor }`, rejecting zero and malformed values. */
export const PositiveMoneySchema = MoneyInputSchema.transform((input, ctx) => {
  try {
    const amountMinor = parseDecimalToMinor(input.value, input.currency);
    if (amountMinor <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Amount must be greater than zero',
        path: ['value'],
      });
      return z.NEVER;
    }
    return { currency: input.currency, amountMinor };
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message, path: ['value'] });
    return z.NEVER;
  }
});
