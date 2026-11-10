import type { AuditEventDto } from '@leash/shared';
import { useState } from 'react';
import { useAuditEvents, useVerifyAudit } from '../../api/audit';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Form';
import { PageHeader, Panel } from '../../components/ui/Layout';
import { StatusPill } from '../../components/ui/StatusPill';
import { formatDateTime } from '../../lib/format';

const FILTERS = [
  { label: 'All activity', value: '' },
  { label: 'Sign-ins & sessions', value: 'user.' },
  { label: 'Agents', value: 'agent.' },
  { label: 'API keys', value: 'agent_key.' },
  { label: 'Merchants', value: 'merchant.' },
  { label: 'Tasks', value: 'task.' },
  { label: 'Policies', value: 'policy.' },
  { label: 'Purchases', value: 'purchase.' },
];

/** Plain-language summary of an event; the full JSON is available on expand. */
function describe(event: AuditEventDto): string {
  const d = event.data as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (event.action) {
    case 'user.registered':
      return 'Account created';
    case 'user.login_succeeded':
      return 'Signed in';
    case 'user.login_failed':
      return 'Failed sign-in attempt';
    case 'user.logged_out':
      return 'Signed out';
    case 'user.logged_out_everywhere':
      return `Signed out everywhere (${String(d.sessionsEnded ?? 0)} sessions ended)`;
    case 'agent.created':
      return `Agent “${str('name')}” created`;
    case 'agent.renamed':
      return `Agent renamed from “${str('from')}” to “${str('to')}”`;
    case 'agent.suspended':
      return 'Agent suspended';
    case 'agent.reactivated':
      return 'Agent reactivated';
    case 'agent.revoked':
      return `Agent revoked (${String(d.keysRevoked ?? 0)} keys revoked)`;
    case 'agent.auth_rejected':
      return `Rejected agent request using key ${str('keyPrefix')}… (${str('reason').replaceAll('_', ' ')})`;
    case 'agent_key.created':
      return `API key ${str('keyPrefix')}… generated`;
    case 'agent_key.revoked':
      return `API key ${str('keyPrefix')}… revoked`;
    case 'merchant.created':
      return `Merchant “${str('displayName')}” registered`;
    case 'merchant.updated':
      return d.payeeChanged ? 'Merchant updated — PayPal payee changed' : 'Merchant updated';
    case 'merchant.archived':
      return 'Merchant archived';
    case 'merchant.restored':
      return 'Merchant restored';
    case 'task.created':
      return 'Task created';
    case 'task.cancelled':
      return 'Task cancelled';
    case 'task.completed':
      return 'Task completed';
    case 'user.step_up_failed':
      return 'Wrong password at a confirmation prompt';
    case 'user.step_up_succeeded':
      return 'Password confirmed for sensitive actions';
    case 'policy.draft_compiled':
      return `Policy draft v${String(d.version ?? '?')} translated from plain English`;
    case 'policy.draft_created_from_json':
      return `Policy draft v${String(d.version ?? '?')} created from JSON`;
    case 'policy.draft_edited':
      return 'Policy draft edited by hand';
    case 'policy.draft_duplicated':
      return `Policy v${String(d.fromVersion ?? '?')} copied into a new draft`;
    case 'policy.draft_rejected':
      return 'Policy draft discarded';
    case 'policy.compile_failed':
      return `Policy translation failed (${str('reason')})`;
    case 'policy.compile_rejected':
      return 'Policy translation produced invalid rules and was rejected';
    case 'policy.confirmed':
      return `Policy v${String(d.version ?? '?')} confirmed and enforced`;
    case 'policy.paused':
      return 'All spending paused (policy deactivated)';
    case 'purchase.policy_evaluated':
      return `Purchase checked against policy: ${str('policyDecision')}`;
    case 'purchase.reservation_released':
      return `Reserved funds released (${str('reason').replaceAll('_', ' ')})`;
    case 'purchase.evaluation_expired':
      return 'Purchase evaluation timed out; funds released';
    case 'purchase.decided':
      return `Purchase decided: ${str('decision')} (${str('status').toLowerCase().replaceAll('_', ' ')})`;
    case 'purchase.cancelled':
      return `Purchase cancelled by the ${event.actorType.toLowerCase()}`;
    case 'purchase.approval_expired':
      return 'Approval window passed; purchase expired and funds released';
    case 'purchase.approved':
      return 'Purchase approved by you; payment authorized';
    case 'purchase.rejected':
      return 'Purchase rejected by you; funds released';
    case 'purchase.order_created':
      return 'PayPal sandbox order created; waiting for buyer approval';
    case 'purchase.capture_started':
      return 'Buyer approval and order verified with PayPal; capturing';
    case 'purchase.captured':
      return 'Payment captured (PayPal sandbox)';
    case 'purchase.capture_pending':
      return 'PayPal is still processing the capture';
    case 'purchase.capture_uncertain':
      return 'Capture outcome unknown; will be checked with PayPal';
    case 'purchase.payment_failed':
      return `Payment failed (${str('reason').toLowerCase().replaceAll('_', ' ')}); funds released`;
    case 'purchase.payment_anomaly':
      return 'PayPal reported something that does not match this purchase';
    case 'purchase.refund_requested':
      return 'Refund requested';
    case 'purchase.refunded':
      return refundLabel(d);
    case 'purchase.refund_pending':
      return 'PayPal is still processing a refund';
    case 'purchase.refund_uncertain':
      return 'Refund outcome unknown; will be checked with PayPal';
    case 'purchase.refund_failed':
      return `Refund failed (${str('reason').toLowerCase().replaceAll('_', ' ')})`;
    case 'purchase.reversed':
      return 'Payment reversed by PayPal (chargeback or dispute); budget credited';
    case 'payment.webhook_unmatched':
      return 'PayPal sent an event for something Leash does not know; ignored';
    case 'purchase.authorization_expired':
      return 'Authorized purchase was not paid in time; funds released';
    default:
      return event.action;
  }
}

