import { APP_NAME } from '@jat/shared';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import { useDemoSignIn, useMe } from '../api/hooks';

/** Only same-site paths are allowed as a return address, never another origin. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/';
}

/** Why a Google sign-in ended back here (set by the server's callback). */
const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_expired: 'The sign-in took too long or was started in another browser. Try again.',
  google_failed: 'Google sign-in did not work. Try again.',
  google_unavailable: 'Google sign-in is not available right now.',
  rate_limited: 'Too many sign-ins from your network. Try again later.',
};

export function LoginPage() {
  const me = useMe();
  const demo = useDemoSignIn();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  if (me.data) return <Navigate to={next} replace />;

  const reason = params.get('error');
  const error =
    demo.error instanceof ApiRequestError && demo.error.status === 429
      ? GOOGLE_ERRORS['rate_limited']
      : demo.error
        ? 'Sign-in failed. Try again.'
        : reason
          ? (GOOGLE_ERRORS[reason] ?? 'Sign-in failed. Try again.')
          : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
        <p className="mt-2 text-fg-2">
          Track your job applications through the hiring pipeline, and see which ones need a
          follow-up.
        </p>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red/10 p-3 text-sm text-red">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3">
        {/* A full-page navigation, not a fetch: the server redirects to Google. */}
        <a href={`/api/auth/google/start?next=${encodeURIComponent(next)}`} className="btn-primary">
          Continue with Google
        </a>
        <button
          type="button"
          className="btn-secondary"
          disabled={demo.isPending}
          onClick={() =>
            demo.mutate(undefined, { onSuccess: () => void navigate(next, { replace: true }) })
          }
        >
          {demo.isPending ? 'Signing in…' : 'Try the demo'}
        </button>
      </div>
      <p className="text-xs text-fg-3">
        Your applications are private to your Google account. The demo account is shared by everyone
        who tries it.{' '}
        <Link to="/privacy" className="underline">
          Privacy
        </Link>
      </p>
    </main>
  );
}
