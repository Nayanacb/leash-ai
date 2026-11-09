import type { BudgetPeriodStatus } from '@leash/shared';
import { useBudgetStatus } from '../../api/policies';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Panel } from '../../components/ui/Layout';
import { DecisionPill } from '../../components/ui/StatusPill';
import { formatDateTime, formatMoney } from '../../lib/format';

const TITLES = { day: 'Today', week: 'This week', month: 'This month' } as const;

function Meter({ p }: { p: BudgetPeriodStatus }) {
  const pct = p.limitMinor ? Math.min(100, Math.round((p.committedMinor / p.limitMinor) * 100)) : 0;
  const bar = pct >= 100 ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="space-y-2 px-5 py-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-slate-800">{TITLES[p.period]}</p>
        {p.limitAction && <DecisionPill decision={p.limitAction} />}
      </div>
      <p className="text-lg font-semibold tabular-nums">
        {formatMoney(p.committedMinor, p.currency)}
        {p.limitMinor !== null && (
          <span className="text-sm font-normal text-slate-500">
            {' '}
            of {formatMoney(p.limitMinor, p.currency)}
          </span>
        )}
      </p>
      {p.limitMinor !== null ? (
        <div
          className="h-2 overflow-hidden rounded-full bg-slate-100"
          role="meter"
          aria-label={`${TITLES[p.period]} spending`}
          aria-valuemin={0}
          aria-valuemax={p.limitMinor}
          aria-valuenow={p.committedMinor}
        >
          <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <p className="text-xs text-slate-500">No limit set for this period</p>
      )}
      <p className="text-xs text-slate-500">
        {p.transactionCount} purchase{p.transactionCount === 1 ? '' : 's'} · resets{' '}
        {formatDateTime(p.periodEnd)}
      </p>
    </div>
  );
}

/** Committed spend (reserved and captured, minus releases and refunds) against the active policy's limits. */
export function BudgetMeters() {
  const status = useBudgetStatus();
  if (status.isPending) return <Loading />;
  if (status.isError) return <ErrorMessage error={status.error} />;
  return (
    <Panel
      title="Spending"
      actions={
        status.data.timezone ? (
          <span className="text-xs text-slate-500">{status.data.timezone}</span>
        ) : undefined
      }
    >
      <div className="grid divide-y divide-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {status.data.periods.map((p) => (
          <Meter key={p.period} p={p} />
        ))}
      </div>
    </Panel>
  );
}
