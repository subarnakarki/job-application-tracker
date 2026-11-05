import type { Status } from '@jat/shared';

const STYLE: Record<Status, string> = {
  Saved: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  Applied: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  Screening: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200',
  Interviewing: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  Offer: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  Rejected: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  Withdrawn: 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200',
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLE[status]}`}>
      {status}
    </span>
  );
}

/** Shown with an icon AND text, so it never relies on colour alone. */
export function FollowUpFlag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <span aria-hidden="true">⏰</span> Needs follow-up
    </span>
  );
}
