import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock } from './clock';

describe('clock', () => {
  it('systemClock follows real time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('fixedClock always returns the same instant, from a string or a Date', () => {
    for (const clock of [
      fixedClock('2026-11-05T15:00:00Z'),
      fixedClock(new Date('2026-11-05T15:00:00Z')),
    ]) {
      expect(clock.now().toISOString()).toBe('2026-11-05T15:00:00.000Z');
      expect(clock.now().toISOString()).toBe('2026-11-05T15:00:00.000Z');
    }
  });

  it('is not affected by a caller mutating the returned Date', () => {
    const clock = fixedClock('2026-11-05T15:00:00Z');

    clock.now().setUTCFullYear(1999);

    expect(clock.now().toISOString()).toBe('2026-11-05T15:00:00.000Z');
  });

  it('is not affected by mutating the Date it was built from', () => {
    const source = new Date('2026-11-05T15:00:00Z');
    const clock = fixedClock(source);

    source.setUTCFullYear(1999);

    expect(clock.now().toISOString()).toBe('2026-11-05T15:00:00.000Z');
  });

  it('rejects an invalid instant', () => {
    expect(() => fixedClock('not a date')).toThrow(RangeError);
  });
});
