/**
 * Time is injected so tests (and, in Phase 3, a per-user test clock) control
 * "now" instead of sleeping or patching globals.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(instant: Date | string): Clock {
  // Always copy: holding the caller's Date would let them move the clock by mutating it.
  const fixed = new Date(instant);
  if (Number.isNaN(fixed.getTime())) throw new RangeError('Invalid instant');
  return { now: () => new Date(fixed.getTime()) };
}
