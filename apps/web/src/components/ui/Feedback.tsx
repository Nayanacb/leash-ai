import type { ReactNode } from 'react';
import { ApiRequestError } from '../../api/client';

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const apiError = error instanceof ApiRequestError ? error : null;
  const message =
    apiError?.message ?? (error instanceof Error ? error.message : 'Something went wrong');
  return (
    <div
      role="alert"
      className="rounded-md bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-inset ring-rose-600/20"
    >
      <p className="font-medium">{message}</p>
      {apiError && apiError.fieldErrors.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {apiError.fieldErrors.map((f) => (
            <li key={`${f.path}:${f.message}`}>
              {f.path ? <span className="font-mono">{f.path}</span> : null} {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="py-8 text-center text-sm text-slate-500" role="status">
      {label}
    </p>
  );
}
