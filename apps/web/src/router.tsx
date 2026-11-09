import { createBrowserRouter } from 'react-router';
import { AppLayout } from './components/layout/AppLayout';
import { OverviewPage } from './features/dashboard/OverviewPage';
import { ComingSoonPage, NotFoundPage } from './features/placeholder/ComingSoonPage';

export const router = createBrowserRouter([
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
      {
        path: 'policies',
        element: (
          <ComingSoonPage
            title="Policies"
            phase={4}
            description="Your spending rules, compiled and confirmed by you."
          />
        ),
      },
      {
        path: 'tasks',
        element: (
          <ComingSoonPage
            title="Tasks"
            phase={3}
            description="The instructions you have given your agents."
          />
        ),
      },
      {
        path: 'agents',
        element: (
          <ComingSoonPage title="Agents" phase={3} description="Agents and their Leash API keys." />
        ),
      },
      {
        path: 'merchants',
        element: (
          <ComingSoonPage
            title="Merchants"
            phase={3}
            description="PayPal sandbox payees your agents may pay."
          />
        ),
      },
      {
        path: 'audit',
        element: (
          <ComingSoonPage
            title="Audit log"
            phase={3}
            description="Tamper-evident history of every action."
          />
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
