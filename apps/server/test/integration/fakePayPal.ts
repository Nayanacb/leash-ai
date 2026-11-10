import { randomBytes } from 'node:crypto';
import { formatMinorAsDecimal } from '@leash/shared';
import {
  PaymentProviderError,
  type CreateOrderRequest,
  type OrderView,
  type PaymentProvider,
  type PurchaseUnitView,
} from '../../src/modules/payments/provider.js';

export type CaptureScript =
  | 'COMPLETED'
  | 'PENDING'
  | 'DECLINED'
  /** PayPal refuses (422 INSTRUMENT_DECLINED); nothing is captured. */
  | 'reject'
  /** The request never reaches PayPal (timeout before). Nothing is captured. */
  | 'network-before'
  /** PayPal captures, but the response is lost. */
  | 'network-after';

interface StoredOrder {
  order: OrderView;
  request: CreateOrderRequest;
  captureRequestId: string | null;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory stand-in for PayPal Orders v2 with the behaviours Leash relies on:
 * idempotency by request ID, buyer approval as a separate step, and captures
 * that can complete, stay pending, be declined, or have their response lost.
 */
export class FakePayPal implements PaymentProvider {
  orders = new Map<string, StoredOrder>();
  private byRequestId = new Map<string, string>();
  capture: CaptureScript = 'COMPLETED';
  /** Delay inside capture, to widen race windows. */
  captureDelayMs = 0;
  calls = { create: 0, get: 0, capture: 0 };
  /** Captures that actually moved money. */
  captureExecutions = 0;

  async createOrder(request: CreateOrderRequest, requestId: string): Promise<OrderView> {
    this.calls.create++;
    const existing = this.byRequestId.get(requestId);
    if (existing) return clone(this.orders.get(existing)!.order);
    const id = randomBytes(9).toString('hex').toUpperCase().slice(0, 17);
    const unit: PurchaseUnitView = {
      amountValue: formatMinorAsDecimal(request.amountMinor, request.currency),
      currency: request.currency,
      payeeEmail: request.payeeEmail,
      payeeMerchantId: 'FAKEMERCHANT',
      customId: request.transactionId,
      invoiceId: request.transactionId,
      captures: [],
    };
    const order: OrderView = {
      id,
      status: 'PAYER_ACTION_REQUIRED',
      purchaseUnits: [unit],
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
    };
    this.orders.set(id, { order, request, captureRequestId: null });
    this.byRequestId.set(requestId, id);
    return clone(order);
  }

  private stored(orderId: string): StoredOrder {
    const s = this.orders.get(orderId);
    if (!s) throw new PaymentProviderError('not_found', 'RESOURCE_NOT_FOUND', 'no such order', 404);
    return s;
  }

  async getOrder(orderId: string): Promise<OrderView> {
    this.calls.get++;
    return clone(this.stored(orderId).order);
  }

  async captureOrder(orderId: string, requestId: string): Promise<OrderView> {
    this.calls.capture++;
    const s = this.stored(orderId);
    if (this.captureDelayMs) await new Promise((r) => setTimeout(r, this.captureDelayMs));
    if (s.captureRequestId) {
      // Same request ID → the original result; a different one → already captured.
      if (s.captureRequestId === requestId) return clone(s.order);
      throw new PaymentProviderError('rejected', 'ORDER_ALREADY_CAPTURED', 'already captured', 422);
    }
    if (s.order.status !== 'APPROVED') {
      throw new PaymentProviderError('rejected', 'ORDER_NOT_APPROVED', 'not approved', 422);
    }
    switch (this.capture) {
      case 'network-before':
        throw new PaymentProviderError('ambiguous', 'TIMEOUT', 'timed out');
      case 'reject':
        throw new PaymentProviderError('rejected', 'INSTRUMENT_DECLINED', 'declined', 422);
      default: {
        const unit = s.order.purchaseUnits[0]!;
        const status = this.capture === 'network-after' ? 'COMPLETED' : this.capture;
        unit.captures.push({
          id: `CAP${randomBytes(6).toString('hex').toUpperCase()}`,
          status,
          amountValue: formatMinorAsDecimal(s.request.amountMinor, s.request.currency),
          currency: s.request.currency,
        });
        s.order.status = status === 'COMPLETED' ? 'COMPLETED' : s.order.status;
        s.captureRequestId = requestId;
        if (status === 'COMPLETED' || status === 'PENDING') this.captureExecutions++;
        if (this.capture === 'network-after') {
          throw new PaymentProviderError('ambiguous', 'TIMEOUT', 'response lost');
        }
        return clone(s.order);
      }
    }
  }

  // ── Test controls ──
  /** The buyer approves the order on PayPal's page. */
  approve(orderId: string) {
    this.stored(orderId).order.status = 'APPROVED';
  }
  /** Someone changes the order behind Leash's back. */
  tamper(orderId: string, change: Partial<PurchaseUnitView>) {
    Object.assign(this.stored(orderId).order.purchaseUnits[0]!, change);
  }
  /** A pending capture settles. */
  settleCapture(orderId: string, status: 'COMPLETED' | 'DECLINED') {
    const s = this.stored(orderId);
    s.order.purchaseUnits[0]!.captures[0]!.status = status;
    if (status === 'COMPLETED') s.order.status = 'COMPLETED';
  }
  void(orderId: string) {
    this.stored(orderId).order.status = 'VOIDED';
  }
}
