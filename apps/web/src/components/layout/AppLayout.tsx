import { NavLink, Outlet, useNavigate } from 'react-router';
import { useLogout, useSession } from '../../api/session';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/approvals', label: 'Approvals' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/policies', label: 'Policies' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/agents', label: 'Agents' },
  { to: '/merchants', label: 'Merchants' },
  { to: '/audit', label: 'Audit log' },
];

function AccountMenu() {
  const session = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const signOut = (scope: 'this' | 'all') =>
    logout.mutate(scope, { onSettled: () => navigate('/login', { replace: true }) });

  if (!session.data) return null;
  return (
    <div className="border-t border-slate-200 px-5 py-4 text-sm">
      <p className="truncate font-medium text-slate-800" title={session.data.user.email}>
        {session.data.user.email}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        <button
          type="button"
          className="text-slate-600 underline hover:text-slate-900"
          onClick={() => signOut('this')}
        >
          Sign out
        </button>
        <button
          type="button"
          className="text-slate-500 underline hover:text-slate-900"
          title="End every session for this account, on every device"
          onClick={() => signOut('all')}
        >
          Sign out everywhere
        </button>
      </div>
    </div>
  );
}

export function AppLayout() {
  return (
    <div className="min-h-screen md:flex">
      <aside className="flex flex-col border-b border-slate-200 bg-white md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-5 py-4">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-lg bg-slate-900 font-bold text-white"
          >
            L
          </span>
          <div>
            <p className="font-semibold leading-tight">Leash</p>
            <p className="text-xs text-slate-500">Spending firewall</p>
          </div>
        </div>
        <nav
          aria-label="Main"
          className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:overflow-visible"
        >
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <AccountMenu />
      </aside>

      <div className="min-w-0 flex-1">
        <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs font-medium text-amber-900">
          PayPal Sandbox mode — no real money moves.
        </div>
        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
