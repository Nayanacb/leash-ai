import type { Decision } from '@leash/shared';
import type { PolicyEvaluation } from './policyEngine.js';
import { AiSignalsSchema, type AiSignals } from './signals.js';

/**
 * Deterministic decision combiner: policy result + AI signals → final decision.
 *
 * Invariant (tested exhaustively): the result is never less restrictive than
 * the policy decision. AI signals can only escalate or block; a clean AI
 * result never upgrades ESCALATE to ALLOW or BLOCK to anything. Missing,
 * failed or malformed AI signals escalate (fail closed).
 */

/** Confidence at or above which a "malicious" / "mismatch" verdict blocks rather than escalates. */
export const BLOCK_CONFIDENCE = 0.8;

const RANK: Record<Decision, number> = { ALLOW: 0, ESCALATE: 1, BLOCK: 2 };

export interface CombinedDecision {
  decision: Decision;
  /** Internal reason codes (policy codes first, then AI codes). */
  reasonCodes: string[];
}

export function combineDecision(
  policy: Pick<PolicyEvaluation, 'decision' | 'reasonCodes'>,
  rawSignals: unknown,
): CombinedDecision {
  const block: string[] = [];
  const escalate: string[] = [];

  const parsed = AiSignalsSchema.safeParse(rawSignals);
  if (!parsed.success) {
    escalate.push('AI_SIGNALS_INVALID');
  } else {
    const signals: AiSignals = parsed.data;

    if (signals.heuristics.severity === 'high') block.push('INJECTION_DETECTED');
    else if (signals.heuristics.severity === 'medium') escalate.push('INJECTION_SUSPECTED');

    const inj = signals.injection;
    if (inj.status === 'ok') {
      if (inj.verdict === 'malicious' && inj.confidence >= BLOCK_CONFIDENCE)
        block.push('INJECTION_DETECTED');
      else if (inj.verdict !== 'clean') escalate.push('INJECTION_SUSPECTED');
    } else {
      escalate.push('AI_UNAVAILABLE');
    }

    const intent = signals.intent;
    if (intent.status === 'ok') {
      if (intent.verdict === 'mismatch' && intent.confidence >= BLOCK_CONFIDENCE)
        block.push('INTENT_MISMATCH');
      else if (intent.verdict !== 'match') escalate.push('INTENT_UNCERTAIN');
    } else {
      escalate.push('AI_UNAVAILABLE');
    }
  }

  const aiDecision: Decision =
    block.length > 0 ? 'BLOCK' : escalate.length > 0 ? 'ESCALATE' : 'ALLOW';
  // Never less restrictive than the policy.
  const decision: Decision =
    RANK[aiDecision] > RANK[policy.decision] ? aiDecision : policy.decision;
  const reasonCodes = [...new Set([...policy.reasonCodes, ...block, ...escalate])];
  return { decision, reasonCodes };
}
