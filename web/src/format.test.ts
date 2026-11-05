import { formatDate, formatDateTime } from './format';

describe('formatDate', () => {
  it('shows a calendar date as month, day and year', () => {
    expect(formatDate('2026-11-05')).toBe('Nov 5, 2026');
  });

  it('never moves a date to the day before (it is read in UTC, not local time)', () => {
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
  });

  it('leaves anything that is not a date as it is', () => {
    expect(formatDate('soon')).toBe('soon');
  });
});

describe('formatDateTime', () => {
  it('includes the time', () => {
    expect(formatDateTime('2026-11-05T19:21:46Z')).toMatch(/^Nov 5, 2026, \d{1,2}:\d{2}\s?[AP]M$/);
  });
});
