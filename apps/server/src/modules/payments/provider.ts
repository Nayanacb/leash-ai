import type { Currency } from '@leash/shared';

/**
 * The payment boundary (docs/ARCHITECTURE.md §2.1). Everything outside
 * src/modules/payments talks to a payment service through this interface,
 * never to PayPal directly. PayPal Checkout implements it now; PayPal Vault
 * can be a second implementation later.
 */

/** A capture as reported by the provider. Amounts stay as the provider's decimal strings. */
export interface CaptureView {
  id: string;
  /** PayPal: COMPLETED, PENDING, DECLINED, FAILED, PARTIALLY_REFUNDED, REFUNDED. */
  status: string;
  amountValue: string;
  currency: string;
}

export interface PurchaseUnitView {
  amountValue: string;
  currency: string;
  payeeEmail: string | null;
  payeeMerchantId: string | null;
  customId: string | null;
  invoiceId: string | null;
  captures: CaptureView[];
}

/** An order, as fetched from the provider (never as described by a redirect or the browser). */
export interface OrderView {
  id: string;
  /** PayPal: CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED. */
  status: string;
  purchaseUnits: PurchaseUnitView[];
  /** Where the buyer approves the order. Only ever shown to the Leash user. */
  approveUrl: string | null;
}

/** Built only from the stored, authorized transaction. */
export interface CreateOrderRequest {
  transactionId: string;
  amountMinor: number;
  currency: Currency;
  payeeEmail: string;
  /** Shown to the buyer on the provider's page. */
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PaymentProvider {
  /** Idempotent per `requestId`: repeating it returns the same order. */
  createOrder(request: CreateOrderRequest, requestId: string): Promise<OrderView>;
  getOrder(orderId: string): Promise<OrderView>;
  /** Idempotent per `requestId`: repeating it never captures twice. */
  captureOrder(orderId: string, requestId: string): Promise<OrderView>;
}

/**
 * - `ambiguous`: the outcome is unknown (network error, timeout, 5xx). The
 *   operation may or may not have happened; reconcile before doing anything else.
 * - `rejected`: the provider refused the request (4xx); nothing happened.
 * - `not_found`: the order doesn't exist (or isn't ours).
 * - `auth`: the provider refused our credentials.
 */
export type PaymentErrorKind = 'ambiguous' | 'rejected' | 'not_found' | 'auth';

export class PaymentProviderError extends Error {
  constructor(
    readonly kind: PaymentErrorKind,
    /** Provider error name/issue, e.g. INSTRUMENT_DECLINED. Never contains credentials. */
    readonly code: string,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

/** Stable idempotency keys: retries reuse them, so a request can't take effect twice. */
export const orderRequestId = (transactionId: string) => `leash-order-${transactionId}`;
export const captureRequestId = (transactionId: string) => `leash-capture-${transactionId}`;
