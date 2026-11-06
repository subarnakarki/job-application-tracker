import { describe, expect, it } from 'vitest';
import { emptySetup, fromSetupValues, scheduleText, toSetupValues } from './jobSearchForm';

const filled = {
  ...emptySetup({ name: 'Pat Example', email: 'pat@example.com' }),
  phone: '+1 555 010 0199',
  city: 'Boston',
  state: 'MA',
  workAuthorization: 'US citizen',
  salaryMin: '$150,000',
  includeTitles: 'product manager\n\n  senior product manager  ',
};

describe('job search setup form', () => {
  it('turns the form into a profile: amounts, lists one per line, numbers', () => {
    const result = fromSetupValues(filled);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({
      fullName: 'Pat Example',
      salaryMin: 150000,
      salaryMax: null,
      includeTitles: ['product manager', 'senior product manager'],
      queries: ['site:job-boards.greenhouse.io "product manager"'],
      timeframeDays: 1,
      runHour: 8,
    });
    expect(toSetupValues(result.profile).includeTitles).toBe(
      'product manager\nsenior product manager',
    );
  });

  it('names the field with each problem', () => {
    const result = fromSetupValues({ ...filled, salaryMin: 'lots', phone: '', queries: ' ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['phone', 'queries', 'salaryMin']);
    expect(result.errors).toMatchObject({ phone: 'Required', salaryMin: 'Enter a number' });
  });

  it('describes the schedule', () => {
    const result = fromSetupValues({
      ...filled,
      cadence: 'weekly',
      runWeekday: '5',
      runHour: '13',
    });
    if (!result.ok) throw new Error('invalid');
    expect(scheduleText(result.profile)).toBe('Every Friday at 1:00 PM');
    expect(scheduleText({ ...result.profile, cadence: 'weekdays', runHour: 0 })).toBe(
      'Every weekday at 12:00 AM',
    );
    expect(scheduleText({ ...result.profile, scheduleOn: false })).toBe('Off (run by hand only)');
  });
});
