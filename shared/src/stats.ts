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

/** Raw counts for one source, before rates and totals (what the SQL query returns). */
export type SourceCounts = Omit<SourceStats, 'responseRate'>;

function withRate<T extends Omit<StageCounts, 'responseRate'>>(counts: T): T & StageCounts {
  return {
    ...counts,
    responseRate: counts.applied === 0 ? null : counts.responded / counts.applied,
  };
}

/** Fills in missing sources (as zeros), adds totals and response rates. */
export function statsSummary(rows: readonly SourceCounts[]): StatsSummary {
  const bySource = new Map(rows.map((row) => [row.source, row]));
  const sources = SOURCES.map((source) =>
    withRate(
      bySource.get(source) ?? {
        source,
        total: 0,
        applied: 0,
        responded: 0,
        interviewing: 0,
        offers: 0,
      },
    ),
  );
  const sum = (key: keyof Omit<StageCounts, 'responseRate'>) =>
    sources.reduce((total, row) => total + row[key], 0);
  return {
    sources,
    totals: withRate({
      total: sum('total'),
      applied: sum('applied'),
      responded: sum('responded'),
      interviewing: sum('interviewing'),
      offers: sum('offers'),
    }),
  };
}

export function summarizeBySource(subjects: readonly StatsSubject[]): StatsSummary {
  const counts = new Map<Source, SourceCounts>();
  for (const subject of subjects) {
    const flags = reachedStages(subject.statuses);
    const row = counts.get(subject.source) ?? {
      source: subject.source,
      total: 0,
      applied: 0,
      responded: 0,
      interviewing: 0,
      offers: 0,
    };
    row.total += 1;
    if (flags.applied) row.applied += 1;
    if (flags.responded) row.responded += 1;
    if (flags.interviewing) row.interviewing += 1;
    if (flags.offer) row.offers += 1;
    counts.set(subject.source, row);
  }
  return statsSummary([...counts.values()]);
}
