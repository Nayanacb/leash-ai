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
      <SystemStatus />
    </div>
  );
}
