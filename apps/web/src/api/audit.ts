import { AuditListResponseSchema, AuditVerifyResponseSchema } from '@leash/shared';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { apiGet } from './client';

export function useAuditEvents(action?: string) {
  return useInfiniteQuery({
    queryKey: ['audit', { action }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (pageParam) params.set('before', pageParam);
      if (action) params.set('action', action);
      return apiGet(`/api/v1/audit-events?${params}`, AuditListResponseSchema, { signal });
    },
    getNextPageParam: (last) => last.nextBefore,
  });
}

/** A mutation rather than a query: verification is an explicit, on-demand action. */
export function useVerifyAudit() {
  return useMutation({
    mutationFn: () => apiGet('/api/v1/audit-events/verify', AuditVerifyResponseSchema),
  });
}
