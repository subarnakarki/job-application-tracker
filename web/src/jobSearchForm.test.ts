import { EMPTY_MORE_ANSWERS, SEARCH_SOURCES } from '@jat/shared';
import { describe, expect, it } from 'vitest';
import {
  emptySetup,
  fromSetupValues,
  MORE_GROUPS,
  moreAnswerRows,
  setMoreAnswer,
  previewSearches,
  scheduleText,
  toSetupValues,
} from './jobSearchForm';

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
      queries: [],
      sites: [...SEARCH_SOURCES],
      timeframeDays: 30,
      runHour: 8,
    });
    expect(toSetupValues(result.profile).includeTitles).toBe(
      'product manager\nsenior product manager',
    );
  });

  it('names the field with each problem', () => {
    const result = fromSetupValues({
      ...filled,
      salaryMin: 'lots',
      phone: '',
      includeTitles: ' ',
      sites: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      'includeTitles',
      'phone',
      'salaryMin',
      'sites',
    ]);
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

describe('search preview', () => {
  it('shows the searches the current answers make', () => {
    expect(
      previewSearches({ queries: '', includeTitles: 'SDET\nQA lead', sites: ['lever'] }),
    ).toEqual(['site:jobs.lever.co "SDET"', 'site:jobs.lever.co "QA lead"']);
  });
});

describe('more answers (optional)', () => {
  const field = (key: string) => {
    const found = MORE_GROUPS.flatMap((group) => group.fields).find((entry) => entry.key === key);
    if (!found) throw new Error(key);
    return found;
  };

  it('starts every answer at Not set, and the review lists none of them', () => {
    expect(emptySetup({}).more).toEqual(EMPTY_MORE_ANSWERS);
    expect(moreAnswerRows(EMPTY_MORE_ANSWERS)).toEqual([]);
  });

  it('offers every optional answer exactly once', () => {
    const keys = MORE_GROUPS.flatMap((group) => group.fields.map((entry) => entry.key));
    expect([...keys].sort()).toEqual(Object.keys(EMPTY_MORE_ANSWERS).sort());
  });

  it('sets and clears answers from the form controls, and lists only those set', () => {
    let more = setMoreAnswer(EMPTY_MORE_ANSWERS, field('usCitizen'), 'yes');
    more = setMoreAnswer(more, field('clearance'), 'eligible');
    more = setMoreAnswer(more, field('birthCountry'), 'Nepal');
    expect(moreAnswerRows(more)).toEqual([
      ['U.S. citizen?', 'Yes'],
      ['Country of birth', 'Nepal'],
      ['Security clearance', 'I am eligible for one'],
    ]);
    more = setMoreAnswer(more, field('usCitizen'), '');
    expect(more.usCitizen).toBeNull();
  });

  it('keeps the answers through the form and names the field with a problem', () => {
    const more = { ...EMPTY_MORE_ANSWERS, usPerson: 'yes' as const, w2Rate: '$85/hr' };
    const result = fromSetupValues({ ...filled, more });
    if (!result.ok) throw new Error('invalid');
    expect(result.profile.more).toEqual(more);
    expect(toSetupValues(result.profile).more).toEqual(more);
    const bad = fromSetupValues({ ...filled, more: { ...more, pronouns: 'He\nHim' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toEqual({ 'more.pronouns': 'Must be a single line' });
  });
});
