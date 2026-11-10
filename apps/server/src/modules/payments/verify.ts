import { parseDecimalToMinor, type Currency } from '@leash/shared';
import type { OrderView } from './provider.js';

/**
 * Pure checks of what the payment provider reports against what Leash
 * authorized. Buyer approval at PayPal is necessary but never sufficient:
 * nothing is captured unless every field matches exactly (invariant I3).
 */

export interface AuthorizedPayment {
  orderId: string;
  transactionId: string;
  amountMinor: number;
  currency: Currency;
  payeeEmail: string;
}

function amountMatches(value: string, currency: string, expected: AuthorizedPayment): boolean {
  if (currency !== expected.currency) return false;
  try {
    return parseDecimalToMinor(value, expected.currency) === expected.amountMinor;
  } catch {
    return false;
  }
}

function minorOrNull(value: string, currency: string, expected: Currency): number | null {
  if (currency !== expected) return null;
  try {
    return parseDecimalToMinor(value, expected);
  } catch {
    return null;
  }
}

/** Every way the order differs from the authorized payment (empty = exact match). */
export function orderMismatches(order: OrderView, expected: AuthorizedPayment): string[] {
  const problems: string[] = [];
  if (order.id !== expected.orderId) problems.push('order id');
  if (order.purchaseUnits.length !== 1) {
    problems.push(`expected 1 purchase unit, got ${order.purchaseUnits.length}`);
    return problems;
  }
  const unit = order.purchaseUnits[0]!;
  if (unit.currency !== expected.currency) problems.push('currency');
  if (!amountMatches(unit.amountValue, unit.currency, expected)) problems.push('amount');
  if (unit.payeeEmail?.toLowerCase() !== expected.payeeEmail.toLowerCase()) problems.push('payee');
  if (unit.customId !== expected.transactionId) problems.push('custom_id');
  if (unit.invoiceId !== expected.transactionId) problems.push('invoice_id');
  return problems;
}

export type CaptureOutcome =
  | { kind: 'none' }
  | { kind: 'completed'; captureId: string; amountMinor: number | null; exact: boolean }
  | { kind: 'pending'; captureId: string }
  | { kind: 'declined'; captureId: string; status: string }
  | { kind: 'anomaly'; detail: string };

/** What the order says about money movement. Leash captures once, for the full amount. */
export function captureOutcome(order: OrderView, expected: AuthorizedPayment): CaptureOutcome {
  const captures = order.purchaseUnits.flatMap((u) => u.captures);
  if (captures.length === 0) return { kind: 'none' };
  if (captures.length > 1) return { kind: 'anomaly', detail: `${captures.length} captures` };
  const capture = captures[0]!;
  switch (capture.status) {
    // Refunds are recorded in Phase 8; a refunded capture still happened.
    case 'COMPLETED':
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return {
        kind: 'completed',
        captureId: capture.id,
        amountMinor: minorOrNull(capture.amountValue, capture.currency, expected.currency),
        exact: amountMatches(capture.amountValue, capture.currency, expected),
      };
    case 'PENDING':
      return { kind: 'pending', captureId: capture.id };
    case 'DECLINED':
    case 'FAILED':
      return { kind: 'declined', captureId: capture.id, status: capture.status };
    default:
      return { kind: 'anomaly', detail: `capture status ${capture.status}` };
  }
}
