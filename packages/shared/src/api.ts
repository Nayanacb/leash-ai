import { z } from 'zod';

/** Error envelope returned by every API error response. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('leash-server'),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  paypalEnvironment: z.literal('sandbox'),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: z.enum(['ok', 'error']),
  }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
