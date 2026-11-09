import { MAX_POLICY_SOURCE_LENGTH } from '@leash/shared';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  useActivePolicy,
  useCompilePolicy,
  useDuplicateVersion,
  usePauseSpending,
  usePolicyVersions,
} from '../../api/policies';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Form';
import { PageHeader, Panel, Table, Td, Th } from '../../components/ui/Layout';
import { LifecycleStatus, StatusPill } from '../../components/ui/StatusPill';
import { formatDateTime } from '../../lib/format';
import { BudgetMeters } from './BudgetMeters';
import { PolicyRules } from './PolicyRules';

const EXAMPLE = `Never spend more than $50 on a single purchase.
Keep total spending under $200 per week and $600 per month.
Ask me before buying from a store I haven't used before.
Only buy office supplies, electronics or software.`;

export function PoliciesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Spending policy"
        description="Write your rules in plain English. Leash translates them into precise rules, shows you exactly what will be enforced, and enforces nothing until you confirm."
      />
      <ActivePolicyPanel />
      <BudgetMeters />
      <NewPolicyPanel />
      <VersionHistory />
    </div>
  );
}

function ActivePolicyPanel() {
  const active = useActivePolicy();
  const duplicate = useDuplicateVersion();
  const navigate = useNavigate();
  const [pausing, setPausing] = useState(false);

  if (active.isPending) return <Loading />;
  if (active.isError) return <ErrorMessage error={active.error} />;
  if (!active.data) {
    return (
      <div
        role="status"
        className="rounded-xl bg-rose-50 px-5 py-4 text-sm text-rose-900 ring-1 ring-inset ring-rose-600/20"
      >
        <p className="font-semibold">No active policy — every purchase is blocked.</p>
        <p className="mt-1">Write a policy below and confirm it to let your agents spend.</p>
      </div>
    );
  }
  const policy = active.data;
  return (
    <Panel
      title={`Active policy · version ${policy.version}`}
      actions={
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={duplicate.isPending}
            onClick={() =>
              duplicate.mutate(policy.id, {
                onSuccess: (d) => navigate(`/policies/versions/${d.id}`),
              })
            }
          >
            Edit as new draft
          </Button>
          <Button size="sm" variant="danger" onClick={() => setPausing(true)}>
            Pause all spending
          </Button>
        </div>
      }
    >
      <div className="space-y-3 px-5 py-4">
        <p className="text-xs text-slate-500">
          Confirmed {formatDateTime(policy.confirmedAt)} ·{' '}
          <Link to={`/policies/versions/${policy.id}`} className="underline">
            details
          </Link>
        </p>
        <PolicyRules policy={policy} />
        <ErrorMessage error={duplicate.error} />
      </div>
      {pausing && <PauseDialog onClose={() => setPausing(false)} />}
    </Panel>
  );
}

function PauseDialog({ onClose }: { onClose: () => void }) {
  const pause = usePauseSpending();
  const [password, setPassword] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    pause.mutate(password, { onSuccess: onClose });
  }
  return (
    <Dialog open onClose={onClose} title="Pause all spending">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-700">
          This deactivates your policy immediately. Every purchase by every agent will be blocked
          until you confirm a policy again (you can restore this one from the version history).
        </p>
        <ErrorMessage error={pause.error} />
        <Field label="Confirm with your password">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={pause.isPending}>
            Pause spending
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NewPolicyPanel() {
  const compile = useCompilePolicy();
  const navigate = useNavigate();
  const [text, setText] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    compile.mutate(
      {
        sourceText: text,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        currency: 'USD',
      },
      { onSuccess: (draft) => navigate(`/policies/versions/${draft.id}`) },
    );
  }

  return (
    <Panel title="Write a new policy">
      <form onSubmit={submit} className="space-y-4 px-5 py-4">
        <Field
          label="Your rules"
          hint={`Amounts in USD, periods in your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Refer to merchants by the names in your registry.`}
        >
          {(id) => (
            <Textarea
              id={id}
              rows={6}
              required
              maxLength={MAX_POLICY_SOURCE_LENGTH}
              placeholder={EXAMPLE}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <ErrorMessage error={compile.error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={compile.isPending || !text.trim()}>
            {compile.isPending ? 'Translating…' : 'Translate into rules'}
          </Button>
          {!text && (
            <Button variant="ghost" onClick={() => setText(EXAMPLE)}>
              Use an example
            </Button>
          )}
          <p className="text-xs text-slate-500">
            You will review the result before anything is enforced.
          </p>
        </div>
      </form>
    </Panel>
  );
}

function VersionHistory() {
  const versions = usePolicyVersions();
  if (versions.isPending) return <Loading />;
  if (versions.isError) return <ErrorMessage error={versions.error} />;
  if (versions.data.length === 0) return <EmptyState title="No policy versions yet" />;
  return (
    <Panel title="Version history">
      <Table>
        <thead>
          <tr>
            <Th>Version</Th>
            <Th>Status</Th>
            <Th>Rules</Th>
            <Th>Created</Th>
            <Th>Confirmed</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {versions.data.map((v) => (
            <tr key={v.id} className="hover:bg-slate-50">
              <Td>
                <Link
                  to={`/policies/versions/${v.id}`}
                  className="font-medium text-slate-900 underline-offset-2 hover:underline"
                >
                  v{v.version}
                </Link>
                {v.editedManually && (
                  <span className="ml-2">
                    <StatusPill tone="neutral">Edited</StatusPill>
                  </span>
                )}
              </Td>
              <Td>
                <LifecycleStatus status={v.status} />
              </Td>
              <Td>{v.rendered.length}</Td>
              <Td>{formatDateTime(v.createdAt)}</Td>
              <Td>{formatDateTime(v.confirmedAt)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}
