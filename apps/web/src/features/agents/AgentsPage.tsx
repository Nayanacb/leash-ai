import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useAgents, useCreateAgent } from '../../api/agents';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Form';
import { PageHeader, Panel, Table, Td, Th } from '../../components/ui/Layout';
import { LifecycleStatus } from '../../components/ui/StatusPill';
import { formatDateTime } from '../../lib/format';

export function AgentsPage() {
  const agents = useAgents();
  const create = useCreateAgent();
  const [name, setName] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(name.trim(), { onSuccess: () => setName('') });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Each AI agent gets its own API keys. Agents never see payment credentials."
      />

      <Panel title="Add an agent">
        <form onSubmit={submit} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Agent name">
              {(id) => (
                <Input
                  id={id}
                  required
                  maxLength={80}
                  placeholder="e.g. Office supplies assistant"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            Add agent
          </Button>
        </form>
        {create.error && (
          <div className="px-5 pb-4">
            <ErrorMessage error={create.error} />
          </div>
        )}
      </Panel>

      {agents.isPending ? (
        <Loading />
      ) : agents.isError ? (
        <ErrorMessage error={agents.error} />
      ) : agents.data.length === 0 ? (
        <EmptyState title="No agents yet">
          Add one above, then generate an API key for it.
        </EmptyState>
      ) : (
        <Panel>
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Active keys</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {agents.data.map((agent) => (
                <tr key={agent.id} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      to={`/agents/${agent.id}`}
                      className="font-medium text-slate-900 underline-offset-2 hover:underline"
                    >
                      {agent.name}
                    </Link>
                  </Td>
                  <Td>
                    <LifecycleStatus status={agent.status} />
                  </Td>
                  <Td>{agent.activeKeyCount}</Td>
                  <Td>{formatDateTime(agent.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </div>
  );
}
