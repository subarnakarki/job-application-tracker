import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayNumber,
  daysBetween,
  isValidDate,
  isValidTimeZone,
  localDateIn,
} from './dates';

describe('localDateIn', () => {
  it('returns the calendar date in the given zone, not in UTC', () => {
    const instant = '2026-11-05T03:00:00Z';

    expect(localDateIn(instant, 'UTC')).toBe('2026-11-05');
    expect(localDateIn(instant, 'America/New_York')).toBe('2026-11-04'); // 22:00 the day before
    expect(localDateIn(instant, 'Asia/Kolkata')).toBe('2026-11-05'); // 08:30
    expect(localDateIn(instant, 'Pacific/Auckland')).toBe('2026-11-05'); // 16:00
    expect(localDateIn(instant, 'Pacific/Kiritimati')).toBe('2026-11-05'); // UTC+14, 17:00
    expect(localDateIn('2026-11-05T11:00:00Z', 'Pacific/Kiritimati')).toBe('2026-11-06');
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(localDateIn(new Date('2026-11-05T12:00:00Z'), 'UTC')).toBe('2026-11-05');
  });

  it('handles the daylight-saving transition days in New York', () => {
    // Spring forward 2026-03-08 (02:00 EST -> 03:00 EDT); fall back 2026-11-01.
    expect(localDateIn('2026-03-08T06:59:59Z', 'America/New_York')).toBe('2026-03-08'); // 01:59 EST
    expect(localDateIn('2026-03-08T07:00:00Z', 'America/New_York')).toBe('2026-03-08'); // 03:00 EDT
    expect(localDateIn('2026-03-09T03:59:59Z', 'America/New_York')).toBe('2026-03-08'); // 23:59 EDT
    expect(localDateIn('2026-03-09T04:00:00Z', 'America/New_York')).toBe('2026-03-09');
    expect(localDateIn('2026-11-01T05:30:00Z', 'America/New_York')).toBe('2026-11-01'); // 01:30 EDT
    expect(localDateIn('2026-11-01T06:30:00Z', 'America/New_York')).toBe('2026-11-01'); // 01:30 EST again
    expect(localDateIn('2026-11-02T04:59:59Z', 'America/New_York')).toBe('2026-11-01'); // 23:59 EST
    expect(localDateIn('2026-11-02T05:00:00Z', 'America/New_York')).toBe('2026-11-02');
  });

  it('rejects an invalid instant and an unknown zone', () => {
    expect(() => localDateIn('not-a-date', 'UTC')).toThrow(RangeError);
    expect(() => localDateIn('2026-11-05T00:00:00Z', 'Mars/Olympus')).toThrow(RangeError);
  });

  it('matches an independent calculation for fixed-offset zones (property)', () => {
    // Etc/GMT+N means UTC-N (inverted sign). Oracle: shift the instant by hand.
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
        fc.integer({ min: -12, max: 14 }),
        (instant, offsetHours) => {
          const zone =
            offsetHours === 0
              ? 'Etc/GMT'
              : `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`;
          const shifted = new Date(instant.getTime() + offsetHours * 3_600_000);
          expect(localDateIn(instant, zone)).toBe(shifted.toISOString().slice(0, 10));
        },
      ),
    );
  });

  it('always yields a valid date string for any real zone and instant (property)', () => {
    const zones = [
      'UTC',
      'America/New_York',
      'Europe/London',
      'Asia/Kolkata',
      'Australia/Lord_Howe',
      'Pacific/Chatham',
    ];
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') }),
        fc.constantFrom(...zones),
        (instant, zone) => {
          expect(isValidDate(localDateIn(instant, zone))).toBe(true);
        },
      ),
    );
  });
});

describe('dayNumber, addDays, daysBetween', () => {
  it('counts days across month, year and leap-year boundaries', () => {
    expect(daysBetween('2026-11-05', '2026-11-12')).toBe(7);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2); // 2028 is a leap year
    expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1);
    expect(daysBetween('2026-11-12', '2026-11-05')).toBe(-7);
    expect(daysBetween('2026-11-05', '2026-11-05')).toBe(0);
  });

  it('adds and subtracts days', () => {
    expect(addDays('2026-11-05', 7)).toBe('2026-11-12');
    expect(addDays('2026-11-05', -7)).toBe('2026-10-29');
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('is its own inverse (property)', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1990-01-01T00:00:00Z'),
          max: new Date('2100-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: -4000, max: 4000 }),
        (date, days) => {
          const start = date.toISOString().slice(0, 10);
          const moved = addDays(start, days);
          expect(daysBetween(start, moved)).toBe(days);
          expect(addDays(moved, -days)).toBe(start);
        },
      ),
    );
  });

  it('rejects impossible and malformed dates', () => {
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-11-5',
      '26-11-05',
      '2026/11/05',
      '',
      '2026-11-05T00:00:00Z',
      '0099-01-01',
    ]) {
      expect(isValidDate(bad), bad).toBe(false);
      expect(() => dayNumber(bad), bad).toThrow(RangeError);
    }
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2027-02-29')).toBe(false);
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names, including aliases a browser may report', () => {
    for (const zone of [
      'UTC',
      'America/New_York',
      'Asia/Kolkata',
      'Asia/Calcutta',
      'Etc/GMT+5',
      'America/Argentina/Buenos_Aires',
    ]) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
  });

  it('rejects offsets, junk and unknown names', () => {
    for (const zone of [
      '+05:00',
      '-08:00',
      'GMT+5',
      '',
      ' UTC',
      'America/',
      '/UTC',
      'Mars/Olympus',
      'UTC; drop table users',
      '5',
    ]) {
      expect(isValidTimeZone(zone), zone).toBe(false);
    }
  });
});
