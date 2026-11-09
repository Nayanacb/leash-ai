import {
  SessionResponseSchema,
  type LoginInput,
  type RegisterInput,
  type SessionResponse,
} from '@leash/shared';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiRequestError, apiGet, apiSend, apiSendNoContent, setCsrfToken } from './client';

export const SESSION_KEY = ['session'] as const;

/**
 * True only when the server says the session itself is gone (expired, idle,
 * signed out elsewhere). Other 401s — a wrong password at a step-up prompt,
 * bad login credentials — must not sign the user out.
 */
export function isSessionEnded(error: unknown): boolean {
  return (
    error instanceof ApiRequestError && error.status === 401 && error.code === 'UNAUTHENTICATED'
  );
}

async function fetchSession(): Promise<SessionResponse | null> {
  try {
    const session = await apiGet('/api/v1/auth/session', SessionResponseSchema);
    setCsrfToken(session.csrfToken);
    return session;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw err;
  }
}

export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: fetchSession,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Switching identity removes every cached query, so one user's data can never
 * flash on screen for the next user of the same browser. Only queries are
 * removed: clearing the mutation cache would drop the in-flight login/logout
 * mutation and skip its callbacks.
 */
export function applySession(queryClient: QueryClient, session: SessionResponse | null) {
  setCsrfToken(session?.csrfToken ?? null);
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
  queryClient.setQueryData(SESSION_KEY, session);
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) =>
      apiSend('POST', '/api/v1/auth/login', input, SessionResponseSchema),
    onSuccess: (session) => applySession(queryClient, session),
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterInput) =>
      apiSend('POST', '/api/v1/auth/register', input, SessionResponseSchema),
    onSuccess: (session) => applySession(queryClient, session),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scope: 'this' | 'all') =>
      apiSendNoContent('POST', scope === 'all' ? '/api/v1/auth/logout-all' : '/api/v1/auth/logout'),
    // Clear local state even if the server call fails: the user asked to leave.
    onSettled: () => applySession(queryClient, null),
  });
}
