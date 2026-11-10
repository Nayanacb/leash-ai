import {
  TransactionDetailDtoSchema,
  TransactionListResponseSchema,
  type Decision,
  type TransactionStatus,
} from '@leash/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './client';

export interface TransactionFilters {
  status?: TransactionStatus | undefined;
  decision?: Decision | undefined;
}

export function useTransactions(filters: TransactionFilters) {
  return useInfiniteQuery({
    queryKey: ['transactions', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (filters.status) params.set('status', filters.status);
      if (filters.decision) params.set('decision', filters.decision);
      if (pageParam) params.set('before', pageParam);
      return apiGet(`/api/v1/transactions?${params}`, TransactionListResponseSchema, { signal });
    },
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: 15_000,
  });
}

export function useTransaction(id: string) {
  return useQuery({
    queryKey: ['transactions', 'detail', id],
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/transactions/${encodeURIComponent(id)}`, TransactionDetailDtoSchema, {
        signal,
      }),
  });
}

export function useCancelTransaction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        `/api/v1/transactions/${encodeURIComponent(id)}/cancel`,
        undefined,
        TransactionDetailDtoSchema,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['policies', 'budget'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]),
  });
}
