/**
 * Live check of the policy compiler against the real Anthropic API.
 *
 *   npm run llm:smoke -w @leash/server
 *
 * Sends ONE compile request with the configured model (LLM_MODEL_POLICY_COMPILER)
 * using a fixed sample policy and synthetic merchants — no user data. Validates
 * the response with the same code the app uses and prints a pass/fail report.
 * Never prints the API key. Exit codes: 0 = pass, 1 = fail, 2 = not configured.
 */
import 'dotenv/config';
import { renderPolicy } from '@leash/shared';
import { ConfigError, parseConfig } from '../src/config/env.js';
import { policyCompilerFromConfig } from '../src/llm/index.js';
import { PolicyCompilerError } from '../src/modules/policies/compiler.js';
import { validatePolicyDocument } from '../src/modules/policies/validation.js';

const CABLE_CO = '00000000-0000-4000-8000-00000000c0c0';
const PAPER = '00000000-0000-4000-8000-0000000000aa';
const SAMPLE = [
  'Never spend more than $50 on a single purchase.',
  'Keep total spending under $200 per week.',
  'Ask me before buying from Cable Co.',
  'Prefer eco-friendly brands.',
].join('\n');

function line(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function main(): Promise<number> {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : String(err));
    return 2;
  }
  console.log(`API key:        ${config.llm.apiKey ? 'set (value not shown)' : 'NOT SET'}`);
  console.log(`Compiler model: ${config.llm.policyCompilerModel ?? 'NOT SET'}`);
  console.log(`Effort:         ${config.llm.policyCompilerEffort ?? '(not sent)'}`);
  const compiler = policyCompilerFromConfig(config);
  if (!compiler) {
    console.log(
      '\nNot configured: set ANTHROPIC_API_KEY and LLM_MODEL_POLICY_COMPILER in apps/server/.env.',
    );
    return 2;
  }

  console.log('\nSending one compile request…');
  const started = Date.now();
  let output;
  try {
    output = await compiler.compile({
      sourceText: SAMPLE,
      defaultCurrency: 'USD',
      defaultTimezone: 'Europe/London',
      merchants: [
        { id: CABLE_CO, displayName: 'Cable Co', category: 'electronics' },
        { id: PAPER, displayName: 'Paper Planet', category: 'office_supplies' },
      ],
    });
  } catch (err) {
    if (err instanceof PolicyCompilerError) {
      line(false, 'API request', `${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const ms = Date.now() - started;
  line(
    true,
    'API accepted the request and its structured-output schema',
    `${ms} ms, model reported: ${output.model}`,
  );

  const result = validatePolicyDocument(output.policy, new Set([CABLE_CO, PAPER]));
  if (!result.valid) {
    line(false, 'Output passes strict DSL validation', JSON.stringify(result.errors));
    return 1;
  }
  line(true, 'Output passes strict DSL validation');
  const rules = result.document.rules;

  const checks = [
    line(
      rules.some(
        (r) =>
          r.type === 'max_amount_per_transaction' && r.amountMinor === 5000 && r.action === 'BLOCK',
      ),
      '"$50 per purchase" → max_amount_per_transaction 5000, BLOCK',
    ),
    line(
      rules.some(
        (r) => r.type === 'max_spend_per_period' && r.period === 'week' && r.amountMinor === 20000,
      ),
      '"$200 per week" → max_spend_per_period week 20000',
    ),
    line(
      rules.some(
        (r) => r.action === 'ESCALATE' && 'merchantIds' in r && r.merchantIds.includes(CABLE_CO),
      ),
      '"Ask me before Cable Co" → ESCALATE rule referencing the Cable Co ID',
    ),
    line(
      output.unmappedClauses.length > 0,
      'Non-spending clause reported as unmapped',
      `${output.unmappedClauses.length} clause(s)`,
    ),
    line(
      result.document.timezone === 'Europe/London' && result.document.currency === 'USD',
      'Defaults respected',
    ),
  ];

  console.log('\nRendered (deterministic) summary:');
  for (const r of renderPolicy(result.document, {
    merchantNames: { [CABLE_CO]: 'Cable Co', [PAPER]: 'Paper Planet' },
  })) {
    console.log(`  [${r.action}] ${r.text}`);
  }
  for (const c of output.unmappedClauses) console.log(`  (unmapped) "${c.text}" — ${c.reason}`);
  for (const a of output.assumptions) console.log(`  (assumption) ${a}`);

  const passed = checks.filter(Boolean).length;
  console.log(
    `\n${passed}/${checks.length} interpretation checks passed (these depend on the model; the format checks above are what must pass).`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
