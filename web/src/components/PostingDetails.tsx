import type { ApplicationDetail } from '@jat/shared';
import { useState } from 'react';
import { ApiRequestError } from '../api/client';
import {
  useApplySuggestion,
  useDismissSuggestion,
  useFindPosting,
  usePostingPreview,
  useUpdateApplication,
} from '../api/hooks';
import { fillEmpty, toFormValues, toPatch, validate } from '../form';
import { formatDate } from '../format';
import { useToast } from './Toast';
import { Glow } from './ui/Glow';

/** How each job board is named to people (the server's names, see postings/boards.ts). */
const BOARD_NAMES: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  rippling: 'Rippling',
  smartrecruiters: 'SmartRecruiters',
  breezy: 'Breezy HR',
  recruitee: 'Recruitee',
  teamtailor: 'Teamtailor',
  personio: 'Personio',
};

const failure = (error: unknown) =>
  error instanceof ApiRequestError && error.code === 'version_conflict'
    ? 'This application was changed somewhere else. Reload the page, then try again.'
    : error instanceof ApiRequestError
      ? error.message
      : 'Something went wrong. Try again.';

/**
 * A posting found on the company's job board after an import (the email had no link). Nothing is
 * changed until the user says so: "Use these details" fills only empty fields; Dismiss drops it.
 */
export function SuggestionCard({ application }: { application: ApplicationDetail }) {
  const suggestion = application.postingSuggestion;
  const apply = useApplySuggestion(application.id);
  const dismiss = useDismissSuggestion(application.id);
  const toast = useToast();
  if (!suggestion) return null;
  const board = BOARD_NAMES[suggestion.source] ?? suggestion.source;
  const salary =
    suggestion.salaryMin !== null && suggestion.salaryMax !== null
      ? `${suggestion.salaryMin.toLocaleString()}–${suggestion.salaryMax.toLocaleString()} ${suggestion.salaryCurrency ?? ''}`.trim()
      : null;
  const facts = [
    suggestion.location,
    suggestion.workMode,
    salary,
    suggestion.postedOn && `Posted ${formatDate(suggestion.postedOn)}`,
  ].filter(Boolean);
  const busy = apply.isPending || dismiss.isPending;
  const error = apply.error ?? dismiss.error;

  return (
    <Glow
      as="section"
      aria-labelledby="suggestion-heading"
      className="review-tile rise rise-3 flex flex-col gap-3 p-5"
    >
      <div>
        <h2 id="suggestion-heading" className="text-[0.8125rem] font-medium text-fg-2">
          Possible posting found on {board}
        </h2>
        <p className="mt-1 text-[0.9375rem]">
          <a
            href={suggestion.jobLink}
            target="_blank"
            rel="noopener noreferrer"
            className="link underline"
          >
            {suggestion.role ?? 'View the posting'}
          </a>
        </p>
        {facts.length > 0 && <p className="mt-1 text-sm text-fg-2">{facts.join(' · ')}</p>}
        <p className="mt-2 text-xs text-fg-3">
          Found by the company name and role, so check it is the right job. Using it fills only the
          fields that are still empty.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red">
          {failure(error)}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="btn-w"
          disabled={busy}
          onClick={() =>
            apply.mutate(
              { version: application.version },
              { onSuccess: () => toast('Filled in from the posting') },
            )
          }
        >
          Use these details
        </button>
        <button
          type="button"
          className="btn-d"
          disabled={busy}
          onClick={() => dismiss.mutate(undefined, { onSuccess: () => toast('Dismissed') })}
        >
          Not this job
        </button>
      </div>
    </Glow>
  );
}

/**
 * "Fill from posting": reads the application's job link again and fills its empty fields, in one
 * save. Never overwrites what is there.
 */
export function FillFromPostingButton({ application }: { application: ApplicationDetail }) {
  const preview = usePostingPreview();
  const update = useUpdateApplication(application.id);
  const toast = useToast();
  const [message, setMessage] = useState<string | null>(null);
  if (!application.jobLink) return null;
  const busy = preview.isPending || update.isPending;

  const fill = () => {
    setMessage(null);
    preview.mutate(application.jobLink ?? '', {
      onSuccess: (found) => {
        const { values, filled } = fillEmpty(toFormValues(application), found);
        const checked = validate(values);
        if (filled === 0 || 'errors' in checked) {
          setMessage('Nothing new to fill: the posting has nothing these fields lack.');
          return;
        }
        const patch = toPatch(application, checked.input);
        if (Object.keys(patch).length === 0) {
          setMessage('Nothing new to fill: the posting has nothing these fields lack.');
          return;
        }
        update.mutate(
          { version: application.version, patch },
          {
            onSuccess: () =>
              toast(`Filled ${filled} ${filled === 1 ? 'field' : 'fields'} from the posting`),
            onError: (error) => setMessage(failure(error)),
          },
        );
      },
      onError: (error) => setMessage(failure(error)),
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn-d min-h-12 px-6 text-[0.9375rem]"
        disabled={busy}
        onClick={fill}
      >
        {busy ? 'Reading the posting…' : 'Fill from posting'}
      </button>
      {message && (
        <p role="status" className="max-w-[28ch] text-right text-xs text-fg-2">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * "Find posting": for an application with no job link, looks for the role on the company's public
 * job boards. A match shows up as the suggestion card; nothing is changed until it is used.
 */
export function FindPostingButton({ application }: { application: ApplicationDetail }) {
  const find = useFindPosting(application.id);
  const toast = useToast();
  const [message, setMessage] = useState<string | null>(null);
  if (application.jobLink || application.postingSuggestion) return null;

  const look = () => {
    setMessage(null);
    find.mutate(undefined, {
      onSuccess: (found) => {
        if (found.postingSuggestion) toast('Found a possible posting');
        else
          setMessage(
            "No matching posting on the company's public job boards. Add the job link by hand.",
          );
      },
      onError: (error) => setMessage(failure(error)),
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn-d min-h-12 px-6 text-[0.9375rem]"
        disabled={find.isPending}
        onClick={look}
      >
        {find.isPending ? 'Looking…' : 'Find posting'}
      </button>
      {message && (
        <p role="status" className="max-w-[28ch] text-right text-xs text-fg-2">
          {message}
        </p>
      )}
    </div>
  );
}
