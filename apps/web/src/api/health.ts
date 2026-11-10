import { HealthResponseSchema, ReadinessResponseSchema } from '@leash/shared';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiGet('/api/healthz', HealthResponseSchema, { signal }),
    refetchInterval: 15_000,
  });
}

export function useReadiness() {
  return useQuery({
    queryKey: ['readiness'],
    queryFn: ({ signal }) =>
      apiGet('/api/readyz', ReadinessResponseSchema, { acceptStatuses: [503], signal }),
    refetchInterval: 15_000,
  });
}
