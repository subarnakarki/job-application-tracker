import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import { useDemoSignIn, useMe } from '../api/hooks';
import { PublicHeader } from '../components/PublicHeader';
import { RevealHeading } from '../components/ui/PageHeader';
import { safeNext } from '../safeNext';
import previewUrl from '../assets/signin-preview.webp';

/** Why a Google sign-in ended back here (set by the server's callback). */
const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_expired: 'The sign-in took too long or was started in another browser. Try again.',
  google_failed: 'Google sign-in did not work. Try again.',
  google_unavailable: 'Google sign-in is not available right now.',
  rate_limited: 'Too many sign-ins from your network. Try again later.',
};

const FEATURES = [
  {
    title: 'Follow-ups, flagged',
    text: 'Quiet for 7 days with no next step? It rises to the top.',
    icon: <path d="M7 17 17 7M9 7h8v8" />,
  },
  {
    title: 'Drag across stages',
    text: 'Move an application from Applied to Offer on the board, with a mouse, a finger or the keyboard.',
    icon: (
      <>
        <path d="M8 6h8M8 12h8M8 18h8" />
        <path d="M4 6h.01M4 12h.01M4 18h.01" />
      </>
    ),
  },
  {
    title: 'Gmail import',
    text: 'Rejections and interview invites update your list, and you can undo each change.',
    icon: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </>
    ),
  },
];

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
    <>
      <PublicHeader />
      <main className="overflow-x-clip">
        <section className="relative px-4 pt-16 pb-10 text-center md:px-6 md:pt-24">
          <div aria-hidden="true" className="orb drifting" />
          <div aria-hidden="true" className="grid-lines" />
          <span className="rise relative inline-flex h-[1.875rem] items-center gap-2 rounded-full bg-white/[0.06] py-0 pr-3 pl-1.5 text-[0.8125rem] text-fg-2 shadow-line">
            <b className="rounded-full bg-gradient-to-r from-blue to-violet px-2 py-0.5 text-xs font-medium text-white">
              New
            </b>
            Fill an application from a job link
          </span>
          <RevealHeading
            text="Every application. One calm place."
            className="relative mx-auto mt-5 max-w-[12ch] text-[clamp(2.75rem,8.4vw,6.5rem)] leading-[0.95] font-[650] tracking-[-0.055em]"
          />
          <p className="rise rise-4 relative mx-auto mt-5 max-w-[40ch] text-[clamp(1.0625rem,2vw,1.25rem)] leading-snug tracking-[-0.015em] text-fg-2">
            Track your job applications through the hiring pipeline, and see which ones need a
            follow-up.
          </p>
          {error && (
            <p
              role="alert"
              className="relative mx-auto mt-5 max-w-md rounded-xl bg-red/10 p-3 text-sm text-red"
            >
              {error}
            </p>
          )}
          <div className="rise rise-5 relative mt-8 flex flex-wrap justify-center gap-3">
            {/* A full-page navigation, not a fetch: the server redirects to Google. */}
            <a
              href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}
              className="btn-w min-h-12 px-6 text-[0.9375rem]"
            >
              Continue with Google
            </a>
            <button
              type="button"
              className="btn-d min-h-12 px-6 text-[0.9375rem]"
              disabled={demo.isPending}
              onClick={() =>
                demo.mutate(undefined, { onSuccess: () => void navigate(next, { replace: true }) })
              }
            >
              {demo.isPending ? 'Signing in…' : 'Try the demo'}
            </button>
          </div>
          <p className="rise rise-6 relative mt-4 text-[0.8125rem] text-fg-3">
            Your applications are private to your Google account. The demo account is shared by
            everyone who tries it.{' '}
            <Link to="/privacy" className="link">
              Privacy
            </Link>
          </p>
        </section>

        <div className="rise rise-7 mx-auto mt-4 max-w-[68rem] px-4 [perspective:1600px] md:px-6">
          <div className="signin-shot overflow-hidden rounded-[1.75rem] bg-s1 p-3 shadow-[inset_0_0_0_1px_var(--color-line-2),0_40px_120px_-30px_rgb(10_139_255/0.45)] md:p-5">
            <img
              src={previewUrl}
              alt=""
              width={1500}
              height={1125}
              className="block w-full rounded-2xl"
            />
          </div>
        </div>

        <section className="mx-auto mt-16 grid max-w-[68rem] gap-3 px-4 pb-24 md:grid-cols-3 md:px-6">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="glow flex min-h-48 flex-col justify-end p-6">
              <span
                aria-hidden="true"
                className="mb-auto grid size-10 place-items-center rounded-xl bg-white/[0.06] shadow-line"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-[1.125rem]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {feature.icon}
                </svg>
              </span>
              <h2 className="mt-8 text-xl font-semibold tracking-[-0.03em]">{feature.title}</h2>
              <p className="mt-1.5 text-[0.9375rem] leading-snug text-fg-2">{feature.text}</p>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
