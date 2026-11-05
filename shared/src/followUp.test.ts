import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FOLLOW_UP_STATUSES, STATUSES, type Status } from './constants';
import { daysBetween, localDateIn } from './dates';
import { followUpWindow, needsFollowUp, type FollowUpSubject } from './followUp';

const NOW = '2026-11-05T15:00:00Z'; // Thursday; today is 2026-11-05 in UTC
const UTC = { now: NOW, timeZone: 'UTC' };

function subject(overrides: Partial<FollowUpSubject> = {}): FollowUpSubject {
  return {
    status: 'Applied',
    lastActivityAt: '2026-10-01T10:00:00Z',
    nextStepDate: null,
    ...overrides,
  };
}

describe('followUpWindow', () => {
  it('is today and the latest stale date, 7 calendar days earlier', () => {
    expect(followUpWindow(UTC)).toEqual({ today: '2026-11-05', staleOnOrBefore: '2026-10-29' });
  });

  it('uses the date in the user zone, not UTC', () => {
    // 02:00 UTC on the 6th is still the evening of the 5th in New York.
    const window = followUpWindow({ now: '2026-11-06T02:00:00Z', timeZone: 'America/New_York' });
    expect(window.today).toBe('2026-11-05');
  });
});

describe('needsFollowUp: status', () => {
  it.each(
    STATUSES.map((status) => [status, FOLLOW_UP_STATUSES.includes(status as never)] as const),
  )('%s -> %s when stale with no next step', (status, expected) => {
    expect(needsFollowUp(subject({ status }), UTC)).toBe(expected);
  });
});

describe('needsFollowUp: the 7-day boundary (calendar days)', () => {
  it.each([
    ['2026-10-30T00:00:00Z', 6, false],
    ['2026-10-30T23:59:59Z', 6, false],
    ['2026-10-29T23:59:59Z', 7, true], // late on the day 7 days ago still counts as 7
    ['2026-10-29T00:00:00Z', 7, true],
    ['2026-10-28T12:00:00Z', 8, true],
    ['2026-11-05T14:00:00Z', 0, false],
    ['2026-11-06T09:00:00Z', -1, false], // clock skew: activity "in the future" is not stale
  ])('last activity %s (%i days) -> %s', (lastActivityAt, days, expected) => {
    expect(daysBetween(localDateIn(lastActivityAt, 'UTC'), '2026-11-05')).toBe(days);
    expect(needsFollowUp(subject({ lastActivityAt }), UTC)).toBe(expected);
  });

  it('accepts a Date for lastActivityAt and now', () => {
    const result = needsFollowUp(subject({ lastActivityAt: new Date('2026-10-01T00:00:00Z') }), {
      now: new Date(NOW),
      timeZone: 'UTC',
    });
    expect(result).toBe(true);
  });
});

describe('needsFollowUp: next-step date', () => {
  it.each([
    [null, true],
    ['2026-01-01', true], // long past
    ['2026-11-04', true], // yesterday: not upcoming
    ['2026-11-05', false], // today: upcoming
    ['2026-11-06', false], // tomorrow
    ['2027-01-01', false],
  ])('nextStepDate %s -> %s (today is 2026-11-05)', (nextStepDate, expected) => {
    expect(needsFollowUp(subject({ nextStepDate }), UTC)).toBe(expected);
  });

  it('throws on a malformed next-step date instead of guessing', () => {
    expect(() => needsFollowUp(subject({ nextStepDate: '2026-02-30' }), UTC)).toThrow(RangeError);
    expect(() => needsFollowUp(subject({ nextStepDate: 'tomorrow' }), UTC)).toThrow(RangeError);
  });
});

