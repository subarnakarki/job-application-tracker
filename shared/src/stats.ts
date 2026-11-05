import { DATE_APPLIED_STATUSES, SOURCES, type Source, type Status } from './constants';

/** One application as stats see it: its source and every status it has ever had. */
export interface StatsSubject {
  source: Source;
  statuses: readonly Status[];
}

/** How far an application got. Each flag implies the ones before it. */
export interface StageFlags {
  applied: boolean;
  responded: boolean;
  interviewing: boolean;
  offer: boolean;
}

export interface StageCounts {
  total: number;
  applied: number;
  responded: number;
  interviewing: number;
  offers: number;
  /** responded / applied, or null when nothing was applied for. */
  responseRate: number | null;
}

export interface SourceStats extends StageCounts {
  source: Source;
}

export interface StatsSummary {
  /** Every source, in `SOURCES` order, including those with no applications. */
  sources: SourceStats[];
  totals: StageCounts;
}

/** Statuses that count as a response by themselves ("Screening or beyond"). */
const RESPONSE_STATUSES: readonly Status[] = ['Screening', 'Interviewing', 'Offer'];

/**
 * "Responded": ever reached Screening or beyond, or Rejected after Applied.
 * "Interviewing" includes an offer made without a recorded interview stage.
 */
export function reachedStages(statuses: readonly Status[]): StageFlags {
  const ever = new Set(statuses);
  const offer = ever.has('Offer');
  const interviewing = offer || ever.has('Interviewing');
  const responded =
    RESPONSE_STATUSES.some((status) => ever.has(status)) ||
    (ever.has('Rejected') && ever.has('Applied'));
  const applied = (DATE_APPLIED_STATUSES as readonly Status[]).some((status) => ever.has(status));
  return { applied, responded, interviewing, offer };
}

function emptyCounts(): StageCounts {
  return { total: 0, applied: 0, responded: 0, interviewing: 0, offers: 0, responseRate: null };
}

function add(counts: StageCounts, flags: StageFlags): void {
  counts.total += 1;
  if (flags.applied) counts.applied += 1;
  if (flags.responded) counts.responded += 1;
  if (flags.interviewing) counts.interviewing += 1;
  if (flags.offer) counts.offers += 1;
}

function withRate<T extends StageCounts>(counts: T): T {
  return {
    ...counts,
    responseRate: counts.applied === 0 ? null : counts.responded / counts.applied,
  };
}

export function summarizeBySource(subjects: readonly StatsSubject[]): StatsSummary {
  const bySource = new Map<Source, StageCounts>(SOURCES.map((source) => [source, emptyCounts()]));
  const totals = emptyCounts();
  for (const subject of subjects) {
    const flags = reachedStages(subject.statuses);
    add(bySource.get(subject.source) ?? emptyCounts(), flags);
    add(totals, flags);
  }
  return {
    sources: SOURCES.map((source) =>
      withRate({ source, ...(bySource.get(source) ?? emptyCounts()) }),
    ),
    totals: withRate(totals),
  };
}
