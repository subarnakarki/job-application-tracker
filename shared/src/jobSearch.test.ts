import { describe, expect, it } from 'vitest';
import {
  assembleDraft,
  DEFAULT_QUERY,
  googleSearchUrl,
  isRunDue,
  JobSearchProfileSchema,
  jobRefOf,
  localClock,
  parseQuery,
  pickOption,
  profileAnswer,
  profileQuestionKind,
  questionsForModel,
  sortJob,
  uniqueJobRefs,
  type ApplicationQuestion,
  type JobFacts,
  type ModelDraft,
  type JobSearchProfile,
  type SortRules,
} from './jobSearch';

describe('parseQuery', () => {
  it('reads the default query', () => {
    expect(parseQuery(DEFAULT_QUERY)).toEqual({
      sources: ['greenhouse'],
      terms: ['product manager'],
      excluded: [],
    });
  });

  it('reads several sites, OR, bare words and exclusions', () => {
    expect(
      parseQuery(
        'site:jobs.lever.co OR site:jobs.ashbyhq.com "QA engineer" OR SDET -intern -"contract role"',
      ),
    ).toEqual({
      sources: ['lever', 'ashby'],
      terms: ['QA engineer', 'SDET'],
      excluded: ['intern', 'contract role'],
    });
  });

  it('searches every board when no known site is named, and ignores other operators', () => {
    expect(parseQuery('site:example.com "data analyst" intitle:remote')).toEqual({
      sources: ['greenhouse', 'lever', 'ashby', 'workday'],
      terms: ['data analyst'],
      excluded: [],
    });
    expect(parseQuery('site:acme.wd5.myworkdayjobs.com SDET').sources).toEqual(['workday']);
  });

  it('builds the Google link with the time filter', () => {
    expect(googleSearchUrl(DEFAULT_QUERY, 1)).toBe(
      'https://www.google.com/search?q=site%3Ajob-boards.greenhouse.io%20%22product%20manager%22&tbs=qdr:d',
    );
    expect(googleSearchUrl('x', 3)).toMatch(/&tbs=qdr:d3$/);
  });
});

describe('jobRefOf', () => {
  it.each([
    [
      'https://job-boards.greenhouse.io/GitLab/jobs/8638232002?gh_src=abc',
      { source: 'greenhouse', board: 'gitlab', jobId: '8638232002' },
      'https://job-boards.greenhouse.io/gitlab/jobs/8638232002',
    ],
    [
      'https://boards.greenhouse.io/acme/jobs/42#app',
      { source: 'greenhouse', board: 'acme', jobId: '42' },
      'https://job-boards.greenhouse.io/acme/jobs/42',
    ],
    [
      'https://boards.greenhouse.io/embed/job_app?for=acme&token=77',
      { source: 'greenhouse', board: 'acme', jobId: '77' },
      'https://job-boards.greenhouse.io/acme/jobs/77',
    ],
    [
      'https://jobs.lever.co/palantir/6ED76CE8-4156-4b60-b120-403538bd66cd/apply',
      { source: 'lever', board: 'palantir', jobId: '6ed76ce8-4156-4b60-b120-403538bd66cd' },
      'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd',
    ],
    [
      'https://jobs.ashbyhq.com/Ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application',
      { source: 'ashby', board: 'Ashby', jobId: '7458d4e9-da2e-47bd-98cb-adfda43d42b2' },
      'https://jobs.ashbyhq.com/Ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2',
    ],
    [
      'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Boston-MA/QA-Engineer_R123?q=1',
      { source: 'workday', board: 'acme', jobId: 'QA-Engineer_R123' },
      'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Boston-MA/QA-Engineer_R123',
    ],
  ])('reads %s', (raw, ref, link) => {
    expect(jobRefOf(raw)).toEqual({ ...ref, link });
  });

  it.each([
    'https://job-boards.greenhouse.io/gitlab',
    'https://job-boards.greenhouse.io/gitlab/jobs/not-a-number',
    'https://jobs.lever.co/palantir',
    'https://jobs.ashbyhq.com/Ashby',
    'https://acme.wd5.myworkdayjobs.com/en-US/External',
    'https://evil.example/job-boards.greenhouse.io/acme/jobs/1',
    'https://job-boards.greenhouse.io.evil.example/acme/jobs/1',
    'javascript:alert(1)',
    'not a url',
  ])('ignores %s', (raw) => {
    expect(jobRefOf(raw)).toBeNull();
  });

  it('keeps each job once, however it was linked', () => {
    expect(
      uniqueJobRefs([
        'https://job-boards.greenhouse.io/acme/jobs/1',
        'https://boards.greenhouse.io/acme/jobs/1?utm=x',
        'https://example.com',
        'https://job-boards.greenhouse.io/acme/jobs/2',
      ]).map((ref) => ref.jobId),
    ).toEqual(['1', '2']);
  });
});

