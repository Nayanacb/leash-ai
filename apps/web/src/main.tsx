import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import './index.css';
import { ApiRequestError } from './api/client';
import { applySession, isSessionEnded } from './api/session';
import { router } from './router';

/** Any 401 means the session ended (expired, idle, or signed out elsewhere): drop to the login screen. */
function onApiError(error: unknown) {
  if (isSessionEnded(error) && queryClient.getQueryData(['session'])) {
    applySession(queryClient, null);
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        !(error instanceof ApiRequestError && error.status < 500) && count < 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
