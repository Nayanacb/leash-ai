import {
  ApprovalListResponseSchema,
  TransactionDetailDtoSchema,
  type ApprovalStatus,
} from '@leash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './client';

export function useApprovals(status: ApprovalStatus = 'PENDING') {
  return useQuery({
    queryKey: ['approvals', status],
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/approvals?status=${status}`, ApprovalListResponseSchema, { signal }),
    refetchInterval: 30_000,
  });
}

function useInvalidateAfterDecision() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ['approvals', 'transactions', 'policies', 'tasks'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
}

export function useApprove() {
  const invalidate = useInvalidateAfterDecision();
  return useMutation({
    mutationFn: ({
      approvalId,
      snapshotHash,
      note,
    }: {
      approvalId: string;
      snapshotHash: string;
      note?: string;
    }) =>
      apiSend(
        'POST',
        `/api/v1/approvals/${encodeURIComponent(approvalId)}/approve`,
        { snapshotHash, ...(note ? { note } : {}) },
        TransactionDetailDtoSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useReject() {
  const invalidate = useInvalidateAfterDecision();
  return useMutation({
    mutationFn: ({ approvalId, note }: { approvalId: string; note?: string }) =>
      apiSend(
        'POST',
        `/api/v1/approvals/${encodeURIComponent(approvalId)}/reject`,
        note ? { note } : {},
        TransactionDetailDtoSchema,
      ),
    onSuccess: invalidate,
  });
}
