import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** A responsive table wrapper: scrolls horizontally on narrow screens. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-5 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-5 py-3 align-top text-slate-700 ${className}`}>{children}</td>;
}