describe('needsFollowUp: time zones', () => {
  it('the same instants can be stale in one zone and not in another', () => {
    const base = subject({ lastActivityAt: '2026-10-30T03:00:00Z' });
    // UTC: 2026-10-30 -> 2026-11-05 is 6 days. Los Angeles: 10-29 20:00 -> 11-05 07:00 is 7 days.
    expect(needsFollowUp(base, { now: NOW, timeZone: 'UTC' })).toBe(false);
    expect(needsFollowUp(base, { now: NOW, timeZone: 'America/Los_Angeles' })).toBe(true);
  });

  it('judges "upcoming" against the date in the user zone', () => {
    const base = subject({ nextStepDate: '2026-11-05' });
    const lateEvening = '2026-11-06T02:00:00Z';
    expect(needsFollowUp(base, { now: lateEvening, timeZone: 'UTC' })).toBe(true); // already the 6th
    expect(needsFollowUp(base, { now: lateEvening, timeZone: 'America/New_York' })).toBe(false); // still the 5th
  });

  it('rejects an unknown zone', () => {
    expect(() => needsFollowUp(subject(), { now: NOW, timeZone: 'Mars/Olympus' })).toThrow(
      RangeError,
    );
  });
});

describe('needsFollowUp: properties', () => {
  const instant = fc.date({
    min: new Date('2024-01-01T00:00:00Z'),
    max: new Date('2030-01-01T00:00:00Z'),
    noInvalidDate: true,
  });
  const zone = fc.constantFrom(
    'UTC',
    'America/New_York',
    'Asia/Kolkata',
    'Pacific/Auckland',
    'Pacific/Kiritimati',
    'America/Los_Angeles',
  );
  const dateString = instant.map((value) => value.toISOString().slice(0, 10));
  const status = fc.constantFrom<Status>(...STATUSES);

  it('never flags a status that cannot need follow-up', () => {
    fc.assert(
      fc.property(status, instant, instant, zone, (s, last, now, timeZone) => {
        fc.pre(!FOLLOW_UP_STATUSES.includes(s as never));
        expect(
          needsFollowUp({ status: s, lastActivityAt: last, nextStepDate: null }, { now, timeZone }),
        ).toBe(false);
      }),
    );
  });

  it('never flags when the next step is today or later', () => {
    fc.assert(
      fc.property(
        instant,
        instant,
        zone,
        fc.integer({ min: 0, max: 400 }),
        (last, now, timeZone, ahead) => {
          const { today } = followUpWindow({ now, timeZone });
          const nextStepDate = new Date(Date.parse(`${today}T00:00:00Z`) + ahead * 86_400_000)
            .toISOString()
            .slice(0, 10);
          expect(
            needsFollowUp(
              { status: 'Applied', lastActivityAt: last, nextStepDate },
              { now, timeZone },
            ),
          ).toBe(false);
        },
      ),
    );
  });

  it('is monotonic: older activity is always at least as stale', () => {
    fc.assert(
      fc.property(
        instant,
        instant,
        instant,
        zone,
        dateString,
        (a, b, now, timeZone, nextStepDate) => {
          const [older, newer] = a <= b ? [a, b] : [b, a];
          const input = { status: 'Screening' as const, nextStepDate };
          const newerFlag = needsFollowUp({ ...input, lastActivityAt: newer }, { now, timeZone });
          const olderFlag = needsFollowUp({ ...input, lastActivityAt: older }, { now, timeZone });
          if (newerFlag) expect(olderFlag).toBe(true);
        },
      ),
    );
  });

  it('matches an independent calculation for fixed-offset zones', () => {
    fc.assert(
      fc.property(
        status,
        instant,
        instant,
        fc.integer({ min: -12, max: 14 }),
        fc.option(dateString, { nil: null }),
        (s, last, now, offsetHours, nextStepDate) => {
          const timeZone =
            offsetHours === 0
              ? 'Etc/GMT'
              : `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`;
          const dateAt = (value: Date) =>
            new Date(value.getTime() + offsetHours * 3_600_000).toISOString().slice(0, 10);
          const today = dateAt(now);
          const stale = daysBetween(dateAt(last), today) >= 7;
          const upcoming = nextStepDate !== null && nextStepDate >= today;
          const expected = FOLLOW_UP_STATUSES.includes(s as never) && stale && !upcoming;

          expect(
            needsFollowUp({ status: s, lastActivityAt: last, nextStepDate }, { now, timeZone }),
          ).toBe(expected);
        },
      ),
    );
  });
});
