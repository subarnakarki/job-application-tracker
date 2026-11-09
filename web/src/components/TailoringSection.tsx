import {
  APPLICATION_TAILOR_LIMITS,
  applyEdits,
  type ApplicationDetail,
  type ApplicationTailoring,
} from '@jat/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '../api/client';
import {
  useApplicationTailoring,
  useJobSearchSetup,
  useRemoveTailoredResume,
  useResume,
  useResumeText,
  useSaveTailoredResume,
  useTailorApplication,
} from '../api/hooks';
import { formatDateTime } from '../format';
import { fitOf, TailorSuggestions, useChosenEdits } from './TailorSuggestions';
import { useToast } from './Toast';
import { Glow } from './ui/Glow';

const labelClass = 'text-[0.8125rem] font-medium text-fg-2';
/** Errors after which the posting has to be pasted. */
const PASTE_CODES = new Set(['no_job_link', 'posting_unreadable']);

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/**
 * "Tailored resume" on an application: suggestions from the posting, then the full text edited by
 * hand and saved as this job's resume. Shown only where the job search is available.
 */
export function TailoringSection({ application }: { application: ApplicationDetail }) {
  const setup = useJobSearchSetup();
  if (!setup.data?.available) return null;
  return <TailoringPanel application={application} />;
}