function refundLabel(d: Record<string, unknown>): string {
  return d.source === 'PAYPAL'
    ? 'Refund made outside Leash (PayPal) recorded; budget credited'
    : 'Refund completed; budget credited';
}

const WARNING_ACTIONS = new Set([
  'user.login_failed',
  'agent.auth_rejected',
  'user.step_up_failed',
  'policy.paused',
  'policy.compile_rejected',
  'purchase.evaluation_expired',
  'purchase.approval_expired',
  'purchase.payment_failed',
  'purchase.payment_anomaly',
  'purchase.capture_uncertain',
  'purchase.refund_failed',
  'purchase.refund_uncertain',
  'purchase.reversed',
]);

export function AuditPage() {
  const [filter, setFilter] = useState('');
  const events = useAuditEvents(filter || undefined);
  const verify = useVerifyAudit();
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every security-relevant action, in a tamper-evident hash chain. Entries cannot be edited or deleted."
        actions={
          <Button variant="secondary" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'Verifying…' : 'Verify integrity'}
          </Button>
        }
      />

      {verify.data && (
        <div
          role="status"
          className={`rounded-md px-4 py-3 text-sm ring-1 ring-inset ${
            verify.data.valid
              ? 'bg-emerald-50 text-emerald-800 ring-emerald-600/20'
              : 'bg-rose-50 text-rose-800 ring-rose-600/20'
          }`}
        >
          {verify.data.valid
            ? `Chain verified at ${formatDateTime(verify.data.verifiedAt)}: every entry is intact and in order.`
            : 'Integrity check FAILED: the audit chain has been altered. Contact your administrator.'}
        </div>
      )}
      <ErrorMessage error={verify.error} />

      <div className="max-w-xs">
        <Select
          aria-label="Filter events"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>

      {events.isPending ? (
        <Loading />
      ) : events.isError ? (
        <ErrorMessage error={events.error} />
      ) : rows.length === 0 ? (
        <EmptyState title="No events" />
      ) : (
        <Panel>
          <ol className="divide-y divide-slate-100">
            {rows.map((event) => (
              <AuditRow key={event.id} event={event} />
            ))}
          </ol>
          {events.hasNextPage && (
            <div className="border-t border-slate-100 px-5 py-3 text-center">
              <Button
                variant="secondary"
                size="sm"
                disabled={events.isFetchingNextPage}
                onClick={() => events.fetchNextPage()}
              >
                {events.isFetchingNextPage ? 'Loading…' : 'Load older events'}
              </Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function AuditRow({ event }: { event: AuditEventDto }) {
  const [open, setOpen] = useState(false);
  const warn = WARNING_ACTIONS.has(event.action);
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-slate-900">
          {warn && (
            <span className="mr-2">
              <StatusPill tone="warn">Security</StatusPill>
            </span>
          )}
          {describe(event)}
        </p>
        <time className="text-xs text-slate-500" dateTime={event.createdAt}>
          {formatDateTime(event.createdAt)}
        </time>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        <span className="font-mono">{event.action}</span> · by {event.actorType.toLowerCase()}
        {typeof event.data.ip === 'string' && ` · ${event.data.ip}`}
        <button
          type="button"
          className="ml-2 underline hover:text-slate-800"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? 'Hide details' : 'Details'}
        </button>
      </p>
      {open && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-slate-50 p-3 text-xs text-slate-700 ring-1 ring-inset ring-slate-200">
          {JSON.stringify(
            { ...event.data, seq: event.seq, hash: event.hash, prevHash: event.prevHash },
            null,
            2,
          )}
        </pre>
      )}
    </li>
  );
}
