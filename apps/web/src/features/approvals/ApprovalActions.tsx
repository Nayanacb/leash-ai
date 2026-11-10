import { useState, type FormEvent } from 'react';
import { useApprove, useReject } from '../../api/approvals';
import { ApiRequestError } from '../../api/client';
import { isSteppedUp, useSession, useStepUp } from '../../api/session';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { ErrorMessage } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Form';

export interface ApprovalTarget {
  approvalId: string;
  snapshotHash: string;
  /** Shown in the confirmation: exactly what is being approved. */
  amountLabel: string;
  merchantName: string;
  payee: string | null;
  itemDescription: string;
}

/**
 * Approve / reject controls. Approving shows a confirmation with the amount
 * and the payee, asks for the password if the step-up window has lapsed, and
 * sends the snapshot hash of what was shown. Rejecting needs no step-up.
 */
export function ApprovalActions({
  target,
  onDone,
}: {
  target: ApprovalTarget;
  onDone?: () => void;
}) {
  const session = useSession();
  const approve = useApprove();
  const reject = useReject();
  const [mode, setMode] = useState<'idle' | 'confirm' | 'stepup' | 'reject'>('idle');
  const [note, setNote] = useState('');

  function submitApproval() {
    approve.mutate(
      {
        approvalId: target.approvalId,
        snapshotHash: target.snapshotHash,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          setMode('idle');
          onDone?.();
        },
        onError: (err) => {
          // Any other failure (stale snapshot, policy now blocks…) is shown in the confirmation.
          setMode(
            err instanceof ApiRequestError && err.code === 'STEP_UP_REQUIRED'
              ? 'stepup'
              : 'confirm',
          );
        },
      },
    );
  }

  function confirmApproval() {
    // The window is checked when the user acts, so it is never stale.
    if (isSteppedUp(session.data)) submitApproval();
    else setMode('stepup');
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        onClick={() => {
          approve.reset();
          setMode('confirm');
        }}
      >
        Approve
      </Button>
      <Button
        variant="secondary"
        onClick={() => {
          reject.reset();
          setMode('reject');
        }}
      >
        Reject
      </Button>

      {mode === 'confirm' && (
        <Dialog open title="Approve this purchase?" onClose={() => setMode('idle')}>
          <div className="space-y-4">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Amount</dt>
                <dd className="font-semibold">{target.amountLabel}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Merchant</dt>
                <dd>{target.merchantName}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Paid to</dt>
                <dd className="break-all font-mono text-xs">{target.payee ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Item (as described by the agent)</dt>
                <dd className="whitespace-pre-wrap break-words font-mono text-xs">
                  {target.itemDescription}
                </dd>
              </div>
            </dl>
            <Field label="Note (optional)">
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <ErrorMessage
              error={
                approve.error &&
                !(
                  approve.error instanceof ApiRequestError &&
                  approve.error.code === 'STEP_UP_REQUIRED'
                )
                  ? approve.error
                  : null
              }
            />
            <p className="text-xs text-slate-500">
              Leash re-checks your current policy and budget before authorizing. No money moves
              until checkout.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMode('idle')}>
                Cancel
              </Button>
              <Button disabled={approve.isPending} onClick={confirmApproval}>
                {approve.isPending ? 'Approving…' : 'Approve purchase'}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {mode === 'stepup' && (
        <StepUpDialog onClose={() => setMode('confirm')} onConfirmed={submitApproval} />
      )}

      {mode === 'reject' && (
        <Dialog open title="Reject this purchase?" onClose={() => setMode('idle')}>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              reject.mutate(
                { approvalId: target.approvalId, ...(note.trim() ? { note: note.trim() } : {}) },
                {
                  onSuccess: () => {
                    setMode('idle');
                    onDone?.();
                  },
                },
              );
            }}
          >
            <p className="text-sm text-slate-700">
              The held {target.amountLabel} is released and the agent is told the purchase was
              rejected.
            </p>
            <Field label="Reason (optional)">
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  maxLength={500}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <ErrorMessage error={reject.error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMode('idle')}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" disabled={reject.isPending}>
                Reject purchase
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

export function StepUpDialog({
  onClose,
  onConfirmed,
}: {
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const stepUp = useStepUp();
  const [password, setPassword] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    stepUp.mutate(password, { onSuccess: onConfirmed });
  }
  return (
    <Dialog open title="Confirm it's you" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-700">
          Enter your password to approve purchases for the next few minutes.
        </p>
        <ErrorMessage error={stepUp.error} />
        <Field label="Password">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" disabled={stepUp.isPending}>
            Confirm and approve
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
