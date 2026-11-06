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
import { Glow } from '../components/ui/Glow';
import { PageHeader } from '../components/ui/PageHeader';
import type { ReactNode } from 'react';
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

const ICONS = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </>
  ),
};

/** One section of the page as a tile: a decorative icon, a heading, and what the section holds. */
function Tile({
  id,
  icon,
  title,
  danger = false,
  delay,
  children,
}: {
  id: string;
  icon: keyof typeof ICONS;
  title: string;
  danger?: boolean;
  delay: number;
  children: ReactNode;
}) {
  return (
    <Glow
      as="section"
      aria-labelledby={id}
      className={`rise rise-${delay} flex flex-col items-start gap-4 p-5 sm:p-[1.375rem] ${
        danger ? 'danger-tile' : ''
      }`}
    >
      <div className="flex gap-3.5">
        <span
          aria-hidden="true"
          className={`grid size-10 flex-none place-items-center rounded-xl bg-white/[0.06] shadow-line ${
            danger ? 'text-[#ff6b7a]' : ''
          }`}
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
            {ICONS[icon]}
          </svg>
        </span>
        <div className="min-w-0 max-w-[60ch]">
          <h2 id={id} className="text-[1.0625rem] font-semibold tracking-[-0.025em]">
            {title}
          </h2>
          <div className="mt-1 flex flex-col gap-3 text-sm text-fg-2">{children}</div>
        </div>
      </div>
    </Glow>
  );
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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Account"
        subtitle={
          <>
            {user.name ? `${user.name} · ` : ''}
            {user.email}
          </>
        }
      />

      <div className="flex flex-col gap-3">
        <Tile id="zone-heading" icon="clock" title="Time zone" delay={3}>
          <p>
            Dates such as &quot;needs follow-up&quot; are worked out in{' '}
            <strong className="font-medium text-fg">{user.timeZone}</strong>.
          </p>
          {device !== user.timeZone && (
            <div>
              <button
                type="button"
                className="btn-d"
                disabled={updateZone.isPending}
                onClick={() => updateZone.mutate(device)}
              >
                Use this device&apos;s time zone ({device})
              </button>
            </div>
          )}
          {updateZone.isError && (
            <p role="alert" className="text-red">
              Could not change the time zone. Try again.
            </p>
          )}
        </Tile>

        {user.isDemo ? (
          <p className="px-1 text-sm text-fg-2">
            The shared demo account cannot be exported or deleted. Sign in with Google for your own
            private account.
          </p>
        ) : (
          <>
            {(importStatus.data?.available || importReason) && (
              <Tile id="import-heading" icon="mail" title="Import from Gmail" delay={4}>
                {importReason && (
                  <p role="alert" className="text-red">
                    {IMPORT_MESSAGES[importReason] ?? 'The import did not finish. Try again.'}
                  </p>
                )}
                {importStatus.data?.available && (
                  <>
                    <p>
                      Reads job emails from the last 30 days (or since your last import) once, with
                      read-only access. Each email&apos;s text is sent to Anthropic&apos;s Claude to
                      classify it; bodies are not stored. Clear results are applied, and you can
                      undo each one.
                    </p>
                    <div>
                      <a href="/api/import/gmail/start" className="btn-w">
                        Import from Gmail
                      </a>
                    </div>
                  </>
                )}
              </Tile>
            )}

            {runs.length > 0 && (
              <Tile id="imports-heading" icon="history" title="Past imports" delay={5}>
                <ul className="-mb-1 flex flex-col" aria-label="Past imports">
                  {runs.map((run) => (
                    <li key={run.id} className="border-t border-line first:border-t-0">
                      <Link
                        to={`/import/${run.id}`}
                        className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 text-sm text-fg transition-[padding] duration-300 hover:pl-1.5"
                      >
                        <span className="font-medium">
                          {formatDateTime(run.startedAt)}
                          {run.status === 'failed' && ' · did not finish'}
                        </span>
                        <span className="text-fg-2">
                          {run.changed} changed ·{' '}
                          {run.needsReview > 0 ? (
                            <strong className="font-semibold text-amber">
                              {run.needsReview} to review
                            </strong>
                          ) : (
                            '0 to review'
                          )}{' '}
                          · {run.skipped} skipped
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Tile>
            )}

            <Tile id="export-heading" icon="download" title="Your data" delay={6}>
              <p>
                Download everything the app holds about you, including all applications and their
                history, as one JSON file.
              </p>
              <div>
                <a href="/api/me/export" className="btn-d" download>
                  Download my data
                </a>
              </div>
            </Tile>

            <Tile id="delete-heading" icon="trash" title="Delete account" danger delay={7}>
              <p>
                Removes your account, every application and its history, and signs you out
                everywhere. This cannot be undone.
              </p>
              <div>
                <button type="button" className="btn-red" onClick={() => setConfirming(true)}>
                  Delete my account
                </button>
              </div>
            </Tile>
          </>
        )}
      </div>

      <p className="text-sm">
        <Link to="/privacy" className="link underline">
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
