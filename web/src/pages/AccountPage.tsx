import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useDeleteAccount, useMe, useUpdateTimeZone } from '../api/hooks';
import { ConfirmDialog } from '../components/ConfirmDialog';

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function AccountPage() {
  const me = useMe();
  const updateZone = useUpdateTimeZone();
  const deleteAccount = useDeleteAccount();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const user = me.data;
  if (!user) return null;
  const device = deviceTimeZone();

  return (
    <div className="flex max-w-xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="mt-1 text-slate-600 dark:text-slate-300">
          {user.name ? `${user.name} · ` : ''}
          {user.email}
        </p>
      </div>

      <section aria-labelledby="zone-heading" className="flex flex-col gap-2">
        <h2 id="zone-heading" className="text-lg font-semibold">
          Time zone
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Dates such as &quot;needs follow-up&quot; are worked out in{' '}
          <strong>{user.timeZone}</strong>.
        </p>
        {device !== user.timeZone && (
          <div>
            <button
              type="button"
              className="btn-secondary"
              disabled={updateZone.isPending}
              onClick={() => updateZone.mutate(device)}
            >
              Use this device&apos;s time zone ({device})
            </button>
          </div>
        )}
        {updateZone.isError && (
          <p role="alert" className="text-sm text-rose-700">
            Could not change the time zone. Try again.
          </p>
        )}
      </section>

      {user.isDemo ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          The shared demo account cannot be exported or deleted. Sign in with Google for your own
          private account.
        </p>
      ) : (
        <>
          <section aria-labelledby="export-heading" className="flex flex-col gap-2">
            <h2 id="export-heading" className="text-lg font-semibold">
              Your data
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Download everything the app holds about you, including all applications and their
              history, as one JSON file.
            </p>
            <div>
              <a href="/api/me/export" className="btn-secondary" download>
                Download my data
              </a>
            </div>
          </section>

          <section aria-labelledby="delete-heading" className="flex flex-col gap-2">
            <h2 id="delete-heading" className="text-lg font-semibold">
              Delete account
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Removes your account, every application and its history, and signs you out everywhere.
              This cannot be undone.
            </p>
            <div>
              <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>
                Delete my account
              </button>
            </div>
          </section>
        </>
      )}

      <p className="text-sm">
        <Link to="/privacy" className="text-blue-700 underline dark:text-blue-400">
          Privacy
        </Link>
      </p>

      <ConfirmDialog
        open={confirming}
        title="Delete your account?"
        message="Your account and all your applications will be removed permanently."
        confirmLabel="Delete my account"
        busy={deleteAccount.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          deleteAccount.mutate(undefined, {
            onSuccess: () => void navigate('/login', { replace: true }),
          })
        }
      />
    </div>
  );
}