describe('sortJob', () => {
  const NOW = new Date('2026-11-06T12:00:00Z');
  const rules: SortRules = {
    includeTitles: ['product manager'],
    skipTitles: ['intern', 'director'],
    queryTerms: [],
    workModes: ['Remote', 'Hybrid'],
    timeframeDays: 1,
    now: NOW,
  };
  const job = (overrides: Partial<JobFacts> = {}): JobFacts => ({
    source: 'greenhouse',
    title: 'Senior Product Manager',
    text: 'Own the roadmap.',
    workMode: 'Remote',
    postedAt: new Date('2026-11-06T02:00:00Z'),
    alreadyTracked: false,
    ...overrides,
  });

  it.each<[string, Partial<JobFacts>, Partial<SortRules>, string, string]>([
    ['a matching title', {}, {}, 'target', 'Matches your titles'],
    ['an unknown date', { postedAt: null }, {}, 'target', 'Matches your titles'],
    [
      'a posting older than the timeframe',
      { postedAt: new Date('2026-11-05T11:59:00Z') },
      {},
      'skipped',
      'Posted more than 1 day ago',
    ],
    [
      'a posting just inside 3 days',
      { postedAt: new Date('2026-11-03T12:00:00Z') },
      { timeframeDays: 3 },
      'target',
      'Matches your titles',
    ],
    [
      'an application already tracked',
      { alreadyTracked: true },
      {},
      'skipped',
      'Already in your tracker',
    ],
    [
      'a skipped title word',
      { title: 'Product Manager Intern' },
      {},
      'skipped',
      'Title has "intern", which you skip',
    ],
    [
      'an unwanted work mode',
      { workMode: 'On-site' },
      {},
      'skipped',
      "On-site, which you don't want",
    ],
    [
      'the keyword only in the text',
      { title: 'Engineering Manager', text: 'Partner with the product manager.' },
      {},
      'keyword_only',
      'Mentions your keywords, but the title is a different role',
    ],
    [
      'a different role altogether',
      { title: 'Account Executive' },
      {},
      'keyword_only',
      "The title doesn't match your titles",
    ],
    [
      'a Workday target',
      { source: 'workday' },
      {},
      'finish_yourself',
      'Workday needs an account at each company',
    ],
    [
      'the query words when no include list is set',
      { title: 'QA Engineer II' },
      { includeTitles: [], queryTerms: ['QA engineer'] },
      'target',
      'Matches your titles',
    ],
  ])('%s', (_label, overrides, ruleOverrides, kind, reason) => {
    expect(sortJob(job(overrides), { ...rules, ...ruleOverrides })).toEqual({ kind, reason });
  });
});

describe('isRunDue', () => {
  const schedule = { cadence: 'daily' as const, runHour: 8, runWeekday: 1 };
  // 2026-11-06 is a Friday. 13:30 UTC is 08:30 in New York.
  const friday0830 = new Date('2026-11-06T13:30:00Z');

  it('is due from the run hour, once per local day', () => {
    expect(isRunDue(schedule, 'America/New_York', friday0830, null)).toBe(true);
    expect(isRunDue(schedule, 'America/New_York', friday0830, '2026-11-06')).toBe(false);
    expect(isRunDue(schedule, 'America/New_York', friday0830, '2026-11-05')).toBe(true);
    expect(isRunDue(schedule, 'America/New_York', new Date('2026-11-06T12:30:00Z'), null)).toBe(
      false,
    );
    // A missed hour catches up later the same day.
    expect(isRunDue(schedule, 'America/New_York', new Date('2026-11-06T20:00:00Z'), null)).toBe(
      true,
    );
  });

  it('runs on weekdays only, or on one day a week', () => {
    const saturday = new Date('2026-11-07T13:30:00Z');
    expect(
      isRunDue({ ...schedule, cadence: 'weekdays' }, 'America/New_York', friday0830, null),
    ).toBe(true);
    expect(isRunDue({ ...schedule, cadence: 'weekdays' }, 'America/New_York', saturday, null)).toBe(
      false,
    );
    expect(
      isRunDue(
        { ...schedule, cadence: 'weekly', runWeekday: 5 },
        'America/New_York',
        friday0830,
        null,
      ),
    ).toBe(true);
    expect(
      isRunDue(
        { ...schedule, cadence: 'weekly', runWeekday: 1 },
        'America/New_York',
        friday0830,
        null,
      ),
    ).toBe(false);
  });

  it('reads the clock in the user’s time zone', () => {
    expect(localClock(friday0830, 'America/New_York')).toEqual({ weekday: 5, hour: 8 });
    expect(localClock(new Date('2026-11-06T23:30:00Z'), 'Asia/Tokyo')).toEqual({
      weekday: 6,
      hour: 8,
    });
  });
});

