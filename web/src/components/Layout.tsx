import { APP_NAME } from '@jat/shared';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useMe, useSignOut } from '../api/hooks';
import { useOnline } from '../useOnline';

/** The page frame for signed-in pages. Redirects to sign-in when there is no session. */
export function Layout() {
  const me = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnline();
  // The board needs the full width for its seven columns; everything else reads better narrow.
  const width =
    location.pathname === '/' && new URLSearchParams(location.search).get('view') === 'board'
      ? 'max-w-screen-2xl'
      : 'max-w-4xl';

  // Opened offline (from the installed app): the shell is cached, your data is not.
  if (!online && !me.data) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-4">
        <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
        <p role="status" className="text-slate-600 dark:text-slate-300">
          You're offline. Your applications will load when you're back online.
        </p>
      </main>
    );
  }
  if (me.isPending) return <p className="p-6 text-sm">Loading…</p>;
  if (me.isError)
    return (
      <p className="p-6 text-sm text-rose-700 dark:text-rose-400">
        Could not reach the server. Try again shortly.
      </p>
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
    <div className="min-h-dvh pb-[env(safe-area-inset-bottom)]">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className={`mx-auto flex items-center justify-between gap-3 px-4 py-3 ${width}`}>
          <Link
            to="/"
            className="font-semibold focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            {APP_NAME}
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <Link
              to="/leads"
              className="text-slate-600 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-slate-300"
            >
              Leads
            </Link>
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
        {!online && (
          <p
            role="status"
            className="bg-slate-800 px-4 py-2 text-center text-sm text-white dark:bg-slate-200 dark:text-slate-900"
          >
            You're offline. Changes can't be saved until you're back online.
          </p>
        )}
        {me.data.isDemo && (
          <p className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            You are using the shared demo account. Others can see and change this data.
          </p>
        )}
      </header>
      <main className={`mx-auto px-4 py-6 ${width}`}>
        <Outlet />
      </main>
    </div>
  );
}
