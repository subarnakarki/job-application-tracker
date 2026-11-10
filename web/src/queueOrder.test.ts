import { describe, expect, it } from 'vitest';
import { ago, orderQueue } from './queueOrder';

const hit = (id: string, postedAt: string | null, createdAt = '2026-11-09T12:00:00.000Z') => ({
  id,
  postedAt,
  createdAt,
});

describe('orderQueue', () => {
  const byFit = [
    hit('best-fit-old', '2026-11-02T09:00:00.000Z'),
    hit('new', '2026-11-09T10:00:00.000Z'),
    hit('no-date-found-late', null, '2026-11-09T11:00:00.000Z'),
    hit('tie-a', '2026-11-05T00:00:00.000Z'),
    hit('tie-b', '2026-11-05T00:00:00.000Z'),
  ];

  it('puts the newest posting first, a job without a date by when it was found', () => {
    expect(orderQueue(byFit, 'newest').map((entry) => entry.id)).toEqual([
      'no-date-found-late',
      'new',
      'tie-a',
      'tie-b',
      'best-fit-old',
    ]);
  });

  it('keeps the given order for best fit, and never changes the list it was given', () => {
    const before = byFit.map((entry) => entry.id);
    expect(orderQueue(byFit, 'fit').map((entry) => entry.id)).toEqual(before);
    orderQueue(byFit, 'newest');
    expect(byFit.map((entry) => entry.id)).toEqual(before);
  });
});

describe('ago', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');
  it.each([
    ['2026-11-09T11:59:40.000Z', 'just now'],
    ['2026-11-09T11:59:00.000Z', '1 minute ago'],
    ['2026-11-09T11:15:00.000Z', '45 minutes ago'],
    ['2026-11-09T10:00:00.000Z', '2 hours ago'],
    ['2026-11-08T12:00:00.000Z', '1 day ago'],
    ['2026-10-30T12:00:00.000Z', '10 days ago'],
    // A clock a little ahead of the server's never shows a negative time.
    ['2026-11-09T12:00:05.000Z', 'just now'],
  ])('%s is %s', (instant, text) => {
    expect(ago(instant, now)).toBe(text);
  });
});
