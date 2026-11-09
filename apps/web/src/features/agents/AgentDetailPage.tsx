import {
  API_KEY_EXPIRY_DAYS,
  type AgentDetailDto,
  type ApiKeyDto,
  type CreatedApiKeyResponse,
} from '@leash/shared';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useAgent, useCreateApiKey, useRevokeApiKey, useUpdateAgent } from '../../api/agents';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Form';
import { PageHeader, Panel, Table, Td, Th } from '../../components/ui/Layout';
import { LifecycleStatus } from '../../components/ui/StatusPill';
import { formatDateTime, formatRelative } from '../../lib/format';

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const agent = useAgent(id);

  if (agent.isPending) return <Loading />;
  if (agent.isError) return <ErrorMessage error={agent.error} />;
  return <AgentDetail agent={agent.data} />;
}

function AgentDetail({ agent }: { agent: AgentDetailDto }) {
  const update = useUpdateAgent(agent.id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(agent.name);
  const revoked = agent.status === 'REVOKED';

  function rename(e: FormEvent) {
    e.preventDefault();
    update.mutate({ name: name.trim() }, { onSuccess: () => setRenaming(false) });
  }

  function revokeAgent() {
    if (
      window.confirm(
        `Permanently revoke “${agent.name}”? All of its API keys stop working immediately. This cannot be undone.`,
      )
    ) {
      update.mutate({ status: 'REVOKED' });
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link to="/agents" className="text-slate-600 hover:text-slate-900">
          ← Agents
        </Link>
      </p>
      <PageHeader
        title={agent.name}
        description={`Created ${formatDateTime(agent.createdAt)}`}
        actions={<LifecycleStatus status={agent.status} />}
      />
      <ErrorMessage error={update.error} />

      <Panel title="Settings">
        <div className="space-y-4 px-5 py-4">
          {renaming ? (
            <form onSubmit={rename} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label="Name">
                  {(fid) => (
                    <Input
                      id={fid}
                      required
                      maxLength={80}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={update.isPending || !name.trim()}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={revoked} onClick={() => setRenaming(true)}>
                Rename
              </Button>
              {agent.status === 'ACTIVE' && (
                <Button
                  variant="secondary"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ status: 'SUSPENDED' })}
                >
                  Suspend
                </Button>
              )}
              {agent.status === 'SUSPENDED' && (
                <Button
                  variant="secondary"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ status: 'ACTIVE' })}
                >
                  Reactivate
                </Button>
              )}
              {!revoked && (
                <Button variant="danger" disabled={update.isPending} onClick={revokeAgent}>
                  Revoke agent
                </Button>
              )}
            </div>
          )}
          <p className="text-xs text-slate-500">
            Suspending blocks every key for this agent until you reactivate it. Revoking is
            permanent.
          </p>
        </div>
      </Panel>

      <ApiKeysPanel agent={agent} />
    </div>
  );
}

function keyStatusLabel(key: ApiKeyDto) {
  return <LifecycleStatus status={key.status} />;
}

function ApiKeysPanel({ agent }: { agent: AgentDetailDto }) {
  const revoke = useRevokeApiKey(agent.id);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKeyResponse | null>(null);
  const canCreate = agent.status === 'ACTIVE';

  return (
    <Panel
      title="API keys"
      actions={
        <Button size="sm" disabled={!canCreate} onClick={() => setCreating(true)}>
          Generate key
        </Button>
      }
    >
      {!canCreate && (
        <p className="border-b border-slate-100 px-5 py-2 text-xs text-slate-500">
          Keys can only be generated for active agents.
        </p>
      )}
      <ErrorMessage error={revoke.error} />
      {agent.apiKeys.length === 0 ? (
        <div className="p-5">
          <EmptyState title="No keys yet">Generate a key and give it to this agent.</EmptyState>
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Key</Th>
              <Th>Status</Th>
              <Th>Last used</Th>
              <Th>Expires</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {agent.apiKeys.map((key) => (
              <tr key={key.id}>
                <Td>
                  <span className="font-mono text-xs">{key.prefix}…</span>
                  {key.label && <span className="block text-xs text-slate-500">{key.label}</span>}
                </Td>
                <Td>{keyStatusLabel(key)}</Td>
                <Td>{formatRelative(key.lastUsedAt)}</Td>
                <Td>
                  {key.revokedAt
                    ? `Revoked ${formatDateTime(key.revokedAt)}`
                    : formatDateTime(key.expiresAt)}
                </Td>
                <Td className="text-right">
                  {key.status === 'ACTIVE' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={revoke.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Revoke key ${key.prefix}…? Requests using it will fail immediately.`,
                          )
                        ) {
                          revoke.mutate(key.id);
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <CreateKeyDialog
        agentId={agent.id}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(result) => {
          setCreating(false);
          setCreated(result);
        }}
      />
      <RevealKeyDialog created={created} onDone={() => setCreated(null)} />
    </Panel>
  );
}

function CreateKeyDialog({
  agentId,
  open,
  onClose,
  onCreated,
}: {
  agentId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (result: CreatedApiKeyResponse) => void;
}) {
  const create = useCreateApiKey(agentId);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<number>(30);

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        expiresInDays: days as (typeof API_KEY_EXPIRY_DAYS)[number],
        ...(label.trim() ? { label: label.trim() } : {}),
      },
      {
        onSuccess: (result) => {
          setLabel('');
          create.reset();
          onCreated(result);
        },
      },
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Generate API key">
      <form onSubmit={submit} className="space-y-4">
        <ErrorMessage error={create.error} />
        <Field label="Label (optional)" hint="Where this key will be used, e.g. “staging worker”.">
          {(id) => (
            <Input
              id={id}
              maxLength={60}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          )}
        </Field>
        <Field label="Expires after">
          {(id) => (
            <Select id={id} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {API_KEY_EXPIRY_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Generate
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shows the plaintext key exactly once. It lives only in component state and is dropped on close. */
export function RevealKeyDialog({
  created,
  onDone,
}: {
  created: CreatedApiKeyResponse | null;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!created) return null;

  async function copy() {
    await navigator.clipboard?.writeText(created!.secret);
    setCopied(true);
  }

  return (
    <Dialog open title="Copy your new API key" onClose={onDone} dismissable={false}>
      <div className="space-y-4">
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20">
          This is the only time the key will be shown. Leash stores only a hash of it. Store it in
          your agent’s secret manager now.
        </p>
        <div className="flex items-stretch gap-2">
          <code
            data-testid="new-api-key"
            className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-slate-900 px-3 py-2 font-mono text-xs text-white"
          >
            {created.secret}
          </code>
          <Button variant="secondary" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-slate-500">
          Agents send it as{' '}
          <code className="font-mono">Authorization: Bearer {created.apiKey.prefix}…</code>. Expires{' '}
          {formatDateTime(created.apiKey.expiresAt)}.
        </p>
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setCopied(false);
              onDone();
            }}
          >
            I’ve stored it safely
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
