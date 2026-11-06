import { Link, useNavigate, useSearchParams } from 'react-router';
import { useDemoSignIn, useMe } from '../api/hooks';
import { safeNext } from '../safeNext';

const LINKS = [
  { to: '/', label: 'Applications' },
  { to: '/leads', label: 'Leads' },
  { to: '/stats', label: 'Stats' },
  { to: '/account', label: 'Account' },
] as const;

/**
 * The header for pages a signed-out visitor can see (sign-in, privacy). The app links lead to
 * sign-in first and then to the page they asked for. Signed in, it offers to open the app instead.
 */
export function PublicHeader() {
  const me = useMe();
  const demo = useDemoSignIn();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const signedIn = Boolean(me.data);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-black/60 pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex max-w-[75rem] flex-wrap items-center gap-x-7 px-4 md:flex-nowrap md:px-6">
        <Link
          to={signedIn ? '/' : '/login'}
          className="flex min-h-14 items-center gap-2.5 text-[0.9375rem] font-semibold tracking-[-0.02em]"
        >
          <span aria-hidden="true" className="logo-mark" />
          Job Tracker
        </Link>
        <nav
          aria-label="Main"
          className="order-last -mx-4 flex basis-full gap-1 overflow-x-auto px-4 [scrollbar-width:none] md:order-none md:mx-0 md:basis-auto md:px-0"
        >
          {LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex min-h-11 shrink-0 items-center px-2.5 text-sm text-fg-2 transition-colors hover:text-fg md:px-3"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {signedIn ? (
            <Link to="/" className="btn-w">
              Open the app
            </Link>
          ) : (
            <>
              <button
                type="button"
                className="btn-d"
                disabled={demo.isPending}
                onClick={() =>
                  demo.mutate(undefined, {
                    onSuccess: () => void navigate(next, { replace: true }),
                  })
                }
              >
                Try the demo
              </button>
              <a href={`/api/auth/google/start?next=${encodeURIComponent(next)}`} className="btn-w">
                Sign in
              </a>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
