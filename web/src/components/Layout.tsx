import { APP_NAME } from '@jat/shared';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useMe, useSignOut } from '../api/hooks';
import { useOnline } from '../useOnline';
import { ToastProvider } from './Toast';

const NAV = [
  { to: '/', label: 'Applications', owns: ['/applications', '/import'] },
  { to: '/leads', label: 'Leads', owns: ['/leads'] },
  { to: '/stats', label: 'Stats', owns: ['/stats'] },
  { to: '/account', label: 'Account', owns: ['/account'] },
] as const;

/** Whether the current page belongs to a nav link (the Applications link also covers an application's own pages). */
function isActive(pathname: string, item: (typeof NAV)[number]): boolean {
  if (item.to === '/' && pathname === '/') return true;
  return item.owns.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

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
      : 'max-w-[75rem]';

  // Opened offline (from the installed app): the shell is cached, your data is not.
  if (!online && !me.data) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-4">
        <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
        <p role="status" className="text-fg-2">
          You're offline. Your applications will load when you're back online.
        </p>
      </main>
    );
  }
  if (me.isPending) return <p className="p-6 text-sm">Loading…</p>;
  if (me.isError)
    return <p className="p-6 text-sm text-red">Could not reach the server. Try again shortly.</p>;
  if (!me.data) {
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  }

  return (
    <ToastProvider>
      <div className="min-h-dvh pb-[env(safe-area-inset-bottom)]">
        <header className="sticky top-0 z-30 border-b border-line bg-black/60 pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-150">
          <div
            className={`mx-auto flex flex-wrap items-center gap-x-7 px-4 md:flex-nowrap md:px-6 ${width}`}
          >
            <Link
              to="/"
              className="flex min-h-14 items-center gap-2.5 text-[0.9375rem] font-semibold tracking-[-0.02em]"
            >
              <span aria-hidden="true" className="logo-mark" />
              Job Tracker
            </Link>
            <nav
              aria-label="Main"
              className="order-last -mx-4 flex basis-full gap-1 overflow-x-auto px-4 [scrollbar-width:none] md:order-none md:mx-0 md:basis-auto md:px-0"
            >
              {NAV.map((item) => {
                const active = isActive(location.pathname, item);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-h-11 shrink-0 items-center px-2.5 text-sm transition-colors hover:text-fg md:px-3 ${
                      active ? 'text-fg' : 'text-fg-2'
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <button
              type="button"
              className="btn-d ml-auto"
              onClick={() =>
                signOut.mutate(undefined, { onSuccess: () => void navigate('/login') })
              }
            >
              Sign out
            </button>
          </div>
          {!online && (
            <p role="status" className="bg-s3 px-4 py-2 text-center text-sm text-fg">
              You're offline. Changes can't be saved until you're back online.
            </p>
          )}
          {me.data.isDemo && (
            <p className="border-t border-amber/20 bg-amber/10 px-4 py-2 text-center text-sm text-amber">
              You are using the shared demo account. Others can see and change this data.
            </p>
          )}
        </header>
        <main className={`mx-auto px-4 py-6 md:px-6 md:py-8 ${width}`}>
          <Outlet />
        </main>
      </div>
    </ToastProvider>
  );
}