const PROFILE: JobSearchProfile = {
  fullName: 'Pat Q. Example',
  email: 'pat@example.com',
  phone: '+1 555 010 0199',
  city: 'Boston',
  state: 'MA',
  workAuthorization: 'US citizen',
  needsSponsorship: false,
  salaryMin: 150000,
  salaryMax: 180000,
  linkedin: 'https://www.linkedin.com/in/pat',
  portfolio: '',
  website: 'https://pat.example.com',
  workModes: ['Remote'],
  queries: [DEFAULT_QUERY],
  includeTitles: [],
  skipTitles: [],
  timeframeDays: 1,
  cadence: 'daily',
  runHour: 8,
  runWeekday: 1,
  scheduleOn: true,
  willingToRelocate: 'No',
  startDate: 'Two weeks after an offer',
  howHeard: 'Company careers page',
  over18: true,
  eeoAnswer: 'Decline to self-identify',
};

describe('JobSearchProfileSchema', () => {
  it('accepts a full profile', () => {
    expect(JobSearchProfileSchema.parse(PROFILE)).toEqual(PROFILE);
  });

  it.each([
    ['a maximum below the minimum', { salaryMax: 100 }, 'salaryMax'],
    ['a link that is not http(s)', { linkedin: 'javascript:alert(1)' }, 'linkedin'],
    ['no queries', { queries: [] }, 'queries'],
    ['four queries', { queries: ['a', 'b', 'c', 'd'] }, 'queries'],
    ['an odd timeframe', { timeframeDays: 2 }, 'timeframeDays'],
    ['a two-line name', { fullName: 'Pat\nExample' }, 'fullName'],
    ['no work mode', { workModes: [] }, 'workModes'],
  ])('refuses %s', (_label, overrides, path) => {
    const result = JobSearchProfileSchema.safeParse({ ...PROFILE, ...overrides });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([path]);
  });
});

describe('screening questions answered from the profile', () => {
  it.each([
    ['First Name', 'first_name', 'Pat'],
    ['Last Name', 'last_name', 'Q. Example'],
    ['Email', 'email', 'pat@example.com'],
    ['Phone', 'phone', '+1 555 010 0199'],
    ['LinkedIn Profile', 'linkedin', 'https://www.linkedin.com/in/pat'],
    ['Portfolio or GitHub', 'portfolio', 'https://pat.example.com'],
    [
      "What's the name you'd prefer us to use throughout the interview process?",
      'full_name',
      'Pat Q. Example',
    ],
    [
      'Will you now or in the future require sponsorship for a visa to remain in your current location?',
      'sponsorship',
      'No',
    ],
    [
      'Are you legally authorized to work in the United States?',
      'work_authorization',
      'US citizen',
    ],
    ['What are your salary expectations?', 'salary', '$150,000 to $180,000'],
    ['Are you willing to relocate?', 'relocation', 'No'],
    ['When can you start?', 'start_date', 'Two weeks after an offer'],
    ['How did you hear about this job?', 'how_heard', 'Company careers page'],
    ['Are you at least 18 years of age?', 'over_18', 'Yes'],
    ['VeteranStatus', 'eeo', 'Decline to self-identify'],
    ['Please identify your race or ethnicity', 'eeo', 'Decline to self-identify'],
    ['Do you have a disability?', 'eeo', 'Decline to self-identify'],
    ['Resume/CV', 'resume', null],
    ['Cover Letter', 'cover_letter', null],
  ])('"%s" is %s', (label, kind, answer) => {
    const found = profileQuestionKind(label);
    expect(found).toBe(kind);
    if (found) expect(profileAnswer(found, PROFILE)).toBe(answer);
  });

  it.each([
    'Have you previously worked at or consulted for GitLab?',
    'Are you subject to any employment agreements with your current employer?',
    'Why do you want to work here?',
    'Describe a test strategy you designed.',
  ])('leaves "%s" to the draft', (label) => {
    expect(profileQuestionKind(label)).toBeNull();
  });

  it('picks the matching option for a fixed-choice question', () => {
    expect(pickOption('No', ['Yes', 'No'])).toBe('No');
    expect(pickOption('Yes', ['Yes, I will', 'No, I will not'])).toBe('Yes, I will');
    expect(
      pickOption('Decline to self-identify', [
        'I am not a protected veteran',
        "I don't wish to answer",
      ]),
    ).toBe("I don't wish to answer");
    expect(pickOption('US citizen', ['Yes', 'No'])).toBeNull();
    expect(pickOption('anything', [])).toBe('anything');
  });
});

