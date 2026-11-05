import { APP_NAME } from '@jat/shared';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useMe, useSignOut } from '../api/hooks';

/** The page frame for signed-in pages. Redirects to sign-in when there is no session. */
export function Layout() {
  const me = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const location = useLocation();

  if (me.isPending) return <p className="p-6 text-sm">Loading…</p>;
  if (me.isError)
    return (
      <p className="p-6 text-sm text-rose-700">Could not reach the server. Try again shortly.</p>
    );
  if (!me.data) {
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <Link
            to="/"
            className="font-semibold focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            {APP_NAME}
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <Link
              to="/stats"
              className="text-slate-600 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-slate-300"
            >
              Stats
            </Link>
            <Link
              to="/account"
              className="text-slate-600 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-slate-300"
            >
              Account
            </Link>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                signOut.mutate(undefined, { onSuccess: () => void navigate('/login') })
              }
            >
              Sign out
            </button>
          </div>
        </div>
        {me.data.isDemo && (
          <p className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            You are using the shared demo account. Others can see and change this data.
          </p>
        )}
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
