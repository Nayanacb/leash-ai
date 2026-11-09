import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useLogin, useRegister, useSession } from '../../api/session';
import { Button } from '../../components/ui/Button';
import { ErrorMessage, Loading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Form';

/** Protects dashboard routes. */
export function RequireAuth() {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <Loading label="Checking your session…" />;
  if (session.isError) return <ErrorMessage error={session.error} />;
  if (!session.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Where to go after signing in: the protected page that redirected here, if any. */
function returnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  // Only same-app paths, never a full URL (no open redirect).
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}

/** Login/register pages redirect away once signed in. */
export function PublicOnly() {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <Loading />;
  if (session.data) return <Navigate to={returnPath(location.state)} replace />;
  return <Outlet />;
}

function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span
            aria-hidden
            className="grid size-9 place-items-center rounded-lg bg-slate-900 font-bold text-white"
          >
            L
          </span>
          <div>
            <p className="font-semibold leading-tight">Leash</p>
            <p className="text-xs text-slate-500">Spending firewall for AI agents</p>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </div>
        <p className="mt-4 text-center text-sm text-slate-600">{footer}</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const from = returnPath(location.state);

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate(from, { replace: true }) });
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Review and control what your agents spend."
      footer={
        <>
          New to Leash?{' '}
          <Link to="/register" className="font-medium text-slate-900 underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorMessage error={login.error} />
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const register = useRegister();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && confirm !== password;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    register.mutate({ email, password }, { onSuccess: () => navigate('/', { replace: true }) });
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="You will configure agents, merchants and tasks next."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-slate-900 underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorMessage error={register.error} />
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password" hint="At least 12 characters. A long passphrase is best.">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Confirm password" error={mismatch ? 'Passwords do not match' : undefined}>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" className="w-full" disabled={register.isPending || mismatch}>
          {register.isPending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}
