import { z } from 'zod';

/**
 * The contract between the advisory AI evaluation pipeline and the
 * deterministic combiner. The pipeline produces this value; the combiner only
 * reads it. It lives here (authorization) so the dependency points from the
 * AI code to the authorization code, never the other way round.
 */

export const HeuristicSeveritySchema = z.enum(['none', 'low', 'medium', 'high']);
export type HeuristicSeverity = z.infer<typeof HeuristicSeveritySchema>;

export const InjectionClassifierSignalSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    verdict: z.enum(['clean', 'suspicious', 'malicious']),
    confidence: z.number().min(0).max(1),
  }),
  /** Not configured, timed out, refused, or returned invalid output. Always fails closed. */
  z.object({ status: z.enum(['error', 'unavailable']), error: z.string() }),
  /**
   * Not run because a deterministic high-severity finding already blocks the
   * purchase. The combiner honours this ONLY alongside a high heuristic
   * finding; anywhere else it is treated as unavailable (escalate).
   */
  z.object({ status: z.literal('skipped'), reason: z.string() }),
]);

export const IntentSignalSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    verdict: z.enum(['match', 'partial', 'mismatch', 'uncertain']),
    confidence: z.number().min(0).max(1),
  }),
  z.object({ status: z.enum(['error', 'unavailable']), error: z.string() }),
  z.object({ status: z.literal('skipped'), reason: z.string() }),
]);

export const AiSignalsSchema = z.object({
  heuristics: z.object({ severity: HeuristicSeveritySchema }),
  injection: InjectionClassifierSignalSchema,
  intent: IntentSignalSchema,
});
export type AiSignals = z.infer<typeof AiSignalsSchema>;
