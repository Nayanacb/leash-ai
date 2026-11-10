import type { TransactionDetailDto } from '@leash/shared';
import { useNavigate, useSearchParams } from 'react-router';
import { useStartCheckout } from '../../api/payments';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/Feedback';
import { formatDateTime, formatMoney } from '../../lib/format';
import { leaveForExternalPage } from '../../lib/navigation';

const AWAITING_PAYMENT = new Set(['AUTHORIZED', 'ORDER_CREATED', 'BUYER_APPROVED']);

const FAILURE_REASONS: Record<string, string> = {
  PAYMENT_DECLINED: 'PayPal declined the payment.',
  ORDER_MISMATCH:
    'The PayPal order did not match what Leash authorized (amount, currency, payee or IDs), so it was not captured.',
  PAYEE_CHANGED: 'The merchant’s PayPal account changed after authorization.',
  POLICY_BLOCKED_AT_CAPTURE: 'Your current policy, task or budget blocked it at payment time.',
  ORDER_VOIDED: 'PayPal voided the order.',
};

const box = 'rounded-xl px-5 py-4 text-sm ring-1 ring-inset';

/** Payment step for an authorized purchase: PayPal sandbox checkout, then its outcome. */
export function PaymentPanel({ t }: { t: TransactionDetailDto }) {
  const start = useStartCheckout(t.id);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const cancelledAtPayPal = params.get('paypal') === 'cancelled';

  if (AWAITING_PAYMENT.has(t.status)) {
    return (
      <div className={`${box} bg-sky-50 text-sky-950 ring-sky-600/20`}>
        <p className="font-semibold">Ready to pay</p>
        {cancelledAtPayPal && (
          <p className="mt-1" role="status">
            You left PayPal without paying. Nothing was charged.
          </p>
        )}
        <p className="mt-1">
          Leash authorized {formatMoney(t.amountMinor, t.currency)} to{' '}
          <span className="font-mono text-xs">{t.payment.payee ?? '—'}</span>
          {t.authorizationExpiresAt && <> until {formatDateTime(t.authorizationExpiresAt)}</>}.
          You’ll approve the payment on PayPal’s sandbox site with a sandbox buyer account; Leash
          then checks the order matches exactly before capturing it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            disabled={start.isPending}
            onClick={() =>
              start.mutate(undefined, {
                onSuccess: (r) => {
                  if (r.status === 'REDIRECT') leaveForExternalPage(r.approveUrl);
                  else void navigate(`/transactions/${t.id}/paypal-return`);
                },
              })
            }
          >
            {start.isPending
              ? 'Opening PayPal…'
              : t.status === 'AUTHORIZED'
                ? 'Pay with PayPal (sandbox)'
                : 'Continue to PayPal (sandbox)'}
          </Button>
          <ErrorMessage error={start.error} />
        </div>
      </div>
    );
  }

  if (t.status === 'CAPTURING') {
    return (
      <div role="status" className={`${box} bg-amber-50 text-amber-950 ring-amber-600/20`}>
        <p className="font-semibold">Payment being confirmed</p>
        <p className="mt-1">
          PayPal has not confirmed the capture yet. Leash checks again automatically; the funds stay
          held until then.
        </p>
      </div>
    );
  }

  if (t.status === 'CAPTURED') {
    return (
      <div className={`${box} bg-emerald-50 text-emerald-950 ring-emerald-600/20`}>
        <p className="font-semibold">Paid</p>
        <p className="mt-1">
          {formatMoney(t.payment.capturedMinor ?? t.amountMinor, t.currency)} captured
          {t.payment.capturedAt && <> on {formatDateTime(t.payment.capturedAt)}</>} to{' '}
          <span className="font-mono text-xs">{t.payment.payee ?? '—'}</span>.
        </p>
        <p className="mt-1 text-xs">
          PayPal order <span className="font-mono">{t.payment.paypalOrderId}</span> · capture{' '}
          <span className="font-mono">{t.payment.paypalCaptureId}</span> (sandbox)
        </p>
      </div>
    );
  }

  if (t.status === 'PAYMENT_FAILED') {
    return (
      <div role="status" className={`${box} bg-rose-50 text-rose-950 ring-rose-600/20`}>
        <p className="font-semibold">Payment failed — nothing was captured</p>
        <p className="mt-1">
          {FAILURE_REASONS[t.payment.failureReason ?? ''] ?? 'The payment could not be completed.'}{' '}
          The held funds were released.
        </p>
      </div>
    );
  }

  return null;
}