describe('assembleDraft', () => {
  const q = (
    label: string,
    kind: ApplicationQuestion['kind'] = 'text',
    options: string[] = [],
    required = true,
  ): ApplicationQuestion => ({ label, kind, options, required });
  const model: ModelDraft = {
    answers: [
      { question: 'Why do you want to work here?', answer: 'Because of X.', needsCandidate: false },
      { question: 'Have you worked here before?', answer: 'No', needsCandidate: false },
      { question: 'Gender', answer: 'Woman', needsCandidate: false },
      { question: 'Do you hold a security clearance?', answer: '', needsCandidate: true },
    ],
    coverLetter: 'Dear team, ...',
    whyInterested: 'The mission.',
  };

  it('answers profile questions by code and the rest from the draft', () => {
    const { draft, needsYou } = assembleDraft(
      [
        q('First Name'),
        q('Resume/CV', 'file'),
        q('Cover Letter', 'file', [], false),
        q('Will you require visa sponsorship?', 'single_select', ['Yes', 'No']),
        q('Why do you want to work here?', 'long_text'),
        q('Have you worked here before?', 'single_select', ['Yes', 'No']),
        q('Gender', 'single_select', ['Man', 'Woman', 'Decline to self-identify'], false),
      ],
      PROFILE,
      model,
    );
    expect(needsYou).toBe(false);
    expect(draft.answers).toEqual([
      { question: 'First Name', answer: 'Pat', source: 'profile', option: null },
      {
        question: 'Resume/CV',
        answer: 'Attach the resume file from the queue',
        source: 'profile',
        option: null,
      },
      { question: 'Cover Letter', answer: 'Dear team, ...', source: 'draft', option: null },
      {
        question: 'Will you require visa sponsorship?',
        answer: 'No',
        source: 'profile',
        option: 'No',
      },
      {
        question: 'Why do you want to work here?',
        answer: 'Because of X.',
        source: 'draft',
        option: null,
      },
      { question: 'Have you worked here before?', answer: 'No', source: 'draft', option: 'No' },
      // EEO: always the saved answer, never the model's.
      {
        question: 'Gender',
        answer: 'Decline to self-identify',
        source: 'profile',
        option: 'Decline to self-identify',
      },
    ]);
  });

  it('marks a required question it cannot answer as needs you', () => {
    const result = assembleDraft(
      [q('Do you hold a security clearance?'), q('Unasked question')],
      PROFILE,
      model,
    );
    expect(result.needsYou).toBe(true);
    expect(result.draft.answers.map((answer) => answer.source)).toEqual(['needs_you', 'needs_you']);
  });

  it('needs you when a profile answer matches none of the options', () => {
    const result = assembleDraft(
      [q('Are you authorized to work in the US?', 'single_select', ['Yes', 'No'])],
      PROFILE,
      model,
    );
    expect(result.needsYou).toBe(true);
    expect(result.draft.answers[0]).toMatchObject({ answer: 'US citizen', source: 'needs_you' });
  });

  it('leaves an optional question it cannot answer empty without holding the job back', () => {
    expect(
      assembleDraft(
        [q('Pronouns?', 'text', [], false), q('Anything else?', 'long_text', [], false)],
        PROFILE,
        model,
      ).needsYou,
    ).toBe(false);
  });

  it('sends the model only the questions code cannot answer', () => {
    expect(
      questionsForModel([q('Email'), q('Why us?'), q('VeteranStatus', 'single_select')]).map(
        (question) => question.label,
      ),
    ).toEqual(['Why us?']);
  });
});
