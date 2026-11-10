import { SOURCE_LABELS } from '@jat/shared';
import { useId, useState } from 'react';
import { ApiRequestError } from '../api/client';
import { useUnwatchBoard, useWatchBoard, useWatchedBoards } from '../api/hooks';
import { formatDateTime } from '../format';
import { useToast } from './Toast';

const labelClass = 'text-[0.8125rem] font-medium text-fg-2';

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/**
 * The companies whose own job boards are read every hour: those the searches found, and those
 * added here by pasting a link. A new job on any of them reaches the queue within the hour.
 */
export function WatchedCompanies() {
  const boards = useWatchedBoards();
  const watch = useWatchBoard();
  const unwatch = useUnwatchBoard();
  const toast = useToast();
  const [link, setLink] = useState('');
  const headingId = useId();
  const inputId = useId();
  const hintId = useId();
  const items = boards.data?.items ?? [];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold tracking-[-0.02em]">
        Companies watched{boards.data ? ` (${String(items.length)})` : ''}
      </h2>
      <p className="text-sm text-fg-2">
        Each company&rsquo;s own job board is read every hour, so a new job reaches your queue soon
        after it is posted.
      </p>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!link.trim()) return;
          watch.mutate(link.trim(), {
            onSuccess: (board) => {
              setLink('');
              toast(`Watching ${board.company}`);
            },
          });
        }}
      >
        <label htmlFor={inputId} className={labelClass}>
          Add a company
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={inputId}
            type="url"
            inputMode="url"
            className="inp min-w-0 flex-1"
            placeholder="https://job-boards.greenhouse.io/company"
            value={link}
            aria-describedby={hintId}
            aria-invalid={watch.isError ? true : undefined}
            onChange={(event) => {
              setLink(event.target.value);
              if (watch.isError) watch.reset();
            }}
          />
          <button type="submit" className="btn-w" disabled={watch.isPending || !link.trim()}>
            {watch.isPending ? 'Checking…' : 'Watch'}
          </button>
        </div>
        <p id={hintId} className="text-xs text-fg-3">
          Paste a link to its Greenhouse, Lever or Ashby careers board, or to any of its jobs.
        </p>
        {watch.isError && (
          <p role="alert" className="text-sm text-red">
            {errorText(watch.error, 'That company could not be added.')}
          </p>
        )}
      </form>
      {boards.isError && (
        <p role="alert" className="text-sm text-red">
          The companies could not be loaded.
        </p>
      )}
      {boards.data && items.length === 0 && (
        <p className="text-fg-2">None yet: a search adds every company it finds.</p>
      )}
      {items.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-fg-2 hover:text-fg">
            <span className="group-open:hidden">Show the companies</span>
            <span className="hidden group-open:inline">Hide the companies</span>
          </summary>
          <ul aria-label="Companies watched" className="mt-3 flex flex-col gap-2">
            {items.map((board) => (
              <li
                key={board.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-tile bg-s2 p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{board.company}</p>
                  <p className="text-sm text-fg-3">
                    {SOURCE_LABELS[board.source]}
                    {board.addedBy === 'user' ? ' · added by you' : ''}
                    {' · '}
                    {board.lastError
                      ? 'could not be read last time'
                      : board.lastSweptAt
                        ? `read ${formatDateTime(board.lastSweptAt)}`
                        : 'not read yet'}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-d"
                  disabled={unwatch.isPending}
                  aria-label={`Stop watching ${board.company}`}
                  onClick={() =>
                    unwatch.mutate(board.id, {
                      onSuccess: () => toast(`Stopped watching ${board.company}`),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
