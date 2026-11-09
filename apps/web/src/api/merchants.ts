import {
  MerchantDtoSchema,
  MerchantListResponseSchema,
  type CreateMerchantInput,
  type UpdateMerchantInput,
} from '@leash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './client';

export function useMerchants(includeArchived = false) {
  return useQuery({
    queryKey: ['merchants', { includeArchived }],
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/merchants?includeArchived=${includeArchived}`, MerchantListResponseSchema, {
        signal,
      }).then((r) => r.merchants),
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['merchants'] }),
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    ]);
}

export function useCreateMerchant() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateMerchantInput) =>
      apiSend('POST', '/api/v1/merchants', input, MerchantDtoSchema),
    onSuccess: invalidate,
  });
}

export function useUpdateMerchant() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateMerchantInput }) =>
      apiSend('PATCH', `/api/v1/merchants/${encodeURIComponent(id)}`, patch, MerchantDtoSchema),
    onSuccess: invalidate,
  });
}
