import { Link } from 'react-router';
import { useActivePolicy } from '../../api/policies';
import { BudgetMeters } from '../policies/BudgetMeters';
import { SystemStatus } from './SystemStatus';

export function OverviewPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every purchase your agents attempt is decided here: allowed, escalated to you, or blocked.
        </p>
      </header>
      <PolicyStatus />
      <BudgetMeters />
      <SystemStatus />
    </div>
  );
}

function PolicyStatus() {
  const active = useActivePolicy();
  if (active.isPending || active.isError) return null;
  return active.data ? (
    <p className="text-sm text-slate-700">
      Policy version {active.data.version} is active with {active.data.rendered.length} rule
      {active.data.rendered.length === 1 ? '' : 's'}.{' '}
      <Link to="/policies" className="underline">
        Review
      </Link>
    </p>
  ) : (
    <div
      role="status"
      className="rounded-xl bg-rose-50 px-5 py-4 text-sm text-rose-900 ring-1 ring-inset ring-rose-600/20"
    >
      <p className="font-semibold">No active spending policy — every purchase is blocked.</p>
      <Link to="/policies" className="mt-1 inline-block underline">
        Write your policy
      </Link>
    </div>
  );
}
