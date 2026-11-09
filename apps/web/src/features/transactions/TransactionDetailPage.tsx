import type { TransactionDetailDto } from '@leash/shared';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { useCancelTransaction, useTransaction } from '../../api/transactions';
import { Button } from '../../components/ui/Button';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { PageHeader, Panel, Table, Td, Th } from '../../components/ui/Layout';
import { DecisionPill, LifecycleStatus, StatusPill } from '../../components/ui/StatusPill';
import { formatDateTime, formatMoney, humanize } from '../../lib/format';

const CANCELLABLE = new Set(['EVALUATING', 'PENDING_APPROVAL', 'AUTHORIZED']);

// Evaluation details are free-form JSON: parse defensively for display.
const PolicyDetails = z
  .object({
    results: z.array(
      z.object({
        ruleId: z.string(),
        builtIn: z.boolean(),
        matched: z.boolean(),
        action: z.string(),
        reasonCode: z.string(),
        detail: z.string(),
      }),
    ),
  })
  .catch({ results: [] });
const InjectionDetails = z
  .object({
    heuristics: z
      .object({
        severity: z.string(),
        findings: z.array(
          z.object({
            source: z.string(),
            rule: z.string(),
            severity: z.string(),
            excerpt: z.string(),
          }),
        ),
      })
      .catch({ severity: 'none', findings: [] }),
    classifier: z
      .object({
        verdict: z.string(),
        confidence: z.number(),
        findings: z.array(
          z.object({ source: z.string(), excerpt: z.string(), reason: z.string() }),
        ),
      })
      .nullable()
      .catch(null),
  })
  .catch({ heuristics: { severity: 'none', findings: [] }, classifier: null });
const IntentDetails = z
  .object({ verdict: z.string(), confidence: z.number(), reasons: z.array(z.string()) })
  .nullable()
  .catch(null);

const VERDICT_TONE = { PASS: 'ok', ESCALATE: 'warn', BLOCK: 'error', ERROR: 'neutral' } as const;

