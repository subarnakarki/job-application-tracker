import { SORTS, STATUSES, localDateIn, type Sort, type Status } from '@jat/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatDate } from '../format';
import { STAGE_COLOR } from '../stage';
import { interviewText } from '../timeline';
import { dayOfMonth, upcoming, weekdayOf, windowLabel } from '../thisWeek';
import { useSlashToFocus } from '../useSlashToFocus';
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
import { useToast } from '../components/Toast';
import { Avatar } from '../components/ui/Avatar';
import { Glow } from '../components/ui/Glow';
import { PageHeader } from '../components/ui/PageHeader';
import { Pill } from '../components/ui/Pill';
import { Segmented } from '../components/ui/Segmented';

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
  const searchField = useRef<HTMLInputElement>(null);
  useSlashToFocus(searchField);
  const me = useMe();
  const pipeline = usePipeline(filters.q);
  const applications = useApplications(
    board ? { q: filters.q, followUp: filters.followUp } : filters,
  );
  // The "This week" tile always looks at everything, whatever the filters on the list below say.
  const everything = useApplications({});
  const move = useMoveApplication();
  const toast = useToast();

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.q ?? '') !== search.trim()) setFilters({ q: search.trim() || undefined });
    }, 250);
    return () => clearTimeout(timer);
  });

  const exportHref = `/api/applications/export.csv${toQueryString(filters)}`;
  const items = applications.data?.items ?? [];
  const onMove = (application: (typeof items)[number], to: Status) =>
    move.mutate(
      { application, to },
      { onSuccess: () => toast(`Moved ${application.company} to ${to}`) },
    );

  const today = localDateIn(new Date(), me.data?.timeZone ?? 'UTC');
  const week = upcoming(everything.data?.items ?? [], today);
  const interviewsThisWeek = week.filter((item) => item.kind === 'interview').length;
  const followUps = pipeline.data?.followUpCount;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Applications"
        subtitle={
          followUps === undefined || !everything.isSuccess ? undefined : (
            <>
              <span className="text-fg">
                {followUps} {followUps === 1 ? 'needs' : 'need'} a follow-up
              </span>{' '}
              and you have {interviewsThisWeek}{' '}
              {interviewsThisWeek === 1 ? 'interview' : 'interviews'} in the next 7 days.
            </>
          )
        }
        actions={
          <Link to="/applications/new" className="btn-w min-h-12 px-6 text-[0.9375rem]">
            Add application
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        {!board && (
          <Glow className="rise rise-3 min-w-0 p-5 lg:col-span-8">
            <h2 className="mb-3 flex justify-between text-[0.8125rem] font-medium text-fg-2">
              <span>Pipeline</span>
              <span className="tabular-nums">{pipeline.data?.total ?? 0} total</span>
            </h2>
            <PipelineBar
              pipeline={pipeline.data}
              selected={filters.status}
              onSelect={(status) => setFilters({ status })}
            />
          </Glow>
        )}
        <Glow
          aria-label="This week"
          role="region"
          className={`rise rise-4 min-w-0 p-5 ${board ? 'lg:col-span-12' : 'lg:col-span-4'}`}
        >
          <h2 className="flex justify-between text-[0.8125rem] font-medium text-fg-2">
            <span>This week</span>
            <span className="tabular-nums">{windowLabel(today)}</span>
          </h2>
          {week.length === 0 ? (
            <p className="mt-3 text-sm text-fg-2">
              Nothing scheduled in the next 7 days. Interviews and next-step dates show up here.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col">
              {week.slice(0, 5).map((item) => (
                <li
                  key={item.key}
                  className="relative flex items-center gap-3 border-t border-line py-2.5 first:border-t-0"
                >
                  <span className="w-11 flex-none text-center">
                    <b className="block text-xl leading-none font-semibold tracking-[-0.04em]">
                      {dayOfMonth(item.day)}
                    </b>
                    <small className="text-[0.6875rem] text-fg-3">{weekdayOf(item.day)}</small>
                  </span>
                  <span className="min-w-0 text-sm leading-snug">
                    <Link
                      to={`/applications/${item.applicationId}`}
                      className="block truncate after:absolute after:inset-0 after:content-['']"
                    >
                      {item.title}
                    </Link>
                    <span className="block truncate text-[0.8125rem] text-fg-2">
                      {item.company}
                    </span>
                  </span>
                  {item.kind === 'interview' && (
                    <Pill tone="iv" className="ml-auto">
                      Interview
                    </Pill>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Glow>
      </div>

      <div className="rise rise-5 flex flex-wrap items-center gap-2.5">
        <div className="relative flex h-11 min-w-56 flex-1 items-center gap-2.5 rounded-xl bg-s1 px-3.5 shadow-line focus-within:shadow-[inset_0_0_0_1px_var(--color-blue),0_0_0_4px_rgb(10_139_255/0.18)]">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 flex-none text-fg-3">
            <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M11 11l3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <label htmlFor="search" className="sr-only">
            Search
          </label>
          <input
            id="search"
            ref={searchField}
            type="search"
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-3"
            placeholder="Company, role, contact or notes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd
            aria-hidden="true"
            className="hidden rounded-[5px] border border-line-2 px-1.5 text-[0.6875rem] leading-[18px] text-fg-3 md:inline"
          >
            /
          </kbd>
        </div>
        {!board && (
          <>
            <label htmlFor="sort" className="sr-only">
              Sort by
            </label>
            <select
              id="sort"
              className="inp text-sm"
              value={filters.sort ?? 'updated_desc'}
              onChange={(event) => setFilters({ sort: event.target.value as Sort })}
            >
              {SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {SORT_LABEL[sort]}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          aria-pressed={filters.followUp === true}
          onClick={() => setFilters({ followUp: filters.followUp ? undefined : true })}
          className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 text-sm transition-colors hover:text-fg ${
            filters.followUp
              ? 'bg-amber/10 text-fg shadow-[inset_0_0_0_1px_rgb(255_178_36/0.4)]'
              : 'bg-s1 text-fg-2 shadow-line'
          }`}
        >
          Needs follow-up
          {followUps !== undefined && <b className="font-semibold text-amber">{followUps}</b>}
        </button>
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: 'List' },
            { value: 'board', label: 'Board' },
          ]}
        />
        {!me.data?.isDemo && (
          <a href={exportHref} className="btn-d" download>
            Export CSV
          </a>
        )}
      </div>

      <p aria-live="polite" className="-mt-3 text-sm text-fg-2">
        {applications.isSuccess &&
          `${applications.data.total} ${applications.data.total === 1 ? 'application' : 'applications'}`}
      </p>

      {move.isError && move.variables && (
        <p role="alert" className="rounded-xl bg-red/10 p-3 text-sm text-red">
          {moveErrorMessage(move.variables.application.company, move.error)}
        </p>
      )}

      {applications.isPending && <p className="text-fg-2">Loading…</p>}
      {applications.isError && <p className="text-red">Could not load your applications.</p>}
      {applications.isSuccess && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line-2 p-8 text-center">
          <p className="font-medium">No applications here yet.</p>
          <p className="mt-1 text-sm text-fg-2">
            {filters.status || filters.q || filters.followUp
              ? 'Try clearing the filters.'
              : 'Add the first one to get started.'}
          </p>
        </div>
      )}

      {board && applications.isSuccess && <BoardView items={items} onMove={onMove} />}

      {!board && items.length > 0 && (
        <Glow className="rise rise-6 p-1.5">
          <div
            aria-hidden="true"
            className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_8rem_11rem] gap-4 px-4 pt-2.5 pb-2 text-xs text-fg-3 md:grid"
          >
            <span>Company</span>
            <span>Signals</span>
            <span>Applied</span>
            <span>Stage</span>
          </div>
          <ul className="flex flex-col">
            {items.map((application) => {
              const interview = interviewText(application);
              const nextStep = application.nextStep
                ? `${application.nextStep}${application.nextStepDate ? `, ${formatDate(application.nextStepDate)}` : ''}`
                : application.nextStepDate
                  ? `Next step ${formatDate(application.nextStepDate)}`
                  : null;
              return (
                <li
                  key={application.id}
                  className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-[0.875rem] border-t border-line px-3 py-3 transition-colors first:border-t-0 hover:bg-white/[0.04] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-blue md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_8rem_11rem] md:px-4"
                >
                  <span className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
                    <Avatar name={application.company} color={STAGE_COLOR[application.status]} />
                    <span className="min-w-0">
                      {/* The link covers the whole row; the menu sits above it. */}
                      <Link
                        to={`/applications/${application.id}`}
                        className={`block truncate text-[0.9375rem] font-medium tracking-[-0.02em] outline-none after:absolute after:inset-0 after:content-[''] ${
                          application.isClosed ? 'text-fg-3' : ''
                        }`}
                      >
                        {application.company}
                      </Link>
                      <span className="block truncate text-[0.8125rem] text-fg-2">
                        {application.role}
                      </span>
                    </span>
                  </span>
                  {(application.needsFollowUp || interview || nextStep) && (
                    <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-[3.25rem] md:col-span-1 md:col-start-2 md:row-start-1 md:pl-0">
                      {application.needsFollowUp && <FollowUpFlag />}
                      {interview && (
                        <Pill tone="iv" dot>
                          {interview}
                        </Pill>
                      )}
                      {nextStep && <span className="text-[0.8125rem] text-fg-2">{nextStep}</span>}
                    </span>
                  )}
                  <span className="relative z-10 col-span-2 pl-[3.25rem] md:col-span-1 md:col-start-4 md:row-start-1 md:pl-0 [&>span]:flex [&>span]:w-full md:[&>span]:inline-flex md:[&>span]:w-auto">
                    <StatusMenu
                      company={application.company}
                      status={application.status}
                      onMove={(to) => onMove(application, to)}
                    />
                  </span>
                  <span className="hidden text-[0.8125rem] text-fg-2 tabular-nums md:col-start-3 md:row-start-1 md:block">
                    {application.dateApplied
                      ? `Applied ${formatDate(application.dateApplied)}`
                      : 'Not applied yet'}
                  </span>
                </li>
              );
            })}
          </ul>
        </Glow>
      )}
    </div>
  );
}
