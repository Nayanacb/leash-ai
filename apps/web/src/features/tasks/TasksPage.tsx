import {
  CURRENCY_EXPONENTS,
  MAX_TASK_DURATION_DAYS,
  type Currency,
  type TaskDto,
  type TaskStatus,
} from '@leash/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useAgents } from '../../api/agents';
import { useMerchants } from '../../api/merchants';
import { useCreateTask, useFinishTask, useTasks } from '../../api/tasks';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Form';
import { PageHeader } from '../../components/ui/Layout';
import { LifecycleStatus } from '../../components/ui/StatusPill';
import { formatDateTime, formatMoney, toDateTimeLocal } from '../../lib/format';

const FILTERS: { label: string; value: TaskStatus | undefined }[] = [
  { label: 'All', value: undefined },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Expired', value: 'EXPIRED' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

export function TasksPage() {
  const [filter, setFilter] = useState<TaskStatus | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const tasks = useTasks(filter);
  const finish = useFinishTask();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Mandates you give your agents. Every purchase will be checked against the instruction, budget, merchants and expiry here. Agents can read their tasks but never create or change them."
        actions={<Button onClick={() => setCreating(true)}>New task</Button>}
      />

      <div role="tablist" aria-label="Filter tasks" className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            role="tab"
            aria-selected={filter === f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              filter === f.value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ErrorMessage error={finish.error} />

      {tasks.isPending ? (
        <Loading />
      ) : tasks.isError ? (
        <ErrorMessage error={tasks.error} />
      ) : tasks.data.length === 0 ? (
        <EmptyState title="No tasks here">
          Create a task to give an agent something to buy.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {tasks.data.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              busy={finish.isPending}
              onFinish={(outcome) => finish.mutate({ id: task.id, outcome })}
            />
          ))}
        </ul>
      )}

      {creating && <CreateTaskDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function TaskCard({
  task,
  busy,
  onFinish,
}: {
  task: TaskDto;
  busy: boolean;
  onFinish: (o: 'cancel' | 'complete') => void;
}) {
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-slate-900">
          {task.instruction}
        </p>
        <LifecycleStatus status={task.status} />
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-slate-500">Budget</dt>
          <dd className="font-medium">{formatMoney(task.budgetMinor, task.currency)}</dd>
          <dd className="text-xs text-slate-500">
            {formatMoney(task.remainingMinor, task.currency)} remaining
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Agent</dt>
          <dd>
            <Link to={`/agents/${task.agent.id}`} className="underline-offset-2 hover:underline">
              {task.agent.name}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Allowed merchants</dt>
          <dd>
            {task.allowedMerchants.map((m) => (
              <span
                key={m.id}
                className={`block ${m.archived ? 'text-slate-400 line-through' : ''}`}
              >
                {m.displayName}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Expires</dt>
          <dd>{formatDateTime(task.expiresAt)}</dd>
        </div>
      </dl>
      {task.status === 'ACTIVE' && (
        <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onFinish('complete')}
          >
            Mark complete
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              window.confirm(
                'Cancel this task? The agent will no longer be able to buy against it.',
              ) && onFinish('cancel')
            }
          >
            Cancel task
          </Button>
        </div>
      )}
    </li>
  );
}

function CreateTaskDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateTask();
  const agents = useAgents();
  const merchants = useMerchants(false);
  const assignable = (agents.data ?? []).filter((a) => a.status !== 'REVOKED');

  const [instruction, setInstruction] = useState('');
  const [agentId, setAgentId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [merchantIds, setMerchantIds] = useState<string[]>([]);
  // Captured once when the dialog opens, so rendering stays pure.
  const [openedAt] = useState(() => Date.now());
  const [expiresAt, setExpiresAt] = useState(() =>
    toDateTimeLocal(new Date(openedAt + 7 * 86_400_000)),
  );
  const minExpiry = toDateTimeLocal(new Date(openedAt));
  const maxExpiry = toDateTimeLocal(new Date(openedAt + MAX_TASK_DURATION_DAYS * 86_400_000));

  function toggleMerchant(id: string) {
    setMerchantIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        instruction,
        agentId: agentId || assignable[0]?.id || '',
        budget: { currency, value: amount.trim() },
        allowedMerchantIds: merchantIds,
        expiresAt: new Date(expiresAt).toISOString(),
      },
      { onSuccess: onClose },
    );
  }

  const ready = !agents.isPending && !merchants.isPending;
  const missing = ready && (assignable.length === 0 || (merchants.data ?? []).length === 0);

  return (
    <Dialog open onClose={onClose} title="New task">
      {!ready ? (
        <Loading />
      ) : missing ? (
        <div className="space-y-4 text-sm text-slate-700">
          <p>A task needs at least one agent and one merchant.</p>
          <div className="flex gap-3">
            <Link to="/agents" className="font-medium underline">
              Add an agent
            </Link>
            <Link to="/merchants" className="font-medium underline">
              Add a merchant
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <ErrorMessage error={create.error} />
          <Field
            label="Instruction"
            hint="Write it as you would to a person. Purchases are checked against it."
          >
            {(id) => (
              <Textarea
                id={id}
                required
                rows={3}
                maxLength={2000}
                placeholder="Buy a 2 m USB-C cable for the office, under $20"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            )}
          </Field>
          <Field label="Agent">
            {(id) => (
              <Select
                id={id}
                value={agentId || assignable[0]?.id}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {assignable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.status === 'SUSPENDED' ? ' (suspended)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Budget">
              {(id) => (
                <Input
                  id={id}
                  required
                  inputMode="decimal"
                  placeholder="20.00"
                  pattern={
                    CURRENCY_EXPONENTS[currency] === 0
                      ? '\\d+'
                      : `\\d+(\\.\\d{1,${CURRENCY_EXPONENTS[currency]}})?`
                  }
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              )}
            </Field>
            <Field label="Currency">
              {(id) => (
                <Select
                  id={id}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as Currency)}
                >
                  {(Object.keys(CURRENCY_EXPONENTS) as Currency[]).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-slate-800">Allowed merchants</legend>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md p-2 ring-1 ring-inset ring-slate-300">
              {(merchants.data ?? []).map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={merchantIds.includes(m.id)}
                    onChange={() => toggleMerchant(m.id)}
                  />
                  {m.displayName}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Expires" hint={`Up to ${MAX_TASK_DURATION_DAYS} days from now.`}>
            {(id) => (
              <Input
                id={id}
                type="datetime-local"
                required
                min={minExpiry}
                max={maxExpiry}
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || merchantIds.length === 0}>
              Create task
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
