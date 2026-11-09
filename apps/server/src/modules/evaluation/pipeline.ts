import type { Verdict } from '@leash/shared';
import { BLOCK_CONFIDENCE } from '../authorization/combiner.js';
import type { AiSignals } from '../authorization/signals.js';
import {
  AiEvaluationError,
  type ClassifierOutcome,
  type IntentOutcome,
  type PurchaseEvaluators,
  type PurchaseForEvaluation,
} from './evaluators.js';
import {
  scanUntrustedText,
  type HeuristicResult,
  type UntrustedText,
} from './injection/heuristics.js';

export interface EvaluationRecord {
  layer: 'INJECTION' | 'INTENT';
  verdict: Verdict;
  confidence: number | null;
  details: Record<string, unknown>;
  model: string | null;
  promptVersion: string | null;
  latencyMs: number | null;
  error: string | null;
}

export interface AiEvaluationResult {
  signals: AiSignals;
  records: [EvaluationRecord, EvaluationRecord];
}

/** Every agent-supplied string, labelled by where it came from. */
export function untrustedTexts(input: PurchaseForEvaluation): UntrustedText[] {
  const texts: UntrustedText[] = [
    { source: 'item.description', text: input.item.description },
    { source: 'item.category', text: input.item.category ?? '' },
    { source: 'justification', text: input.justification ?? '' },
  ];
  input.sourceContext.forEach((item, i) => {
    texts.push({ source: `sourceContext[${i}].title`, text: item.title ?? '' });
    texts.push({ source: `sourceContext[${i}].url`, text: item.url ?? '' });
    texts.push({ source: `sourceContext[${i}].content`, text: item.content });
  });
  return texts;
}

type Settled<T> =
  | { ok: true; value: T; latencyMs: number }
  | { ok: false; error: string; code: string; latencyMs: number };

/** Runs one evaluator call with a hard deadline. Never throws. */
async function withDeadline<T>(
  deadlineMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<Settled<T>> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AiEvaluationError('LLM_TIMEOUT', `no answer within ${deadlineMs} ms`));
        }, deadlineMs);
      }),
    ]);
    return { ok: true, value, latencyMs: Date.now() - started };
  } catch (err) {
    const code = err instanceof AiEvaluationError ? err.code : 'LLM_UNAVAILABLE';
    const error = err instanceof AiEvaluationError ? err.message : 'unexpected evaluator error';
    return { ok: false, code, error, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function injectionVerdict(
  heuristics: HeuristicResult,
  classifier: Settled<ClassifierOutcome> | null,
): Verdict {
  const c = classifier?.ok ? classifier.value : null;
  if (
    heuristics.severity === 'high' ||
    (c?.verdict === 'malicious' && c.confidence >= BLOCK_CONFIDENCE)
  )
    return 'BLOCK';
  if (heuristics.severity === 'medium' || (c && c.verdict !== 'clean')) return 'ESCALATE';
  if (!c) return 'ERROR';
  return 'PASS';
}

function intentVerdict(intent: Settled<IntentOutcome> | null): Verdict {
  if (!intent?.ok) return 'ERROR';
  const v = intent.value;
  if (v.verdict === 'mismatch' && v.confidence >= BLOCK_CONFIDENCE) return 'BLOCK';
  return v.verdict === 'match' ? 'PASS' : 'ESCALATE';
}

/**
 * Runs the advisory layers: deterministic heuristics always, and — when
 * configured — the injection classifier and intent verifier in parallel,
 * each bounded by `deadlineMs`. Never throws; failures become signals that
 * the combiner treats as "escalate".
 */
export async function runAiEvaluation(
  evaluators: PurchaseEvaluators | null,
  input: PurchaseForEvaluation,
  options: { deadlineMs: number },
): Promise<AiEvaluationResult> {
  const heuristics = scanUntrustedText(untrustedTexts(input));

  const [classifier, intent] = evaluators
    ? await Promise.all([
        withDeadline(options.deadlineMs, (signal) => evaluators.classifyInjection(input, signal)),
        withDeadline(options.deadlineMs, (signal) => evaluators.verifyIntent(input, signal)),
      ])
    : [null, null];

  const signals: AiSignals = {
    heuristics: { severity: heuristics.severity },
    injection: !classifier
      ? { status: 'unavailable', error: 'classifier not configured' }
      : classifier.ok
        ? {
            status: 'ok',
            verdict: classifier.value.verdict,
            confidence: classifier.value.confidence,
          }
        : { status: 'error', error: `${classifier.code}: ${classifier.error}` },
    intent: !intent
      ? { status: 'unavailable', error: 'intent verifier not configured' }
      : intent.ok
        ? { status: 'ok', verdict: intent.value.verdict, confidence: intent.value.confidence }
        : { status: 'error', error: `${intent.code}: ${intent.error}` },
  };

  const injectionRecord: EvaluationRecord = {
    layer: 'INJECTION',
    verdict: injectionVerdict(heuristics, classifier),
    confidence: classifier?.ok ? classifier.value.confidence : null,
    details: {
      heuristics,
      classifier: classifier?.ok
        ? {
            verdict: classifier.value.verdict,
            confidence: classifier.value.confidence,
            findings: classifier.value.findings.slice(0, 20),
          }
        : null,
    },
    model: classifier?.ok ? classifier.value.model : null,
    promptVersion: classifier?.ok ? classifier.value.promptVersion : null,
    latencyMs: classifier?.latencyMs ?? null,
    error: !classifier
      ? 'classifier not configured'
      : classifier.ok
        ? null
        : `${classifier.code}: ${classifier.error}`,
  };
  const intentRecord: EvaluationRecord = {
    layer: 'INTENT',
    verdict: intentVerdict(intent),
    confidence: intent?.ok ? intent.value.confidence : null,
    details: intent?.ok
      ? {
          verdict: intent.value.verdict,
          confidence: intent.value.confidence,
          reasons: intent.value.reasons.slice(0, 10),
        }
      : {},
    model: intent?.ok ? intent.value.model : null,
    promptVersion: intent?.ok ? intent.value.promptVersion : null,
    latencyMs: intent?.latencyMs ?? null,
    error: !intent
      ? 'intent verifier not configured'
      : intent.ok
        ? null
        : `${intent.code}: ${intent.error}`,
  };

  return { signals, records: [injectionRecord, intentRecord] };
}
