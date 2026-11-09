import { createBrowserRouter } from 'react-router';
import { AppLayout } from './components/layout/AppLayout';
import { AgentDetailPage } from './features/agents/AgentDetailPage';
import { AgentsPage } from './features/agents/AgentsPage';
import { AuditPage } from './features/audit/AuditPage';
import { LoginPage, PublicOnly, RegisterPage, RequireAuth } from './features/auth/AuthPages';
import { OverviewPage } from './features/dashboard/OverviewPage';
import { MerchantsPage } from './features/merchants/MerchantsPage';
import { PoliciesPage } from './features/policies/PoliciesPage';
import { PolicyReviewPage } from './features/policies/PolicyReviewPage';
import { ComingSoonPage, NotFoundPage } from './features/placeholder/ComingSoonPage';
import { TasksPage } from './features/tasks/TasksPage';

export const router = createBrowserRouter([
  {
    element: <PublicOnly />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <OverviewPage /> },
          {
            path: 'approvals',
            element: (
              <ComingSoonPage
                title="Approvals"
                phase={6}
                description="Escalated purchases waiting for your decision."
              />
            ),
          },
          {
            path: 'transactions',
            element: (
              <ComingSoonPage
                title="Transactions"
                phase={5}
                description="Every purchase request, its decision, and the reasons behind it."
              />
            ),
          },
          { path: 'policies', element: <PoliciesPage /> },
          { path: 'policies/versions/:id', element: <PolicyReviewPage /> },
          { path: 'tasks', element: <TasksPage /> },
          { path: 'agents', element: <AgentsPage /> },
          { path: 'agents/:id', element: <AgentDetailPage /> },
          { path: 'merchants', element: <MerchantsPage /> },
          { path: 'audit', element: <AuditPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
