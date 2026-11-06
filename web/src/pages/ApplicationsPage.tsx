import { SORTS, STATUSES, type Sort, type Status } from '@jat/shared';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatDate } from '../format';
import { interviewText } from '../timeline';
import {
  toQueryString,
  useApplications,
  useMe,
  useMoveApplication,
  usePipeline,
  type ListFilters,
} from '../api/hooks';
import { BoardView } from '../components/BoardView';
import { PipelineBar } from '../components/PipelineBar';
import { FollowUpFlag } from '../components/StatusBadge';
import { moveErrorMessage, StatusMenu } from '../components/StatusMenu';

const SORT_LABEL: Record<Sort, string> = {
  updated_desc: 'Recently updated',
  applied_desc: 'Date applied',
  company_asc: 'Company A–Z',
};

type View = 'list' | 'board';

/** Filters live in the URL, so they survive a reload and can be shared or bookmarked. */
function useFilters(): [ListFilters, (next: ListFilters) => void, View, (view: View) => void] {
  const [params, setParams] = useSearchParams();
  const status = params.get('status');
  const sort = params.get('sort');
  const filters: ListFilters = {
    status: STATUSES.includes(status as Status) ? (status as Status) : undefined,
    followUp: params.get('followUp') === 'true' ? true : undefined,
    q: params.get('q') ?? undefined,
    sort: SORTS.includes(sort as Sort) ? (sort as Sort) : undefined,
  };
  const view: View = params.get('view') === 'board' ? 'board' : 'list';
  const write = (next: ListFilters, nextView: View) => {
    const query = new URLSearchParams(toQueryString(next).slice(1));
    if (nextView === 'board') query.set('view', 'board');
    setParams(query, { replace: true });
  };
  const update = (next: ListFilters) => write({ ...filters, ...next }, view);
  // The stage filter and sort only mean something in the list.
  const setView = (nextView: View) =>
    write(nextView === 'board' ? { q: filters.q, followUp: filters.followUp } : filters, nextView);
  return [filters, update, view, setView];
}

export function ApplicationsPage() {
  const [filters, setFilters, view, setView] = useFilters();
  const board = view === 'board';
  const [search, setSearch] = useState(filters.q ?? '');
  const me = useMe();
  const pipeline = usePipeline(filters.q);
  const applications = useApplications(
    board ? { q: filters.q, followUp: filters.followUp } : filters,
  );
  const move = useMoveApplication();

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.q ?? '') !== search.trim()) setFilters({ q: search.trim() || undefined });
    }, 250);
    return () => clearTimeout(timer);
  });

  const exportHref = `/api/applications/export.csv${toQueryString(filters)}`;
  const items = applications.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Applications</h1>
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="View" className="flex">
            {(['list', 'board'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={`${view === option ? 'btn-primary' : 'btn-secondary'} ${
                  option === 'list' ? 'rounded-r-none' : 'rounded-l-none'
                }`}
              >
                {option === 'list' ? 'List' : 'Board'}
              </button>
            ))}
          </div>
          <Link to="/applications/new" className="btn-primary">
            Add application
          </Link>
        </div>
      </div>

      {!board && (
        <PipelineBar
          pipeline={pipeline.data}
          selected={filters.status}
          onSelect={(status) => setFilters({ status })}
        />
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor="search" className="text-sm font-medium">
            Search
          </label>
          <input
            id="search"
            type="search"
            className="input"
            placeholder="Company, role, contact or notes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {!board && (
          <div className="flex flex-col gap-1">
            <label htmlFor="sort" className="text-sm font-medium">
              Sort by
            </label>
            <select
              id="sort"
              className="input"
              value={filters.sort ?? 'updated_desc'}
              onChange={(event) => setFilters({ sort: event.target.value as Sort })}
            >
              {SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {SORT_LABEL[sort]}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          type="button"
          aria-pressed={filters.followUp === true}
          onClick={() => setFilters({ followUp: filters.followUp ? undefined : true })}
          className={filters.followUp ? 'btn-primary' : 'btn-secondary'}
        >
          Needs follow-up
          {pipeline.data ? ` (${pipeline.data.followUpCount})` : ''}
        </button>
        {!me.data?.isDemo && (
          <a href={exportHref} className="btn-secondary" download>
            Export CSV
          </a>
        )}
      </div>

      <p aria-live="polite" className="text-sm text-slate-600 dark:text-slate-300">
        {applications.isSuccess &&
          `${applications.data.total} ${applications.data.total === 1 ? 'application' : 'applications'}`}
      </p>

      {move.isError && move.variables && (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {moveErrorMessage(move.variables.application.company, move.error)}
        </p>
      )}

      {applications.isPending && <p>Loading…</p>}
      {applications.isError && <p className="text-rose-700">Could not load your applications.</p>}
      {applications.isSuccess && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <p className="font-medium">No applications here yet.</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {filters.status || filters.q || filters.followUp
              ? 'Try clearing the filters.'
              : 'Add the first one to get started.'}
          </p>
        </div>
      )}

      {board && applications.isSuccess && (
        <BoardView items={items} onMove={(application, to) => move.mutate({ application, to })} />
      )}

      {!board && (
        <ul className="flex flex-col gap-3">
          {items.map((application) => (
            <li
              key={application.id}
              className={`relative rounded-xl border border-slate-200 p-4 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-blue-600 dark:border-slate-800 dark:hover:bg-slate-900 ${
                application.isClosed ? 'opacity-60' : ''
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* The link covers the whole card; the menu sits above it. */}
                <Link
                  to={`/applications/${application.id}`}
                  className="font-semibold outline-none after:absolute after:inset-0 after:content-['']"
                >
                  {application.company}
                </Link>
                <span className="flex flex-wrap items-center gap-2">
                  {application.needsFollowUp && <FollowUpFlag />}
                  <span className="relative z-10">
                    <StatusMenu
                      company={application.company}
                      status={application.status}
                      onMove={(to) => move.mutate({ application, to })}
                    />
                  </span>
                </span>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-300">{application.role}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {application.dateApplied
                  ? `Applied ${formatDate(application.dateApplied)}`
                  : 'Not applied yet'}
                {application.nextStep ? ` · Next: ${application.nextStep}` : ''}
                {application.nextStepDate ? ` (${formatDate(application.nextStepDate)})` : ''}
                {interviewText(application) ? ` · ${interviewText(application)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
