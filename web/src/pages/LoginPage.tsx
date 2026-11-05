import { APP_NAME } from '@jat/shared';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import { useDemoSignIn, useMe } from '../api/hooks';

/** Only same-site paths are allowed as a return address, never another origin. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const me = useMe();
  const demo = useDemoSignIn();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  if (me.data) return <Navigate to={next} replace />;

  const error =
    demo.error instanceof ApiRequestError && demo.error.status === 429
      ? 'Too many sign-ins from your network. Try again later.'
      : demo.error
        ? 'Sign-in failed. Try again.'
        : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          Track your job applications through the hiring pipeline, and see which ones need a
          follow-up.
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn-primary"
        disabled={demo.isPending}
        onClick={() =>
          demo.mutate(undefined, { onSuccess: () => void navigate(next, { replace: true }) })
        }
      >
        {demo.isPending ? 'Signing in…' : 'Try the demo'}
      </button>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        The demo account is shared by everyone who tries it. Sign-in with Google is coming soon.
      </p>
    </main>
  );
}
