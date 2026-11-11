import {
  characterCount,
  COVER_LETTER_LENGTH_LABELS,
  COVER_LETTER_LENGTHS,
  COVER_LETTER_LIMITS,
  COVER_LETTER_TONE_LABELS,
  COVER_LETTER_TONES,
  DEFAULT_COVER_LETTER_LENGTH,
  DEFAULT_COVER_LETTER_TONE,
  wordCount,
  type ApplicationCoverLetter,
  type ApplicationDetail,
  type CoverLetterLength,
  type CoverLetterTone,
} from '@jat/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '../api/client';
import {
  useApplicationCoverLetter,
  useDraftCoverLetter,
  useJobSearchSetup,
  useRemoveCoverLetter,
  useResume,
  useSaveCoverLetter,
} from '../api/hooks';
import { formatDateTime } from '../format';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';
import { Glow } from './ui/Glow';

const labelClass = 'text-[0.8125rem] font-medium text-fg-2';
/** Errors after which the posting has to be pasted. */
const PASTE_CODES = new Set(['no_job_link', 'posting_unreadable']);

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/**
 * "Cover letter" on an application: drafted from the posting and the resume in the length and
 * tone chosen, edited by hand and saved with the application. Shown only where the job search is
 * available.
 */
export function CoverLetterSection({ application }: { application: ApplicationDetail }) {
  const setup = useJobSearchSetup();
  if (!setup.data?.available) return null;
  return <CoverLetterGate application={application} />;
}

function CoverLetterGate({ application }: { application: ApplicationDetail }) {
  const id = useId();
  const resume = useResume();
  const hasResume = Boolean(resume.data?.resume);
  const query = useApplicationCoverLetter(application.id, hasResume);
  return (
    <Glow as="section" aria-labelledby={`${id}-heading`} className="flex flex-col gap-4 p-5">
      <h2 id={`${id}-heading`} className="text-[0.8125rem] font-medium text-fg-2">
        Cover letter
      </h2>
      {resume.isPending ? null : !hasResume ? (
        <p className="text-sm text-fg-2">
          <Link to="/resume" className="link underline">
            Upload your resume
          </Link>{' '}
          to draft a cover letter for this job.
        </p>
      ) : query.isPending ? (
        <p className="text-sm text-fg-3">Loading…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-red">
          {errorText(query.error, 'Could not load the cover letter. Reload to try again.')}
        </p>
      ) : (
        <CoverLetterPanel application={application} data={query.data} />
      )}
    </Glow>
  );
}

type Pending = 'draft' | 'remove' | null;

