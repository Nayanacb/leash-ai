import {
  ActivePolicyResponseSchema,
  BudgetStatusResponseSchema,
  PolicyValidationResponseSchema,
  PolicyVersionDtoSchema,
  PolicyVersionListResponseSchema,
  SimulationResponseSchema,
  type Currency,
} from '@leash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, apiSendNoContent } from './client';

const enc = encodeURIComponent;

export function usePolicyVersions() {
  return useQuery({
    queryKey: ['policies', 'versions'],
    queryFn: ({ signal }) =>
      apiGet('/api/v1/policies/versions', PolicyVersionListResponseSchema, { signal }).then(
        (r) => r.versions,
      ),
  });
}

export function useActivePolicy() {
  return useQuery({
    queryKey: ['policies', 'active'],
    queryFn: ({ signal }) =>
      apiGet('/api/v1/policies/active', ActivePolicyResponseSchema, { signal }).then(
        (r) => r.policy,
      ),
  });
}

export function usePolicyVersion(id: string) {
  return useQuery({
    queryKey: ['policies', 'version', id],
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/policies/versions/${enc(id)}`, PolicyVersionDtoSchema, { signal }),
  });
}

export function useBudgetStatus() {
  return useQuery({
    queryKey: ['policies', 'budget'],
    queryFn: ({ signal }) =>
      apiGet('/api/v1/policies/budget-status', BudgetStatusResponseSchema, { signal }),
    refetchInterval: 30_000,
  });
}

function useInvalidatePolicies() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['policies'] });
}

export function useCompilePolicy() {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: (input: { sourceText: string; timezone: string; currency: Currency }) =>
      apiSend('POST', '/api/v1/policies/compile', input, PolicyVersionDtoSchema),
    onSuccess: invalidate,
  });
}

export function useValidatePolicy() {
  return useMutation({
    mutationFn: (compiledRules: unknown) =>
      apiSend(
        'POST',
        '/api/v1/policies/validate',
        { compiledRules },
        PolicyValidationResponseSchema,
      ),
  });
}

export function useUpdateDraft(id: string) {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: (compiledRules: unknown) =>
      apiSend(
        'PATCH',
        `/api/v1/policies/versions/${enc(id)}`,
        { compiledRules },
        PolicyVersionDtoSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useConfirmPolicy(id: string) {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: (input: { rulesHash: string; acknowledgeUnmapped: boolean; password: string }) =>
      apiSend(
        'POST',
        `/api/v1/policies/versions/${enc(id)}/confirm`,
        input,
        PolicyVersionDtoSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useRejectDraft(id: string) {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        `/api/v1/policies/versions/${enc(id)}/reject`,
        undefined,
        PolicyVersionDtoSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useDuplicateVersion() {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: (id: string) =>
      apiSend(
        'POST',
        `/api/v1/policies/versions/${enc(id)}/duplicate`,
        undefined,
        PolicyVersionDtoSchema,
      ),
    onSuccess: invalidate,
  });
}

export function usePauseSpending() {
  const invalidate = useInvalidatePolicies();
  return useMutation({
    mutationFn: (password: string) =>
      apiSendNoContent('POST', '/api/v1/policies/pause', { password }),
    onSuccess: invalidate,
  });
}

export function useSimulatePurchase() {
  return useMutation({
    mutationFn: (input: {
      policyVersionId?: string;
      taskId: string;
      merchantId: string;
      amount: { currency: Currency; value: string };
    }) => apiSend('POST', '/api/v1/policies/simulate', input, SimulationResponseSchema),
  });
}
