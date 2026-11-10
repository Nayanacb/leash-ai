import { formatMinorAsDecimal, type TransactionDetailDto } from '@leash/shared';
import { useState } from 'react';
import { useRefund } from '../../api/payments';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { ErrorMessage } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Form';
import { LifecycleStatus } from '../../components/ui/StatusPill';
import { formatDateTime, formatMoney } from '../../lib/format';

/** Refunds of a captured purchase: the list, and a dialog to request one. */
export function RefundSection({ t }: { t: TransactionDetailDto }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 space-y-2">
      {t.refunds.length > 0 && (
        <ul className="space-y-1 text-xs" aria-label="Refunds">
          {t.refunds.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <LifecycleStatus status={r.status} />
              <span className="font-semibold">{formatMoney(r.amountMinor, r.currency)}</span>
              <span>{r.source === 'PAYPAL' ? 'outside Leash (PayPal)' : 'from Leash'}</span>
              <span className="text-slate-600">
                · {formatDateTime(r.completedAt ?? r.createdAt)}
              </span>
              {r.reason && <span className="text-slate-600">· {r.reason}</span>}
              {r.failureReason && <span className="text-rose-700">· {r.failureReason}</span>}
            </li>
          ))}
        </ul>
      )}
      {t.payment.refundableMinor > 0 && (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Refund…
        </Button>
      )}
      {open && <RefundDialog t={t} onClose={() => setOpen(false)} />}
    </div>
  );
}

function RefundDialog({ t, onClose }: { t: TransactionDetailDto; onClose: () => void }) {
  const refund = useRefund(t.id);
  const [amount, setAmount] = useState(formatMinorAsDecimal(t.payment.refundableMinor, t.currency));
  const [reason, setReason] = useState('');
  // One key per dialog: retrying the same request can never refund twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  return (
    <Dialog open title="Refund this purchase" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          refund.mutate(
            {
              input: {
                amount: { currency: t.currency, value: amount.trim() },
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              },
              idempotencyKey,
            },
            { onSuccess: onClose },
          );
        }}
      >
        <p className="text-sm text-slate-700">
          Up to {formatMoney(t.payment.refundableMinor, t.currency)} can be refunded to the PayPal
          sandbox buyer. Refunded amounts are credited back to your budget.
        </p>
        <Field label={`Amount (${t.currency})`}>
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        <Field label="Reason (optional, shown to the buyer)">
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={255}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        <ErrorMessage error={refund.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={refund.isPending}>
            {refund.isPending ? 'Refunding…' : 'Refund'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
