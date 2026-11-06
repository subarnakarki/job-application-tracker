import type { Application, HistoryEntry, Interview } from '@jat/shared';
import { formatWeekdayDate } from './format';

export type TimelineItem =
  | { kind: 'status'; key: string; at: string; entry: HistoryEntry }
  | { kind: 'interview'; key: string; at: string; interview: Interview };

/**
 * Status changes and interviews in one list, newest first. A status change is placed at its
 * instant; an interview, which has only a day, at midday UTC of that day, so it sorts among the
 * changes of the same day and scheduled interviews come first.
 */
export function timeline(history: HistoryEntry[], interviews: Interview[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...history.map((entry) => ({
      kind: 'status' as const,
      key: `s-${entry.id}`,
      at: entry.occurredAt,
      entry,
    })),
    ...interviews.map((interview) => ({
      kind: 'interview' as const,
      key: `i-${interview.id}`,
      at: `${interview.heldOn}T12:00:00.000Z`,
      interview,
    })),
  ];
  return items.sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at < b.at ? 1 : -1));
}

/** What a card says about interviews: the next one if any is ahead, else how many there were. */
export function interviewText(
  application: Pick<Application, 'interviewCount' | 'nextInterviewOn'>,
): string | null {
  if (application.nextInterviewOn)
    return `Interview ${formatWeekdayDate(application.nextInterviewOn)}`;
  if (application.interviewCount === 0) return null;
  return application.interviewCount === 1
    ? '1 interview'
    : `${application.interviewCount} interviews`;
}
