import type { ImportItem } from '@jat/shared';
import { Link, useParams } from 'react-router';
import { useImportAction, useImportRun, type ImportAction } from '../api/hooks';

const CHANGED = new Set<ImportItem['outcome']>(['created', 'status_changed', 'undone']);
const REVIEW = new Set<ImportItem['outcome']>(['needs_review', 'dismissed']);

function headline(item: ImportItem): string {
  const company = item.company ?? 'Unknown company';
  switch (item.outcome) {
    case 'created':
      return `Added ${company} as ${item.toStatus ?? 'Applied'}`;
    case 'status_changed':
      return `${company}: ${item.fromStatus ?? '?'} → ${item.toStatus ?? '?'}`;
    case 'undone':
      return `${company}: undone`;
    case 'dismissed':
      return `${company}: dismissed`;
    case 'needs_review':
      return item.proposedStatus ? `${company}: suggest ${item.proposedStatus}` : company;
    case 'ignored':
      return item.emailSubject || '(no subject)';
  }
}

function ItemCard({ item, runId }: { item: ImportItem; runId: string }) {
  const action = useImportAction(runId);
  const act = (name: ImportAction) => action.mutate({ itemId: item.id, action: name });
  const date = item.emailDate ? new Date(item.emailDate).toLocaleDateString() : null;
  const linkable = item.applicationId && item.outcome !== 'undone';

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-300 p-3 dark:border-slate-700">
      <h3 className="font-semibold">
        {linkable ? (
          <Link
            to={`/applications/${item.applicationId ?? ''}`}
            className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            {headline(item)}
          </Link>
        ) : (
          headline(item)
        )}
      </h3>
      {item.summary && <p className="text-sm">{item.summary}</p>}
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {item.reason && <span>{item.reason} · </span>}
        <span>
          &quot;{item.emailSubject || '(no subject)'}&quot; from {item.emailFrom || 'unknown'}
          {date ? `, ${date}` : ''}
        </span>
      </p>
      {(item.outcome === 'created' || item.outcome === 'status_changed') && (
        <div>
          <button
            type="button"
            className="btn-secondary"
            disabled={action.isPending}
            onClick={() => act('undo')}
          >
            Undo
          </button>
        </div>
      )}
      {item.outcome === 'needs_review' && (
        <div className="flex flex-wrap gap-2">
          {item.proposedStatus && (
            <button
              type="button"
              className="btn-primary"
              disabled={action.isPending}
              onClick={() => act('apply')}
            >
              {item.applicationId ? `Move to ${item.proposedStatus}` : 'Add application'}
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={action.isPending}
            onClick={() => act('dismiss')}
          >
            Dismiss
          </button>
        </div>
      )}
      {action.isError && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
          {action.error.message}
        </p>
      )}
    </li>
  );
}

/** What one Gmail import did: changes (with Undo), items to review, and what it skipped. */
export function ImportResultsPage() {
  const { runId = '' } = useParams();
  const run = useImportRun(runId);

  if (run.isPending) return <p className="text-sm">Loading…</p>;
  if (run.isError)
    return (
      <p role="alert" className="text-sm text-rose-700">
        This import could not be found.
      </p>
    );

  const { items, run: details } = run.data;
  const changed = items.filter((item) => CHANGED.has(item.outcome));
  const review = items.filter((item) => REVIEW.has(item.outcome));
  const ignored = items.filter((item) => item.outcome === 'ignored');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Gmail import</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {details.emailsScanned} emails matched · {changed.length} changed · {review.length} to
          review · {ignored.length} skipped
        </p>
      </div>

      <section aria-labelledby="changed-heading" className="flex flex-col gap-3">
        <h2 id="changed-heading" className="text-lg font-semibold">
          Changes made
        </h2>
        {changed.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">Nothing was changed.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Changes made">
            {changed.map((item) => (
              <ItemCard key={item.id} item={item} runId={runId} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="review-heading" className="flex flex-col gap-3">
        <h2 id="review-heading" className="text-lg font-semibold">
          Needs your review
        </h2>
        {review.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">Nothing to review.</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Needs your review">
            {review.map((item) => (
              <ItemCard key={item.id} item={item} runId={runId} />
            ))}
          </ul>
        )}
      </section>

      {ignored.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold">
            Skipped ({ignored.length}): not about an application, or nothing to change
          </summary>
          <ul className="mt-3 flex flex-col gap-3" aria-label="Skipped">
            {ignored.map((item) => (
              <ItemCard key={item.id} item={item} runId={runId} />
            ))}
          </ul>
        </details>
      )}

      <p className="text-sm">
        <Link to="/" className="text-blue-700 underline dark:text-blue-400">
          Back to applications
        </Link>
      </p>
    </div>
  );
}
