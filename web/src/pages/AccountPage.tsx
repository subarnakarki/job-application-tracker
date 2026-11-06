import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  useDeleteAccount,
  useImportRuns,
  useImportStatus,
  useMe,
  useUpdateTimeZone,
} from '../api/hooks';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatDateTime } from '../format';

/** Why a Gmail import came back to this page (`?import=...`). */
const IMPORT_MESSAGES: Record<string, string> = {
  gmail_cancelled: 'The import was cancelled on the Google page.',
  gmail_not_granted: 'Gmail access was not granted, so nothing was imported.',
  gmail_expired: 'That import link expired. Start it again from here.',
  gmail_failed: 'Gmail could not be read just now. Try again shortly.',
  google_failed: 'Google did not confirm the access. Try again.',
  classifier_unavailable: 'The email classifier is unavailable right now. Nothing was changed.',
};

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
  const importStatus = useImportStatus();
  const importRuns = useImportRuns();
  const runs = importRuns.data?.items ?? [];
  const [params] = useSearchParams();
  const importReason = params.get('import');
  const user = me.data;
  if (!user) return null;
  const device = deviceTimeZone();

  return (
    <div className="flex max-w-xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="mt-1 text-fg-2">
          {user.name ? `${user.name} · ` : ''}
          {user.email}
        </p>
      </div>

      <section aria-labelledby="zone-heading" className="flex flex-col gap-2">
        <h2 id="zone-heading" className="text-lg font-semibold">
          Time zone
        </h2>
        <p className="text-sm text-fg-2">
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
          <p role="alert" className="text-sm text-red">
            Could not change the time zone. Try again.
          </p>
        )}
      </section>

      {user.isDemo ? (
        <p className="text-sm text-fg-2">
          The shared demo account cannot be exported or deleted. Sign in with Google for your own
          private account.
        </p>
      ) : (
        <>
          {(importStatus.data?.available || importReason) && (
            <section aria-labelledby="import-heading" className="flex flex-col gap-2">
              <h2 id="import-heading" className="text-lg font-semibold">
                Import from Gmail
              </h2>
              {importReason && (
                <p role="alert" className="text-sm text-red">
                  {IMPORT_MESSAGES[importReason] ?? 'The import did not finish. Try again.'}
                </p>
              )}
              {importStatus.data?.available && (
                <>
                  <p className="text-sm text-fg-2">
                    Reads job emails from the last 30 days (or since your last import) once, with
                    read-only access. Each email&apos;s text is sent to Anthropic&apos;s Claude to
                    classify it; bodies are not stored. Clear results are applied, and you can undo
                    each one.
                  </p>
                  <div>
                    <a href="/api/import/gmail/start" className="btn-primary">
                      Import from Gmail
                    </a>
                  </div>
                </>
              )}
            </section>
          )}

          {runs.length > 0 && (
            <section aria-labelledby="imports-heading" className="flex flex-col gap-2">
              <h2 id="imports-heading" className="text-lg font-semibold">
                Past imports
              </h2>
              <ul className="flex flex-col gap-2" aria-label="Past imports">
                {runs.map((run) => (
                  <li key={run.id}>
                    <Link
                      to={`/import/${run.id}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg border border-line-2 px-3 py-2 text-sm hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-blue"
                    >
                      <span className="font-medium">
                        {formatDateTime(run.startedAt)}
                        {run.status === 'failed' && ' · did not finish'}
                      </span>
                      <span className="text-fg-2">
                        {run.changed} changed ·{' '}
                        {run.needsReview > 0 ? (
                          <strong className="text-amber">{run.needsReview} to review</strong>
                        ) : (
                          '0 to review'
                        )}{' '}
                        · {run.skipped} skipped
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="export-heading" className="flex flex-col gap-2">
            <h2 id="export-heading" className="text-lg font-semibold">
              Your data
            </h2>
            <p className="text-sm text-fg-2">
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
            <p className="text-sm text-fg-2">
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
        <Link to="/privacy" className="text-blue-link underline">
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