function CoverLetterPanel({
  application,
  data,
}: {
  application: ApplicationDetail;
  data: ApplicationCoverLetter;
}) {
  const id = useId();
  const toast = useToast();
  const letter = data.coverLetter;
  const draft = useDraftCoverLetter(application.id);
  const save = useSaveCoverLetter(application.id);
  const remove = useRemoveCoverLetter(application.id);
  const [length, setLength] = useState<CoverLetterLength>(
    letter?.length ?? DEFAULT_COVER_LETTER_LENGTH,
  );
  const [tone, setTone] = useState<CoverLetterTone>(letter?.tone ?? DEFAULT_COVER_LETTER_TONE);
  const [steer, setSteer] = useState(letter?.steer ?? '');
  const [text, setText] = useState(letter?.text ?? '');
  const [posting, setPosting] = useState('');
  const [confirming, setConfirming] = useState<Pending>(null);
  // A new draft (or a removal) resets the editor and the choices to the stored letter. Done while
  // rendering, not by remounting, so a mutation's own callbacks (the toast) still run.
  const [shown, setShown] = useState(letter?.draftedAt ?? null);
  if ((letter?.draftedAt ?? null) !== shown) {
    setShown(letter?.draftedAt ?? null);
    setText(letter?.text ?? '');
    if (letter) {
      setLength(letter.length);
      setTone(letter.tone);
      setSteer(letter.steer);
    }
  }

  const edited = letter !== null && text !== letter.text;
  const words = wordCount(text);
  const characters = characterCount(text);
  const over = characters > COVER_LETTER_LIMITS.letter;
  const needsPaste =
    draft.error instanceof ApiRequestError && PASTE_CODES.has(draft.error.code ?? '');

  const run = (postingText: string | null) => {
    setConfirming(null);
    draft.mutate(
      { length, tone, steer: steer.trim(), ...(postingText ? { postingText } : {}) },
      { onSuccess: () => toast(`Cover letter drafted for ${application.company}`) },
    );
  };
  // Drafting replaces the letter: asked first when that loses edits or a saved letter.
  const askToDraft = () => (edited || letter?.savedAt ? setConfirming('draft') : run(null));

  return (
    <div className="flex flex-col gap-4">
      {!letter && (
        <p className="text-sm text-fg-3">
          Reads the posting and your resume and writes a letter in your voice, using only what your
          resume says. Pick a length and tone, then edit it and save it with this application. Up to
          20 a day.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-1">
          <legend className={labelClass}>Length</legend>
          {COVER_LETTER_LENGTHS.map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-2.5 text-sm">
              <input
                type="radio"
                name={`${id}-length`}
                value={value}
                checked={length === value}
                onChange={() => setLength(value)}
              />
              {COVER_LETTER_LENGTH_LABELS[value]}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className={labelClass}>Tone</legend>
          <div className="grid grid-cols-2 gap-x-4">
            {COVER_LETTER_TONES.map((value) => (
              <label key={value} className="flex min-h-11 items-center gap-2.5 text-sm">
                <input
                  type="radio"
                  name={`${id}-tone`}
                  value={value}
                  checked={tone === value}
                  onChange={() => setTone(value)}
                />
                {COVER_LETTER_TONE_LABELS[value]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-steer`} className={labelClass}>
          What to stress (optional)
        </label>
        <input
          id={`${id}-steer`}
          className="inp"
          value={steer}
          maxLength={COVER_LETTER_LIMITS.steer}
          placeholder="The API testing work at my last job"
          onChange={(event) => setSteer(event.target.value)}
        />
      </div>

      <div>
        <button type="button" className="btn-d" disabled={draft.isPending} onClick={askToDraft}>
          {draft.isPending ? 'Drafting…' : letter ? 'Draft again' : 'Draft cover letter'}
        </button>
      </div>
      {draft.isPending && (
        <p role="status" className="text-sm text-fg-3">
          Reading the posting and your resume. Usually under a minute…
        </p>
      )}
      {draft.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(draft.error, 'Could not draft right now. Try again.')}
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
            maxLength={COVER_LETTER_LIMITS.postingText}
            onChange={(event) => setPosting(event.target.value)}
          />
          <div>
            <button
              type="submit"
              className="btn-d"
              disabled={posting.trim().length < 200 || draft.isPending}
            >
              Draft from this posting
            </button>
          </div>
        </form>
      )}

      {letter && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(text, { onSuccess: () => toast('Cover letter saved') });
          }}
        >
          <p className="text-sm" role="status">
            {edited
              ? 'Edited, not saved yet'
              : letter.savedAt
                ? `Saved on ${formatDateTime(letter.savedAt)}`
                : `Draft from ${formatDateTime(letter.draftedAt)}, not saved yet`}
            <span className="text-fg-3">
              {' '}
              · {COVER_LETTER_TONE_LABELS[letter.tone]}, {letter.length}
            </span>
          </p>
          {letter.resumeChanged && (
            <p className="text-sm text-amber" role="note">
              You have replaced your resume since this letter was drafted.
            </p>
          )}
          <label htmlFor={`${id}-text`} className={labelClass}>
            Cover letter text
          </label>
          <textarea
            id={`${id}-text`}
            rows={16}
            className="inp text-sm leading-relaxed"
            value={text}
            aria-describedby={`${id}-count`}
            aria-invalid={over || undefined}
            onChange={(event) => setText(event.target.value)}
          />
          <p id={`${id}-count`} className={over ? 'text-sm text-red' : 'text-xs text-fg-3'}>
            {words} word{words === 1 ? '' : 's'} · {characters} of {COVER_LETTER_LIMITS.letter}{' '}
            characters{over ? ': too long to save' : ''}
          </p>
          {save.isError && (
            <p role="alert" className="text-sm text-red">
              {errorText(save.error, 'Could not save. Try again.')}
            </p>
          )}
          {remove.isError && (
            <p role="alert" className="text-sm text-red">
              {errorText(remove.error, 'Could not remove. Try again.')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="btn-w"
              disabled={
                !text.trim() || over || save.isPending || (!edited && letter.savedAt !== null)
              }
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn-d"
              disabled={!text.trim()}
              onClick={() =>
                void navigator.clipboard
                  .writeText(text.trim())
                  .then(() => toast('Cover letter copied'))
                  .catch(() => toast('Copying is blocked in this browser'))
              }
            >
              Copy
            </button>
            {edited ? (
              <button type="button" className="btn-d" onClick={() => setText(letter.text)}>
                Undo edits
              </button>
            ) : (
              <Link to={`/applications/${application.id}/cover-letter`} className="btn-d">
                Print or save as PDF
              </Link>
            )}
            <button
              type="button"
              className="btn-d"
              disabled={remove.isPending}
              onClick={() => setConfirming('remove')}
            >
              Remove
            </button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={confirming === 'draft'}
        title="Replace this cover letter?"
        message={
          edited
            ? 'Drafting again replaces the letter, and your unsaved edits are lost.'
            : 'Drafting again replaces your saved letter with a new, unsaved draft.'
        }
        confirmLabel="Draft again"
        onConfirm={() => run(null)}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === 'remove'}
        title="Remove this cover letter?"
        message="The letter and the posting stored with it are deleted. This cannot be undone."
        confirmLabel="Remove"
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirming(null);
              toast('Cover letter removed');
            },
          })
        }
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
