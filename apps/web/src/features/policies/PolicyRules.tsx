import type { PolicyVersionDto } from '@leash/shared';
import { DecisionPill } from '../../components/ui/StatusPill';

/** The deterministic rendering of a policy: exactly what will be enforced. */
export function PolicyRules({
  policy,
}: {
  policy: Pick<PolicyVersionDto, 'rendered' | 'builtInRules'>;
}) {
  return (
    <div className="space-y-4">
      {policy.rendered.length === 0 ? (
        <p className="text-sm text-slate-600">
          No rules of your own: every purchase that passes the built-in safeguards is allowed.
        </p>
      ) : (
        <ol className="space-y-2">
          {policy.rendered.map((rule) => (
            <li key={rule.id} className="flex items-start gap-3 text-sm">
              <span className="mt-0.5 shrink-0">
                <DecisionPill decision={rule.action} />
              </span>
              <span className="text-slate-900">{rule.text}</span>
            </li>
          ))}
        </ol>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-600">Always enforced (built in)</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
          {policy.builtInRules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
