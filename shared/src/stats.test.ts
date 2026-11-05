import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SOURCES, STATUSES, type Status } from './constants';
import { StatsSchema } from './responses';
import { reachedStages, summarizeBySource, type StatsSubject } from './stats';

describe('reachedStages: responded', () => {
  it.each<[Status[], boolean]>([
    [['Saved'], false],
    [['Applied'], false],
    [['Saved', 'Applied', 'Screening'], true],
    [['Applied', 'Interviewing'], true],
    [['Applied', 'Offer'], true],
    [['Applied', 'Rejected'], true],
    [['Saved', 'Rejected'], false],
    [['Rejected'], false],
    [['Applied', 'Withdrawn'], false],
    [['Applied', 'Screening', 'Withdrawn'], true],
  ])('%j -> %s', (statuses, expected) => {
    expect(reachedStages(statuses).responded).toBe(expected);
  });
});

describe('reachedStages: other stages', () => {
  it('counts an offer without a recorded interview as interviewing', () => {
    expect(reachedStages(['Applied', 'Offer'])).toEqual({
      applied: true,
      responded: true,
      interviewing: true,
      offer: true,
    });
  });

  it('does not count Saved or Withdrawn alone as applied', () => {
    expect(reachedStages(['Saved', 'Withdrawn']).applied).toBe(false);
  });
});

describe('summarizeBySource', () => {
  const subjects: StatsSubject[] = [
    { source: 'LinkedIn', statuses: ['Applied'] },
    { source: 'LinkedIn', statuses: ['Applied', 'Rejected'] },
    { source: 'Referral', statuses: ['Applied', 'Screening', 'Interviewing'] },
    { source: 'Other', statuses: ['Saved'] },
  ];

  it('counts per source, lists every source in order, and totals them', () => {
    const summary = summarizeBySource(subjects);
    expect(summary.sources.map((row) => row.source)).toEqual([...SOURCES]);
    expect(summary.sources.find((row) => row.source === 'LinkedIn')).toEqual({
      source: 'LinkedIn',
      total: 2,
      applied: 2,
      responded: 1,
      interviewing: 0,
      offers: 0,
      responseRate: 0.5,
    });
    expect(summary.sources.find((row) => row.source === 'Other')?.responseRate).toBeNull();
    expect(summary.totals).toEqual({
      total: 4,
      applied: 3,
      responded: 2,
      interviewing: 1,
      offers: 0,
      responseRate: 2 / 3,
    });
    expect(StatsSchema.safeParse(summary).success).toBe(true);
  });

  it('is empty but complete with no applications', () => {
    const summary = summarizeBySource([]);
    expect(summary.sources).toHaveLength(SOURCES.length);
    expect(summary.totals).toMatchObject({ total: 0, responseRate: null });
  });

  it('keeps every count monotone: offers <= interviewing <= responded <= applied <= total', () => {
    const subject = fc.record({
      source: fc.constantFrom(...SOURCES),
      statuses: fc.array(fc.constantFrom(...STATUSES), { minLength: 1, maxLength: 6 }),
    });
    fc.assert(
      fc.property(fc.array(subject, { maxLength: 30 }), (list) => {
        const { sources, totals } = summarizeBySource(list);
        for (const row of [...sources, totals]) {
          expect(row.offers).toBeLessThanOrEqual(row.interviewing);
          expect(row.interviewing).toBeLessThanOrEqual(row.responded);
          expect(row.responded).toBeLessThanOrEqual(row.applied);
          expect(row.applied).toBeLessThanOrEqual(row.total);
        }
        expect(sources.reduce((sum, row) => sum + row.total, 0)).toBe(totals.total);
      }),
    );
  });
});
