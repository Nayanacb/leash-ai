import { useHealth, useReadiness } from '../../api/health';
import { StatusPill } from '../../components/ui/StatusPill';

export function SystemStatus() {
  const health = useHealth();
  const readiness = useReadiness();

  const apiTone = health.isPending ? 'neutral' : health.isError ? 'error' : 'ok';
  const apiLabel = health.isPending ? 'Checking…' : health.isError ? 'Unreachable' : 'Online';

  const dbState = readiness.data?.checks.database;
  const dbTone = readiness.isPending ? 'neutral' : dbState === 'ok' ? 'ok' : 'error';
  const dbLabel = readiness.isPending
    ? 'Checking…'
    : dbState === 'ok'
      ? 'Connected'
      : 'Unavailable';

  return (
    <section
      aria-labelledby="system-status-heading"
      className="rounded-xl border border-slate-200 bg-white"
    >
      <h2
        id="system-status-heading"
        className="border-b border-slate-200 px-5 py-3 text-sm font-semibold"
      >
        System status
      </h2>
      <dl className="divide-y divide-slate-100">
        <Row label="API server">
          <StatusPill tone={apiTone}>{apiLabel}</StatusPill>
        </Row>
        <Row label="Database">
          <StatusPill tone={dbTone}>{dbLabel}</StatusPill>
        </Row>
        <Row label="PayPal environment">
          <StatusPill tone={health.data ? 'warn' : 'neutral'}>
            {health.data ? 'Sandbox' : '—'}
          </StatusPill>
        </Row>
        <Row label="Server version">
          <span className="font-mono text-sm text-slate-700">{health.data?.version ?? '—'}</span>
        </Row>
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
