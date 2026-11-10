import {
  DecisionSchema,
  TransactionStatusSchema,
  type Decision,
  type TransactionStatus,
} from '@leash/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useTransactions } from '../../api/transactions';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Form';
import { PageHeader, Panel, Table, Td, Th } from '../../components/ui/Layout';
import { DecisionPill, LifecycleStatus } from '../../components/ui/StatusPill';
import { formatDateTime, formatMoney, humanize } from '../../lib/format';

export function TransactionsPage() {
  const [status, setStatus] = useState<TransactionStatus | undefined>(() => {
    const initial = new URLSearchParams(window.location.search).get('status');
    return TransactionStatusSchema.safeParse(initial).success
      ? (initial as TransactionStatus)
      : undefined;
  });
  const [decision, setDecision] = useState<Decision | undefined>(undefined);
  const transactions = useTransactions({ status, decision });
  const rows = transactions.data?.pages.flatMap((p) => p.transactions) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        description="Every purchase your agents have attempted, the decision Leash made, and why."
      />
      <div className="flex flex-wrap gap-3">
        <div className="w-56">
          <Select
            aria-label="Filter by status"
            value={status ?? ''}
            onChange={(e) =>
              setStatus((e.target.value || undefined) as TransactionStatus | undefined)
            }
          >
            <option value="">All statuses</option>
            {TransactionStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {humanize(s.toLowerCase())}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-48">
          <Select
            aria-label="Filter by decision"
            value={decision ?? ''}
            onChange={(e) => setDecision((e.target.value || undefined) as Decision | undefined)}
          >
            <option value="">All decisions</option>
            {DecisionSchema.options.map((d) => (
              <option key={d} value={d}>
                {humanize(d.toLowerCase())}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {transactions.isPending ? (
        <Loading />
      ) : transactions.isError ? (
        <ErrorMessage error={transactions.error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No purchases yet">
          When an agent submits a purchase request it appears here.
        </EmptyState>
      ) : (
        <Panel>
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Item</Th>
                <Th>Agent</Th>
                <Th>Merchant</Th>
                <Th className="text-right">Amount</Th>
                <Th>Decision</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <Td className="whitespace-nowrap">
                    <Link
                      to={`/transactions/${t.id}`}
                      className="text-slate-900 underline-offset-2 hover:underline"
                    >
                      {formatDateTime(t.createdAt)}
                    </Link>
                  </Td>
                  <Td>
                    <span className="line-clamp-2 break-words">{t.itemDescription}</span>
                  </Td>
                  <Td>{t.agent.name}</Td>
                  <Td>{t.merchant?.displayName ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {formatMoney(t.amountMinor, t.currency)}
                  </Td>
                  <Td>{t.decision ? <DecisionPill decision={t.decision} /> : '—'}</Td>
                  <Td>
                    <LifecycleStatus status={t.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {transactions.hasNextPage && (
            <div className="border-t border-slate-100 px-5 py-3 text-center">
              <Button
                size="sm"
                variant="secondary"
                disabled={transactions.isFetchingNextPage}
                onClick={() => transactions.fetchNextPage()}
              >
                Load older purchases
              </Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