export function TransactionDetailPage() {
  const { id = '' } = useParams();
  const tx = useTransaction(id);
  if (tx.isPending) return <Loading />;
  if (tx.isError) return <ErrorMessage error={tx.error} />;
  return <TransactionDetail t={tx.data} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-2.5 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="min-w-0 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

/** Agent-supplied text: always plain text, never links or markup. */
function Untrusted({ children }: { children: string }) {
  return (
    <span className="whitespace-pre-wrap break-words font-mono text-xs text-slate-800">
      {children}
    </span>
  );
}

function TransactionDetail({ t }: { t: TransactionDetailDto }) {
  const cancel = useCancelTransaction(t.id);
  const evaluation = (layer: string) => t.evaluations.find((e) => e.layer === layer);
  const policy = evaluation('POLICY');
  const injection = evaluation('INJECTION');
  const intent = evaluation('INTENT');
  const policyResults = PolicyDetails.parse(policy?.details).results.filter((r) => r.matched);
  const injectionDetails = InjectionDetails.parse(injection?.details);
  const intentDetails = IntentDetails.parse(intent?.details);

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link to="/transactions" className="text-slate-600 hover:text-slate-900">
          ← Transactions
        </Link>
      </p>
      <PageHeader
        title={formatMoney(t.amountMinor, t.currency)}
        description={`${t.merchant?.displayName ?? 'Unknown merchant'} · requested ${formatDateTime(t.createdAt)} by ${t.agent.name}`}
        actions={
          <div className="flex items-center gap-2">
            {t.decision && <DecisionPill decision={t.decision} />}
            <LifecycleStatus status={t.status} />
          </div>
        }
      />

      {t.status === 'PENDING_APPROVAL' && t.approval && (
        <div
          role="status"
          className="rounded-xl bg-amber-50 px-5 py-4 text-sm text-amber-950 ring-1 ring-inset ring-amber-600/20"
        >
          <p className="font-semibold">Waiting for your approval</p>
          <p className="mt-1">
            {formatMoney(t.heldMinor, t.currency)} is held until{' '}
            {formatDateTime(t.approval.expiresAt)}. If nobody approves it by then, it expires and
            the funds are released. Approve/reject arrives in a later release; you can cancel it
            now.
          </p>
        </div>
      )}

      {CANCELLABLE.has(t.status) && (
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            disabled={cancel.isPending}
            onClick={() =>
              window.confirm('Cancel this purchase and release the held funds?') && cancel.mutate()
            }
          >
            Cancel purchase
          </Button>
          <ErrorMessage error={cancel.error} />
        </div>
      )}

      <Panel title="Summary">
        <dl className="divide-y divide-slate-100">
          <Row label="Your instruction (task)">
            <span className="whitespace-pre-wrap">{t.task.instruction}</span>{' '}
            <span className="text-xs text-slate-500">
              (budget {formatMoney(t.task.budgetMinor, t.task.currency)})
            </span>
          </Row>
          <Row label="Merchant">
            {t.merchantDetail ? (
              <>
                {t.merchantDetail.displayName}{' '}
                <span className="text-slate-500">· pays {t.merchantDetail.paypalEmail}</span>
                {t.merchantDetail.archived && (
                  <span className="ml-2 text-xs text-slate-500">(archived)</span>
                )}
              </>
            ) : (
              '—'
            )}
          </Row>
          <Row label="Funds held now">{formatMoney(t.heldMinor, t.currency)}</Row>
          <Row label="Policy version">
            {t.policyVersion ? `v${t.policyVersion}` : 'none active'}
          </Row>
          {t.authorizationExpiresAt && t.status === 'AUTHORIZED' && (
            <Row label="Authorization expires">{formatDateTime(t.authorizationExpiresAt)}</Row>
          )}
          <Row label="Reasons (internal)">
            {t.reasonCodes.length ? (
              <span className="font-mono text-xs">{t.reasonCodes.join(', ')}</span>
            ) : (
              <span className="text-slate-500">none</span>
            )}
          </Row>
        </dl>
      </Panel>

      <section className="rounded-xl border-2 border-dashed border-amber-300 bg-amber-50/40">
        <h2 className="border-b border-amber-200 px-5 py-3 text-sm font-semibold text-amber-950">
          Untrusted — written by the agent
        </h2>
        <p className="px-5 pt-3 text-xs text-amber-900">
          Everything in this box came from the agent and may have been manipulated by content it
          read. Leash never follows it.
        </p>
        <dl className="divide-y divide-amber-100">
          <Row label="Item">
            <Untrusted>{t.itemDescription}</Untrusted>{' '}
            <span className="text-xs text-slate-500">× {t.quantity}</span>
          </Row>
          {t.category && (
            <Row label="Category (claimed)">
              <Untrusted>{t.category}</Untrusted>
            </Row>
          )}
          <Row label="Justification">
            {t.agentJustification ? <Untrusted>{t.agentJustification}</Untrusted> : '—'}
          </Row>
          <Row label="Source context">
            {t.sourceContext.length === 0 ? (
              '—'
            ) : (
              <ul className="space-y-2">
                {t.sourceContext.map((item, i) => (
                  <li key={i}>
                    <details>
                      <summary className="cursor-pointer text-sm">
                        [{i}] {humanize(item.kind)}
                        {item.title ? ` · ${item.title}` : ''}{' '}
                        <span className="text-xs text-slate-500">
                          ({item.content.length} chars)
                        </span>
                      </summary>
                      {item.url && (
                        <p className="mt-1 text-xs text-slate-500">
                          URL (not opened by Leash): <Untrusted>{item.url}</Untrusted>
                        </p>
                      )}
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-xs ring-1 ring-inset ring-amber-200">
                        {item.content}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </dl>
      </section>

      <Panel title="How Leash decided">
        <div className="divide-y divide-slate-100">
          <Layer title="1. Spending policy (deterministic)" verdict={policy?.verdict}>
            {policyResults.length === 0 ? (
              <p className="text-sm text-slate-600">No rule matched.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {policyResults.map((r) => (
                  <li key={r.ruleId} className="flex gap-2">
                    <StatusPill tone={r.action === 'BLOCK' ? 'error' : 'warn'}>
                      {r.reasonCode}
                    </StatusPill>
                    <span className="text-slate-700">{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Layer>
          <Layer title="2. Prompt-injection check" verdict={injection?.verdict} meta={injection}>
            {injectionDetails.heuristics.findings.length > 0 && (
              <ul className="space-y-1 text-sm">
                {injectionDetails.heuristics.findings.map((f, i) => (
                  <li key={i}>
                    <StatusPill
                      tone={
                        f.severity === 'high'
                          ? 'error'
                          : f.severity === 'medium'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {f.rule}
                    </StatusPill>{' '}
                    <span className="text-xs text-slate-500">{f.source}:</span>{' '}
                    <Untrusted>{f.excerpt}</Untrusted>
                  </li>
                ))}
              </ul>
            )}
            {injectionDetails.classifier && (
              <p className="mt-2 text-sm text-slate-700">
                Classifier: <strong>{injectionDetails.classifier.verdict}</strong> (
                {Math.round(injectionDetails.classifier.confidence * 100)}%)
              </p>
            )}
            {injectionDetails.classifier?.findings.map((f, i) => (
              <p key={i} className="text-sm text-slate-700">
                <span className="text-xs text-slate-500">{f.source}:</span>{' '}
                <Untrusted>{f.excerpt}</Untrusted> — {f.reason}
              </p>
            ))}
          </Layer>
          <Layer title="3. Intent check" verdict={intent?.verdict} meta={intent}>
            {intentDetails && (
              <>
                <p className="text-sm text-slate-700">
                  <strong>{intentDetails.verdict}</strong> (
                  {Math.round(intentDetails.confidence * 100)}%)
                </p>
                <ul className="list-disc pl-5 text-sm text-slate-700">
                  {intentDetails.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}
          </Layer>
        </div>
        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          The AI checks can only make a decision stricter. If one is unavailable or fails, the
          purchase is sent to you for approval.
        </p>
      </Panel>

      <Panel title="Ledger">
        <Table>
          <thead>
            <tr>
              <Th>Entry</Th>
              <Th className="text-right">Amount</Th>
              <Th>When</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {t.ledger.length === 0 ? (
              <tr>
                <Td className="text-slate-500">Nothing was reserved.</Td>
              </tr>
            ) : (
              t.ledger.map((l, i) => (
                <tr key={i}>
                  <Td>{humanize(l.type.toLowerCase())}</Td>
                  <Td className="text-right tabular-nums">
                    {formatMoney(l.amountMinor, t.currency)}
                  </Td>
                  <Td>{formatDateTime(l.createdAt)}</Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      </Panel>

      <Panel title="Timeline">
        <ol className="divide-y divide-slate-100">
          {t.audit.map((e, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-2 px-5 py-2.5 text-sm">
              <span>
                <span className="font-mono text-xs">{e.action}</span>{' '}
                <span className="text-slate-500">· {e.actorType.toLowerCase()}</span>
              </span>
              <time className="text-xs text-slate-500">{formatDateTime(e.createdAt)}</time>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

function Layer({
  title,
  verdict,
  meta,
  children,
}: {
  title: string;
  verdict: string | undefined;
  meta?: { model: string | null; latencyMs: number | null; error: string | null } | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {verdict ? (
          <StatusPill tone={VERDICT_TONE[verdict as keyof typeof VERDICT_TONE] ?? 'neutral'}>
            {verdict === 'ERROR' ? 'Unavailable' : humanize(verdict.toLowerCase())}
          </StatusPill>
        ) : (
          <span className="text-xs text-slate-500">not run</span>
        )}
      </div>
      {children}
      {meta && (meta.model || meta.error) && (
        <p className="text-xs text-slate-500">
          {meta.model && <>model {meta.model}</>}
          {meta.latencyMs !== null && <> · {meta.latencyMs} ms</>}
          {meta.error && <> · {meta.error}</>}
        </p>
      )}
    </div>
  );
}