function TailoringPanel({ application }: { application: ApplicationDetail }) {
  const id = useId();
  const resume = useResume();
  const hasResume = Boolean(resume.data?.resume);
  const query = useApplicationTailoring(application.id, hasResume);
  const text = useResumeText(hasResume);
  const tailor = useTailorApplication(application.id);
  const toast = useToast();
  const data: ApplicationTailoring | undefined = query.data;
  const tailoring = data?.tailoring ?? null;
  const { off, chosen, toggle } = useChosenEdits(tailoring);
  const [editing, setEditing] = useState<string | null>(null);
  const [posting, setPosting] = useState('');

  const needsPaste =
    tailor.error instanceof ApiRequestError && PASTE_CODES.has(tailor.error.code ?? '');
  const resumeText = text.data?.text ?? null;
  const keywords = data?.keywords ?? [];
  const before = resumeText ? fitOf(keywords, resumeText) : null;
  const tailored = resumeText ? applyEdits(resumeText, chosen) : null;
  const after = tailored ? fitOf(keywords, tailored) : null;
  const run = (postingText: string | null) =>
    tailor.mutate(postingText, {
      onSuccess: () => {
        setPosting('');
        toast(`Suggestions ready for ${application.company}`);
      },
    });

  return (
    <Glow as="section" aria-labelledby={`${id}-heading`} className="flex flex-col gap-4 p-5">
      <h2 id={`${id}-heading`} className="text-[0.8125rem] font-medium text-fg-2">
        Tailored resume
      </h2>
      {!hasResume ? (
        <p className="text-sm text-fg-2">
          <Link to="/resume" className="link underline">
            Upload your resume
          </Link>{' '}
          to tailor it for this job.
        </p>
      ) : (
        <>
          {data?.saved && editing === null && (
            <SavedVersion applicationId={application.id} saved={data.saved} onEdit={setEditing} />
          )}

          {editing !== null ? (
            <Editor
              applicationId={application.id}
              initial={editing}
              keywords={keywords}
              before={before?.percent ?? null}
              onDone={() => setEditing(null)}
            />
          ) : (
            <>
              {!tailoring && (
                <p className="text-sm text-fg-3">
                  Reads the posting and suggests rewording lines you already have so its keywords
                  appear where your resume supports them. Nothing is invented. Then edit the whole
                  text and save it as this job's resume. Up to 10 a day.
                </p>
              )}
              {tailoring && (
                <details open className="rounded-tile bg-s2 p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    {String(tailoring.edits.length)} suggestion
                    {tailoring.edits.length === 1 ? '' : 's'}
                  </summary>
                  <div className="mt-3 flex flex-col gap-4">
                    {before && (
                      <p className="text-sm" role="status">
                        Fit {String(before.percent)}%
                        {after && chosen.length > 0
                          ? ` → ${String(after.percent)}% with the ticked edits`
                          : ''}
                      </p>
                    )}
                    <TailorSuggestions tailoring={tailoring} off={off} onToggle={toggle} />
                    <div>
                      <button
                        type="button"
                        className="btn-w"
                        disabled={!tailored}
                        onClick={() => tailored && setEditing(tailored)}
                      >
                        Edit and save as this job's resume
                      </button>
                    </div>
                  </div>
                </details>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-d"
                  disabled={tailor.isPending}
                  onClick={() => run(null)}
                >
                  {tailor.isPending
                    ? 'Tailoring…'
                    : tailoring
                      ? 'Tailor again'
                      : 'Tailor my resume'}
                </button>
                {!data?.saved && resumeText && (
                  <button type="button" className="btn-d" onClick={() => setEditing(resumeText)}>
                    Edit by hand
                  </button>
                )}
              </div>
              {tailor.isPending && (
                <p role="status" className="text-sm text-fg-3">
                  Reading the posting and your resume. Usually under a minute…
                </p>
              )}
              {tailor.isError && (
                <p role="alert" className="text-sm text-red">
                  {errorText(tailor.error, 'Could not tailor right now. Try again.')}
                </p>
              )}
              {needsPaste && (
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(posting.trim());
                  }}
                >
                  <label htmlFor={`${id}-posting`} className={labelClass}>
                    Paste the job posting
                  </label>
                  <textarea
                    id={`${id}-posting`}
                    rows={8}
                    className="inp text-sm"
                    value={posting}
                    maxLength={APPLICATION_TAILOR_LIMITS.postingText}
                    onChange={(event) => setPosting(event.target.value)}
                  />
                  <div>
                    <button
                      type="submit"
                      className="btn-d"
                      disabled={posting.trim().length < 200 || tailor.isPending}
                    >
                      Tailor from this posting
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </>
      )}
    </Glow>
  );
}

/** The version kept for this job: when it was saved, and Edit, Copy, Remove. */
function SavedVersion({
  applicationId,
  saved,
  onEdit,
}: {
  applicationId: string;
  saved: NonNullable<ApplicationTailoring['saved']>;
  onEdit: (text: string) => void;
}) {
  const remove = useRemoveTailoredResume(applicationId);
  const toast = useToast();
  return (
    <div className="flex flex-col gap-2 rounded-tile bg-s2 p-3">
      <p className="text-sm font-medium">
        Saved for this job on {formatDateTime(saved.savedAt)}
        <span className="font-normal text-fg-3">
          {' '}
          · {String(saved.edits.length)} change{saved.edits.length === 1 ? '' : 's'} from your
          resume
        </span>
      </p>
      {saved.resumeChanged && (
        <p className="text-sm text-amber" role="note">
          You have replaced your resume since; this version is unchanged.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-d" onClick={() => onEdit(saved.text)}>
          Edit
        </button>
        <button
          type="button"
          className="btn-d"
          onClick={() =>
            void navigator.clipboard
              .writeText(saved.text)
              .then(() => toast("This job's resume copied"))
              .catch(() => toast('Copying is blocked in this browser'))
          }
        >
          Copy
        </button>
        <button
          type="button"
          className="btn-d"
          disabled={remove.isPending}
          onClick={() => remove.mutate(undefined, { onSuccess: () => toast('Removed') })}
        >
          Remove
        </button>
      </div>
      {remove.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(remove.error, 'Could not remove. Try again.')}
        </p>
      )}
    </div>
  );
}

/** The whole text, edited by hand, with the fit as it is typed; saved as this job's resume. */
function Editor({
  applicationId,
  initial,
  keywords,
  before,
  onDone,
}: {
  applicationId: string;
  initial: string;
  keywords: ApplicationTailoring['keywords'];
  before: number | null;
  onDone: () => void;
}) {
  const id = useId();
  const save = useSaveTailoredResume(applicationId);
  const toast = useToast();
  const [value, setValue] = useState(initial);
  const fit = fitOf(keywords, value);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(value, {
          onSuccess: () => {
            toast("Saved as this job's resume");
            onDone();
          },
        });
      }}
    >
      <label htmlFor={`${id}-text`} className={labelClass}>
        This job's resume
      </label>
      <textarea
        id={`${id}-text`}
        rows={18}
        className="inp font-mono text-sm"
        value={value}
        maxLength={APPLICATION_TAILOR_LIMITS.tailoredText}
        aria-describedby={`${id}-fit`}
        onChange={(event) => setValue(event.target.value)}
      />
      <p id={`${id}-fit`} className="text-sm text-fg-2" aria-live="polite">
        {fit
          ? `Fit ${before === null ? '' : `${String(before)}% → `}${String(fit.percent)}%` +
            (fit.missing.length ? ` · still missing: ${fit.missing.join(', ')}` : '')
          : 'Tailor first to see the fit with this posting.'}
      </p>
      {save.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(save.error, 'Could not save. Try again.')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-w" disabled={!value.trim() || save.isPending}>
          {save.isPending ? 'Saving…' : "Save as this job's resume"}
        </button>
        <button type="button" className="btn-d" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
