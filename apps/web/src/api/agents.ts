import {
  AgentDetailDtoSchema,
  AgentDtoSchema,
  AgentListResponseSchema,
  ApiKeyDtoSchema,
  CreatedApiKeyResponseSchema,
  type AgentStatus,
  type CreateApiKeyInput,
} from '@leash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './client';

const keys = {
  all: ['agents'] as const,
  detail: (id: string) => ['agents', id] as const,
};

export function useAgents() {
  return useQuery({
    queryKey: keys.all,
    queryFn: ({ signal }) =>
      apiGet('/api/v1/agents', AgentListResponseSchema, { signal }).then((r) => r.agents),
  });
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/agents/${encodeURIComponent(id)}`, AgentDetailDtoSchema, { signal }),
  });
}

function useInvalidateAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: keys.all });
}

export function useCreateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (name: string) => apiSend('POST', '/api/v1/agents', { name }, AgentDtoSchema),
    onSuccess: invalidate,
  });
}

export function useUpdateAgent(id: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (patch: { name?: string; status?: AgentStatus }) =>
      apiSend('PATCH', `/api/v1/agents/${encodeURIComponent(id)}`, patch, AgentDetailDtoSchema),
    onSuccess: invalidate,
  });
}

/** The response holds the plaintext key. It is returned to the caller and deliberately not cached. */
export function useCreateApiKey(agentId: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      apiSend(
        'POST',
        `/api/v1/agents/${encodeURIComponent(agentId)}/keys`,
        input,
        CreatedApiKeyResponseSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useRevokeApiKey(agentId: string) {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: (keyId: string) =>
      apiSend(
        'DELETE',
        `/api/v1/agents/${encodeURIComponent(agentId)}/keys/${encodeURIComponent(keyId)}`,
        undefined,
        ApiKeyDtoSchema,
      ),
    onSuccess: invalidate,
  });
}
