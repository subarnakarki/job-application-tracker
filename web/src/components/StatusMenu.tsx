import { STATUSES, type Status } from '@jat/shared';

interface Props {
  company: string;
  status: Status;
  disabled?: boolean;
  onMove: (to: Status) => void;
}

/**
 * "Move to…": changes an application's stage in one step. A native select, so it works the same
 * with a mouse, a finger, the keyboard and a screen reader.
 */
export function StatusMenu({ company, status, disabled, onMove }: Props) {
  return (
    <select
      aria-label={`Move ${company} to`}
      className="input min-h-9 py-1 text-sm"
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
