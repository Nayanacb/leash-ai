import type { Decision } from '@leash/shared';
import { describe, expect, it } from 'vitest';
import { combineDecision } from '../../src/modules/authorization/combiner.js';
import type { AiSignals } from '../../src/modules/authorization/signals.js';

const RANK: Record<Decision, number> = { ALLOW: 0, ESCALATE: 1, BLOCK: 2 };
const policy = (decision: Decision, reasonCodes: string[] = []) => ({ decision, reasonCodes });

const clean: AiSignals = {
  heuristics: { severity: 'none' },
  injection: { status: 'ok', verdict: 'clean', confidence: 0.99 },
  intent: { status: 'ok', verdict: 'match', confidence: 0.95 },
};
const withSignals = (o: Partial<AiSignals>): AiSignals => ({ ...clean, ...o });

describe('combineDecision — the decision table', () => {
  it('allows only when the policy allows and every AI layer is clean', () => {
    expect(combineDecision(policy('ALLOW'), clean)).toEqual({ decision: 'ALLOW', reasonCodes: [] });
  });

  it.each([
    [
      'high-severity heuristic hit',
      withSignals({ heuristics: { severity: 'high' } }),
      'BLOCK',
      'INJECTION_DETECTED',
    ],
    [
      'medium heuristic hit',
      withSignals({ heuristics: { severity: 'medium' } }),
      'ESCALATE',
      'INJECTION_SUSPECTED',
    ],
    [
      'low heuristic hit (recorded only)',
      withSignals({ heuristics: { severity: 'low' } }),
      'ALLOW',
      null,
    ],
    [
      'malicious at the threshold',
      withSignals({ injection: { status: 'ok', verdict: 'malicious', confidence: 0.8 } }),
      'BLOCK',
      'INJECTION_DETECTED',
    ],
    [
      'malicious below the threshold',
      withSignals({ injection: { status: 'ok', verdict: 'malicious', confidence: 0.79 } }),
      'ESCALATE',
      'INJECTION_SUSPECTED',
    ],
    [
      'suspicious',
      withSignals({ injection: { status: 'ok', verdict: 'suspicious', confidence: 1 } }),
      'ESCALATE',
      'INJECTION_SUSPECTED',
    ],
    [
      'classifier error',
      withSignals({ injection: { status: 'error', error: 'timeout' } }),
      'ESCALATE',
      'AI_UNAVAILABLE',
    ],
    [
      'classifier not configured',
      withSignals({ injection: { status: 'unavailable', error: 'not configured' } }),
      'ESCALATE',
      'AI_UNAVAILABLE',
    ],
    [
      'intent mismatch at the threshold',
      withSignals({ intent: { status: 'ok', verdict: 'mismatch', confidence: 0.8 } }),
      'BLOCK',
      'INTENT_MISMATCH',
    ],
    [
      'intent mismatch below the threshold',
      withSignals({ intent: { status: 'ok', verdict: 'mismatch', confidence: 0.5 } }),
      'ESCALATE',
      'INTENT_UNCERTAIN',
    ],
    [
      'intent partial',
      withSignals({ intent: { status: 'ok', verdict: 'partial', confidence: 0.9 } }),
      'ESCALATE',
      'INTENT_UNCERTAIN',
    ],
    [
      'intent uncertain',
      withSignals({ intent: { status: 'ok', verdict: 'uncertain', confidence: 0.9 } }),
      'ESCALATE',
      'INTENT_UNCERTAIN',
    ],
    [
      'intent error',
      withSignals({ intent: { status: 'error', error: 'refused' } }),
      'ESCALATE',
      'AI_UNAVAILABLE',
    ],
  ] as const)('%s', (_name, signals, decision, reason) => {
    const result = combineDecision(policy('ALLOW'), signals);
    expect(result.decision).toBe(decision);
    if (reason) expect(result.reasonCodes).toContain(reason);
    else expect(result.reasonCodes).toEqual([]);
  });

  it('fails closed on missing or malformed signals', () => {
    for (const bad of [
      undefined,
      null,
      {},
      { heuristics: {} },
      { ...clean, injection: { status: 'ok', verdict: 'clean', confidence: 7 } },
      'clean',
    ]) {
      expect(combineDecision(policy('ALLOW'), bad)).toMatchObject({
        decision: 'ESCALATE',
        reasonCodes: ['AI_SIGNALS_INVALID'],
      });
    }
  });

  it('keeps policy reasons first, then AI reasons, without duplicates', () => {
    const result = combineDecision(
      policy('ESCALATE', ['NEW_MERCHANT']),
      withSignals({
        injection: { status: 'error', error: 'x' },
        intent: { status: 'error', error: 'y' },
      }),
    );
    expect(result).toEqual({
      decision: 'ESCALATE',
      reasonCodes: ['NEW_MERCHANT', 'AI_UNAVAILABLE'],
    });
  });
});

describe('combineDecision — AI can never make a decision less restrictive', () => {
  const heuristics = ['none', 'low', 'medium', 'high'] as const;
  const injections: AiSignals['injection'][] = [
    { status: 'ok', verdict: 'clean', confidence: 1 },
    { status: 'ok', verdict: 'suspicious', confidence: 0.5 },
    { status: 'ok', verdict: 'malicious', confidence: 0.5 },
    { status: 'ok', verdict: 'malicious', confidence: 0.95 },
    { status: 'error', error: 'x' },
    { status: 'unavailable', error: 'x' },
  ];
  const intents: AiSignals['intent'][] = [
    { status: 'ok', verdict: 'match', confidence: 1 },
    { status: 'ok', verdict: 'partial', confidence: 0.9 },
    { status: 'ok', verdict: 'uncertain', confidence: 0.9 },
    { status: 'ok', verdict: 'mismatch', confidence: 0.3 },
    { status: 'ok', verdict: 'mismatch', confidence: 0.99 },
    { status: 'error', error: 'x' },
    { status: 'unavailable', error: 'x' },
  ];

  it('holds for every combination of policy decision and AI signals', () => {
    let checked = 0;
    for (const p of ['ALLOW', 'ESCALATE', 'BLOCK'] as const) {
      for (const h of heuristics) {
        for (const injection of injections) {
          for (const intent of intents) {
            const result = combineDecision(policy(p, [`P_${p}`]), {
              heuristics: { severity: h },
              injection,
              intent,
            });
            expect(RANK[result.decision]).toBeGreaterThanOrEqual(RANK[p]);
            // Policy reasons are always preserved.
            expect(result.reasonCodes[0]).toBe(`P_${p}`);
            // ALLOW only if the policy allowed and nothing flagged.
            if (result.decision === 'ALLOW') {
              expect(p).toBe('ALLOW');
              expect(injection).toMatchObject({ verdict: 'clean' });
              expect(intent).toMatchObject({ verdict: 'match' });
              expect(['none', 'low']).toContain(h);
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(3 * 4 * 6 * 7);
  });
});
