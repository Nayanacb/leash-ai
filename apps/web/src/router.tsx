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
import { TransactionDetailPage } from './features/transactions/TransactionDetailPage';
import { TransactionsPage } from './features/transactions/TransactionsPage';

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
                description="Approve or reject escalated purchases here (next release). Until then, escalated purchases are under Transactions with status “Pending approval”, where you can cancel them; unapproved ones expire automatically and release their funds."
              />
            ),
          },
          { path: 'transactions', element: <TransactionsPage /> },
          { path: 'transactions/:id', element: <TransactionDetailPage /> },
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
