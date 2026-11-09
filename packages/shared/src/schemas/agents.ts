import { z } from 'zod';
import { AgentStatusSchema } from '../enums.js';
import { plainText } from './common.js';

export const CreateAgentInputSchema = z.object({
  name: plainText(1, 80),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

export const UpdateAgentInputSchema = z
  .object({
    name: plainText(1, 80).optional(),
    status: AgentStatusSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, 'Provide name or status');
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

/** API keys always expire. These are the only lifetimes offered. */
export const API_KEY_EXPIRY_DAYS = [7, 30, 90, 365] as const;
export const ApiKeyExpiryDaysSchema = z.union(API_KEY_EXPIRY_DAYS.map((d) => z.literal(d)));

export const CreateApiKeyInputSchema = z.object({
  label: plainText(1, 60).optional(),
  expiresInDays: ApiKeyExpiryDaysSchema,
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;

export const ApiKeyStatusSchema = z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']);
export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;

/** Never contains the secret or its hash. */
export const ApiKeyDtoSchema = z.object({
  id: z.uuid(),
  label: z.string().nullable(),
  prefix: z.string(),
  status: ApiKeyStatusSchema,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKeyDto = z.infer<typeof ApiKeyDtoSchema>;

/** The only response that ever contains a plaintext key. It is not retrievable again. */
export const CreatedApiKeyResponseSchema = z.object({
  apiKey: ApiKeyDtoSchema,
  secret: z.string().startsWith('lsh_'),
});
export type CreatedApiKeyResponse = z.infer<typeof CreatedApiKeyResponseSchema>;

export const AgentDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: AgentStatusSchema,
  activeKeyCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentDto = z.infer<typeof AgentDtoSchema>;

export const AgentDetailDtoSchema = AgentDtoSchema.extend({
  apiKeys: z.array(ApiKeyDtoSchema),
});
export type AgentDetailDto = z.infer<typeof AgentDetailDtoSchema>;

export const AgentListResponseSchema = z.object({ agents: z.array(AgentDtoSchema) });
