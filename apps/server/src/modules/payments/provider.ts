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

/** A refund as reported by the provider. */
export interface RefundView {
  id: string;
  /** PayPal: COMPLETED, PENDING, FAILED, CANCELLED. */
  status: string;
  amountValue: string;
  currency: string;
  /** Leash sets invoice_id = its own refund ID, so a refund can be found again after a lost response. */
  invoiceId: string | null;
  captureId: string | null;
}

/** A capture fetched on its own (used for reversals). */
export interface CaptureDetailView extends CaptureView {
  orderId: string | null;
}

export interface PurchaseUnitView {
  amountValue: string;
  currency: string;
  payeeEmail: string | null;
  payeeMerchantId: string | null;
  customId: string | null;
  invoiceId: string | null;
  captures: CaptureView[];
  refunds: RefundView[];
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

export interface RefundRequest {
  amountMinor: number;
  currency: Currency;
  /** Leash's refund ID. */
  invoiceId: string;
  /** Shown to the payer. */
  note: string | null;
}

/** The transmission headers PayPal signs a webhook delivery with. */
export interface WebhookTransmission {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export interface PaymentProvider {
  /** Idempotent per `requestId`: repeating it returns the same order. */
  createOrder(request: CreateOrderRequest, requestId: string): Promise<OrderView>;
  getOrder(orderId: string): Promise<OrderView>;
  /** Idempotent per `requestId`: repeating it never captures twice. */
  captureOrder(orderId: string, requestId: string): Promise<OrderView>;
  /** Idempotent per `requestId`: repeating it never refunds twice. */
  refundCapture(captureId: string, request: RefundRequest, requestId: string): Promise<RefundView>;
  getRefund(refundId: string): Promise<RefundView>;
  getCapture(captureId: string): Promise<CaptureDetailView>;
  /**
   * Asks the provider whether a webhook delivery is genuine. `rawBody` is
   * passed through byte for byte. True only for a verified signature.
   */
  verifyWebhookSignature(
    transmission: WebhookTransmission,
    webhookId: string,
    rawBody: string,
  ): Promise<boolean>;
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
export const refundRequestId = (refundId: string) => `leash-refund-${refundId}`;
