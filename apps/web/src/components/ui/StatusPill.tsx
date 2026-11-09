type Tone = 'ok' | 'warn' | 'error' | 'neutral';

const TONES: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  error: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: 'ok',
  COMPLETED: 'ok',
  SUSPENDED: 'warn',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
  ARCHIVED: 'neutral',
  REVOKED: 'error',
};

/** Pill for any of the lifecycle statuses used across agents, keys, tasks and merchants. */
export function LifecycleStatus({ status }: { status: string }) {
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  return <StatusPill tone={STATUS_TONES[status] ?? 'neutral'}>{label}</StatusPill>;
}
