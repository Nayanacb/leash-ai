import { MAX_POLICY_SOURCE_LENGTH } from '@leash/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMerchants } from '../../api/merchants';
import {
  useCompilePolicy,
  useCompilerStatus,
  useCreateDraftFromJson,
  useValidatePolicy,
} from '../../api/policies';
import { Button } from '../../components/ui/Button';
import { ErrorMessage } from '../../components/ui/Feedback';
import { Field, Textarea } from '../../components/ui/Form';
import { Panel } from '../../components/ui/Layout';

const EXAMPLE = `Never spend more than $50 on a single purchase.
Keep total spending under $200 per week and $600 per month.
Ask me before buying from a store I haven't used before.
Only buy office supplies, electronics or software.`;

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function jsonTemplate(): string {
  return JSON.stringify(
    {
      dslVersion: 1,
      currency: 'USD',
      timezone: browserTimeZone(),
      rules: [
        {
          id: 'max-per-purchase',
          type: 'max_amount_per_transaction',
          amountMinor: 5000,
          action: 'BLOCK',
        },
        {
          id: 'weekly-budget',
          type: 'max_spend_per_period',
          period: 'week',
          amountMinor: 20000,
          action: 'BLOCK',
        },
        { id: 'new-store', type: 'new_merchant', action: 'ESCALATE' },
      ],
    },
    null,
    2,
  );
}

type Mode = 'english' | 'json';

export function NewPolicyPanel() {
  const status = useCompilerStatus();
  const [chosen, setChosen] = useState<Mode | null>(null);
  // Default to JSON when translation isn't configured; the user can always switch.
  const mode: Mode = chosen ?? (status.data?.configured === false ? 'json' : 'english');

  return (
    <Panel title="Write a new policy">
      <div
        role="tablist"
        aria-label="How to write the policy"
        className="flex gap-1 border-b border-slate-100 px-5 pt-3"
      >
        {(
          [
            ['english', 'Plain English'],
            ['json', 'JSON'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={mode === value}
            onClick={() => setChosen(value)}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium ${
              mode === value
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'english' ? <EnglishForm configured={status.data?.configured} /> : <JsonForm />}
    </Panel>
  );
}

function EnglishForm({ configured }: { configured: boolean | undefined }) {
  const compile = useCompilePolicy();
  const navigate = useNavigate();
  const [text, setText] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    compile.mutate(
      { sourceText: text, timezone: browserTimeZone(), currency: 'USD' },
      { onSuccess: (draft) => navigate(`/policies/versions/${draft.id}`) },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 px-5 py-4">
      {configured === false && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20">
          Translation from plain English isn’t configured on this server. Use the JSON tab, or ask
          your administrator to set an Anthropic API key and compiler model.
        </p>
      )}
      <Field
        label="Your rules"
        hint={`Amounts in USD, periods in your time zone (${browserTimeZone()}). Refer to merchants by the names in your registry.`}
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
        <Button type="submit" disabled={compile.isPending || !text.trim() || configured === false}>
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
  );
}

function JsonForm() {
  const create = useCreateDraftFromJson();
  const validate = useValidatePolicy();
  const merchants = useMerchants(false);
  const navigate = useNavigate();
  const [json, setJson] = useState(jsonTemplate);
  const [description, setDescription] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  function parse(): unknown {
    try {
      setParseError(null);
      return JSON.parse(json);
    } catch (e) {
      setParseError(`Not valid JSON: ${(e as Error).message}`);
      return undefined;
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const compiledRules = parse();
    if (compiledRules === undefined) return;
    create.mutate(
      { compiledRules, ...(description.trim() ? { sourceText: description.trim() } : {}) },
      { onSuccess: (draft) => navigate(`/policies/versions/${draft.id}`) },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 px-5 py-4">
      <p className="text-sm text-slate-600">
        Write the exact rules in the Leash policy format. No AI is involved: the JSON is validated,
        shown to you as plain English, and enforced only after you confirm it.
      </p>
      <Field
        label="Policy JSON"
        hint="Amounts are integers in cents (5000 = 50.00). Actions are BLOCK or ESCALATE."
      >
        {(id) => (
          <Textarea
            id={id}
            rows={14}
            spellCheck={false}
            className="font-mono text-xs"
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              validate.reset();
            }}
          />
        )}
      </Field>
      {parseError && <p className="text-xs text-rose-600">{parseError}</p>}
      {validate.data && !validate.data.valid && (
        <ul className="list-disc pl-5 text-xs text-rose-700">
          {validate.data.errors.map((err) => (
            <li key={`${err.path}:${err.message}`}>
              <span className="font-mono">{err.path}</span>: {err.message}
            </li>
          ))}
        </ul>
      )}
      {validate.data?.valid && (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-900 ring-1 ring-inset ring-emerald-600/20">
          Valid. This would enforce:
          <ul className="mt-1 list-disc pl-5">
            {validate.data.rendered.map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
          </ul>
        </div>
      )}
      {merchants.data && merchants.data.length > 0 && (
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer">
            Your merchant IDs (for merchant_allowlist / merchant_blocklist)
          </summary>
          <ul className="mt-2 space-y-1">
            {merchants.data.map((m) => (
              <li key={m.id}>
                {m.displayName}: <span className="select-all font-mono">{m.id}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <Field label="Description (optional)" hint="Shown on the review page as “What you wrote”.">
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            maxLength={MAX_POLICY_SOURCE_LENGTH}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>
      <ErrorMessage error={validate.error ?? create.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            const value = parse();
            if (value !== undefined) validate.mutate(value);
          }}
        >
          Check
        </Button>
        <Button type="submit" disabled={create.isPending}>
          Create draft for review
        </Button>
      </div>
    </form>
  );
}
