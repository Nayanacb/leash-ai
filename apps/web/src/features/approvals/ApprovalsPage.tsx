import type { ApprovalDto, ApprovalStatus } from '@leash/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApprovals } from '../../api/approvals';
import { EmptyState, ErrorMessage, Loading } from '../../components/ui/Feedback';
import { PageHeader } from '../../components/ui/Layout';
import { LifecycleStatus, StatusPill } from '../../components/ui/StatusPill';
import { formatDateTime, formatMoney, formatRelative } from '../../lib/format';
import { ApprovalActions } from './ApprovalActions';

const TABS: { label: string; status: ApprovalStatus }[] = [
  { label: 'Waiting', status: 'PENDING' },
  { label: 'Approved', status: 'APPROVED' },
  { label: 'Rejected', status: 'REJECTED' },
  { label: 'Expired', status: 'EXPIRED' },
  { label: 'Cancelled', status: 'CANCELLED' },
];

export function ApprovalsPage() {
  const [status, setStatus] = useState<ApprovalStatus>('PENDING');
  const approvals = useApprovals(status);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Purchases your policy or Leash's checks escalated to you. Approving needs your password; unanswered requests expire and release their funds. Blocked purchases never appear here — they can't be approved."
      />
      <div role="tablist" aria-label="Filter approvals" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.status}
            role="tab"
            type="button"
            aria-selected={status === t.status}
            onClick={() => setStatus(t.status)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${status === t.status ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {t.label}
            {t.status === 'PENDING' && approvals.data && status === 'PENDING'
              ? ` (${approvals.data.pendingCount})`
              : ''}
          </button>
        ))}
      </div>

      {approvals.isPending ? (
        <Loading />
      ) : approvals.isError ? (
        <ErrorMessage error={approvals.error} />
      ) : approvals.data.approvals.length === 0 ? (
        <EmptyState title={status === 'PENDING' ? 'Nothing waiting for you' : 'Nothing here yet'} />
      ) : (
        <ul className="space-y-3">
          {approvals.data.approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalCard({ approval: a }: { approval: ApprovalDto }) {
  const t = a.transaction;
  const pending = a.status === 'PENDING';
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-semibold tabular-nums">
            {formatMoney(t.amountMinor, t.currency)}
          </p>
          <p className="text-sm text-slate-600">
            {t.merchant?.displayName ?? 'Unknown merchant'} · paid to{' '}
            <span className="font-mono text-xs">{a.payee ?? '—'}</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Requested by {t.agent.name} {formatRelative(a.requestedAt)}
          </p>
        </div>
        {pending ? (
          <StatusPill tone="warn">Expires {formatRelative(a.expiresAt)}</StatusPill>
        ) : (
          <LifecycleStatus status={a.status} />
        )}
      </div>

      <div className="mt-3 rounded-md border border-dashed border-amber-300 bg-amber-50/40 px-3 py-2">
        <p className="text-xs font-medium text-amber-900">
          Item, as described by the agent (untrusted)
        </p>
        <p className="whitespace-pre-wrap break-words font-mono text-xs text-slate-800">
          {t.itemDescription}
        </p>
      </div>

      <p className="mt-2 text-xs text-slate-500">
        Why it needs you:{' '}
        <span className="font-mono">
          {t.reasonCodes.filter((c) => !c.startsWith('HUMAN_')).join(', ') || '—'}
        </span>
      </p>
      {a.note && <p className="mt-1 text-sm text-slate-700">Note: {a.note}</p>}
      {!pending && a.decidedAt && (
        <p className="mt-1 text-xs text-slate-500">Decided {formatDateTime(a.decidedAt)}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <Link to={`/transactions/${t.id}`} className="text-sm underline">
          Review all details
        </Link>
        {pending && (
          <ApprovalActions
            target={{
              approvalId: a.id,
              snapshotHash: a.snapshotHash,
              amountLabel: formatMoney(t.amountMinor, t.currency),
              merchantName: t.merchant?.displayName ?? 'Unknown merchant',
              payee: a.payee,
              itemDescription: t.itemDescription,
            }}
          />
        )}
      </div>
    </li>
  );
}
