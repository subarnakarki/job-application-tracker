import type { ImportItem } from '@jat/shared';
import { Link, useParams } from 'react-router';
import { useImportAction, useImportRun, type ImportAction } from '../api/hooks';
import { formatDay } from '../format';
import { useToast } from '../components/Toast';
import { Glow } from '../components/ui/Glow';
import { PageHeader } from '../components/ui/PageHeader';

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
  const toast = useToast();
  const act = (name: ImportAction) =>
    action.mutate(
      { itemId: item.id, action: name },
      {
        onSuccess: () =>
          toast(name === 'undo' ? 'Undone' : name === 'apply' ? 'Applied' : 'Dismissed'),
      },
    );
  const date = item.emailDate ? formatDay(item.emailDate) : null;
  const linkable = item.applicationId && item.outcome !== 'undone';

  return (
    <li className="flex flex-col gap-2 border-t border-line py-4 first:border-t-0">
      <h3 className="font-medium tracking-[-0.01em]">
        {linkable ? (
          <Link
            to={`/applications/${item.applicationId ?? ''}`}
            className="link underline-offset-2 hover:underline"
          >
            {headline(item)}
          </Link>
        ) : (
          headline(item)
        )}
      </h3>
      {item.summary && <p className="text-sm text-fg-2">{item.summary}</p>}
      <p className="text-[0.8125rem] text-fg-3">
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
            className="btn-d"
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
              className="btn-w"
              disabled={action.isPending}
              onClick={() => act('apply')}
            >
              {item.applicationId ? `Move to ${item.proposedStatus}` : 'Add application'}
            </button>
          )}
          <button
            type="button"
            className="btn-d"
            disabled={action.isPending}
            onClick={() => act('dismiss')}
          >
            Dismiss
          </button>
        </div>
      )}
      {action.isError && (
        <p role="alert" className="text-sm text-red">
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

  if (run.isPending) return <p className="text-sm text-fg-2">Loading…</p>;
  if (run.isError)
    return (
      <p role="alert" className="text-sm text-red">
        This import could not be found.
      </p>
    );

  const { items, run: details } = run.data;
  const changed = items.filter((item) => CHANGED.has(item.outcome));
  const review = items.filter((item) => REVIEW.has(item.outcome));
  const ignored = items.filter((item) => item.outcome === 'ignored');

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        title="Gmail import"
        subtitle={`${details.emailsScanned} emails matched · ${changed.length} changed · ${review.length} to review · ${ignored.length} skipped`}
      />

      <Glow as="section" aria-labelledby="changed-heading" className="rise rise-3 p-5">
        <h2 id="changed-heading" className="text-[0.8125rem] font-medium text-fg-2">
          Changes made
        </h2>
        {changed.length === 0 ? (
          <p className="mt-3 text-sm text-fg-2">Nothing was changed.</p>
        ) : (
          <ul className="mt-2 flex flex-col" aria-label="Changes made">
            {changed.map((item) => (
              <ItemCard key={item.id} item={item} runId={runId} />
            ))}
          </ul>
        )}
      </Glow>

      <Glow as="section" aria-labelledby="review-heading" className="review-tile rise rise-4 p-5">
        <h2 id="review-heading" className="text-[0.8125rem] font-medium text-fg-2">
          Needs your review
        </h2>
        {review.length === 0 ? (
          <p className="mt-3 text-sm text-fg-2">Nothing to review.</p>
        ) : (
          <ul className="mt-2 flex flex-col" aria-label="Needs your review">
            {review.map((item) => (
              <ItemCard key={item.id} item={item} runId={runId} />
            ))}
          </ul>
        )}
      </Glow>

      {ignored.length > 0 && (
        <Glow className="rise rise-5 p-5">
          <details className="text-sm">
            <summary className="flex min-h-11 cursor-pointer items-center font-medium text-fg-2">
              Skipped ({ignored.length}): not about an application, or nothing to change
            </summary>
            <ul className="mt-2 flex flex-col" aria-label="Skipped">
              {ignored.map((item) => (
                <ItemCard key={item.id} item={item} runId={runId} />
              ))}
            </ul>
          </details>
        </Glow>
      )}

      <p className="text-sm">
        <Link to="/" className="link underline">
          Back to applications
        </Link>
      </p>
    </div>
  );
}
