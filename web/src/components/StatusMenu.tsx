import { STATUSES, type Status } from '@jat/shared';
import { StageBars } from './ui/StageBars';

interface Props {
  company: string;
  status: Status;
  disabled?: boolean;
  /** Classes for the wrapper; the default gives the menu room for its longest stage name. */
  className?: string;
  onMove: (to: Status) => void;
}

/**
 * "Move to…": changes an application's stage in one step. A native select, so it works the same
 * with a mouse, a finger, the keyboard and a screen reader; the stage bars and chevron are decoration.
 */
export function StatusMenu({ company, status, disabled, className = 'min-w-40', onMove }: Props) {
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <span className="pointer-events-none absolute left-3.5 flex">
        <StageBars status={status} />
      </span>
      <select
        aria-label={`Move ${company} to`}
        className="inp w-full cursor-pointer appearance-none py-1 pr-9 pl-[3.25rem] text-sm"
        value={status}
        disabled={disabled}
        onChange={(event) => {
          const to = event.target.value as Status;
          if (to !== status) onMove(to);
        }}
      >
        {STATUSES.map((option) => (
          <option key={option} value={option}>
            {option === status ? option : `Move to ${option}`}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="pointer-events-none absolute right-3 size-3 text-fg-3"
      >
        <path
          d="M2.5 4.5 6 8l3.5-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** What to tell the user when a move did not save. */
export function moveErrorMessage(company: string, error: unknown): string {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (status === 412)
    return `${company} was changed somewhere else, so the move was not saved. Showing the latest version.`;
  if (status === 429) return 'Too many changes in a short time. Try again in a while.';
  return `Could not move ${company}. Try again.`;
}
