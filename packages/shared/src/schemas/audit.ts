import { z } from 'zod';
import { ActorTypeSchema } from '../enums.js';

export const AuditEventDtoSchema = z.object({
  id: z.uuid(),
  /** Position in the global chain (bigint, serialized as a string). */
  seq: z.string(),
  actorType: ActorTypeSchema,
  actorId: z.string().nullable(),
  action: z.string(),
  transactionId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
  createdAt: z.string(),
});
export type AuditEventDto = z.infer<typeof AuditEventDtoSchema>;

export const AuditListQuerySchema = z.object({
  /** Return events with seq lower than this (pagination cursor). */
  before: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z
    .string()
    .regex(/^[a-z_.]{1,64}$/)
    .optional(),
});

export const AuditListResponseSchema = z.object({
  events: z.array(AuditEventDtoSchema),
  nextBefore: z.string().nullable(),
});
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;

export const AuditVerifyResponseSchema = z.object({
  valid: z.boolean(),
  verifiedAt: z.string(),
});
export type AuditVerifyResponse = z.infer<typeof AuditVerifyResponseSchema>;
