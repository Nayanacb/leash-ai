import {
  TaskDtoSchema,
  TaskListResponseSchema,
  type CreateTaskInput,
  type TaskStatus,
} from '@leash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './client';

export function useTasks(status?: TaskStatus) {
  return useQuery({
    queryKey: ['tasks', { status }],
    queryFn: ({ signal }) =>
      apiGet(`/api/v1/tasks${status ? `?status=${status}` : ''}`, TaskListResponseSchema, {
        signal,
      }).then((r) => r.tasks),
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => apiSend('POST', '/api/v1/tasks', input, TaskDtoSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

export function useFinishTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: 'cancel' | 'complete' }) =>
      apiSend(
        'POST',
        `/api/v1/tasks/${encodeURIComponent(id)}/${outcome}`,
        undefined,
        TaskDtoSchema,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
