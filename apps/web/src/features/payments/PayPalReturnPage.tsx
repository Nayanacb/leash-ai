import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router';
import { useCompleteCheckout } from '../../api/payments';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/Layout';
import { formatMoney } from '../../lib/format';

/**
 * Where PayPal sends the user back. Nothing in this URL is trusted: the page
 * only asks the server to verify the stored order with PayPal and capture it.
 */
export function PayPalReturnPage() {
  const { id = '' } = useParams();
  const complete = useCompleteCheckout(id);
  const sent = useRef(false);
  const { mutate } = complete;

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    mutate();
  }, [mutate]);

  const t = complete.data;
  return (
    <div className="space-y-6">
      <PageHeader title="PayPal checkout" description="Confirming your payment with PayPal." />
      {complete.isPending || complete.isIdle ? (
        <Loading label="Verifying the order with PayPal…" />
      ) : complete.isError ? (
        <ErrorMessage error={complete.error} />
      ) : t?.status === 'CAPTURED' ? (
        <p role="status" className="text-sm">
          Payment complete: {formatMoney(t.payment.capturedMinor ?? t.amountMinor, t.currency)}{' '}
          captured.
        </p>
      ) : t?.status === 'CAPTURING' ? (
        <p role="status" className="text-sm">
          PayPal is still processing the payment. Leash will confirm it automatically.
        </p>
      ) : (
        <p role="status" className="text-sm">
          The payment was not completed ({t?.status.toLowerCase().replaceAll('_', ' ')}).
        </p>
      )}
      <p className="text-sm">
        <Link to={`/transactions/${id}`} className="underline">
          Back to the purchase
        </Link>
      </p>
    </div>
  );
}
