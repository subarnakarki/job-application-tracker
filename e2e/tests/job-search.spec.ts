import { SEARCH_SOURCES, type JobSearchProfile } from '@jat/shared';
import { expect, test } from '../fixtures';
import { ApplyQueuePage } from '../pages/ApplyQueuePage';

const PROFILE: JobSearchProfile = {
  fullName: 'Pat Example',
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
  website: '',
  workModes: ['Remote', 'Hybrid'],
  usOnly: true,
  sites: [...SEARCH_SOURCES],
  queries: ['site:job-boards.greenhouse.io "product manager"'],
  includeTitles: [],
  skipTitles: ['intern'],
  timeframeDays: 1,
  cadence: 'weekdays',
  runHour: 8,
  runWeekday: 1,
  scheduleOn: true,
  willingToRelocate: 'No',
  startDate: 'Two weeks after an offer',
  howHeard: 'Company careers page',
  over18: true,
  gender: 'Decline to self-identify',
  hispanicLatino: 'decline',
  raceEthnicity: 'Decline to self-identify',
  veteranStatus: 'decline',
  disabilityStatus: 'decline',
  eeoAnswer: 'Decline to self-identify',
};

const QUESTIONS = [
  { label: 'First Name', required: true, options: [] },
  { label: 'Email', required: true, options: [] },
  { label: 'Will you require visa sponsorship?', required: true, options: ['Yes', 'No'] },
  { label: 'Why do you want to work here?', required: false, options: [] },
  { label: 'Do you hold an active security clearance?', required: true, options: ['Yes', 'No'] },
  { label: 'Gender', required: false, options: ['Man', 'Woman', 'Decline to self-identify'] },
];

test('a search run lists jobs in groups; the queue holds every answer; apply and finish one', async ({
  page,
  api,
}) => {
  await api.uploadResumeText(
    'Pat Example. Senior product manager with eight years of roadmaps and launches. '.repeat(4),
  );
  const runId = await api.seedJobSearch({
    profile: PROFILE,
    jobs: [
      {
        board: 'initech',
        company: 'Initech',
        title: 'Senior Product Manager',
        location: 'Remote, US',
        hoursAgo: 3,
        content: 'Own the roadmap. '.repeat(20),
        questions: QUESTIONS.filter((question) => !/clearance/.test(question.label)),
      },
      {
        board: 'hooli',
        company: 'Hooli',
        title: 'Product Manager, Platform',
        location: 'Remote, US',
        hoursAgo: 5,
        content: 'Ship platform features. '.repeat(20),
        questions: QUESTIONS,
      },
      {
        board: 'globex',
        company: 'Globex',
        title: 'Engineering Manager',
        location: 'Remote, US',
        hoursAgo: 2,
        content: 'Partner closely with the product manager. '.repeat(10),
        questions: [],
      },
      {
        board: 'umbrella',
        company: 'Umbrella',
        title: 'Product Manager Intern',
        location: 'Remote, US',
        hoursAgo: 1,
        content: 'Summer internship. '.repeat(20),
        questions: [],
      },
    ],
    answers: { 'Why do you want to work here?': 'Your roadmap work matches my launches.' },
  });

  // The run's list, before applying: grouped, with company, role, time posted and link.
  await page.goto(`/job-search/runs/${runId}`);
  await expect(page.getByRole('heading', { name: 'Search results', level: 1 })).toBeVisible();
  const targets = page.getByRole('region', { name: 'Target roles' });
  await expect(targets.getByRole('listitem')).toHaveCount(2);
  await expect(targets).toContainText('Initech · Senior Product Manager');
  await expect(targets.getByRole('link', { name: /initech\/jobs/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Keyword only' })).toContainText(
    'Globex · Engineering Manager',
  );
  await expect(page.getByRole('region', { name: 'Skipped' })).toContainText(
    'Title has "intern", which you skip',
  );

  // The queue, read the way Claude in Chrome reads it.
  const queue = new ApplyQueuePage(page);
  await queue.goto();
  const ready = queue.section(/^Ready to apply/);
  const initech = queue.job('Initech: Senior Product Manager');
  await expect(ready).toContainText('Ready to apply (1)');
  await expect(queue.answer(initech, 'Email')).toHaveText('pat@example.com');
  await expect(queue.answer(initech, 'Will you require visa sponsorship?')).toHaveText('No');
  await expect(queue.answer(initech, 'Why do you want to work here?')).toHaveText(
    'Your roadmap work matches my launches.',
  );
  await expect(queue.answer(initech, 'Gender')).toHaveText('Decline to self-identify');
  await expect(page.getByRole('link', { name: 'Download resume' })).toHaveAttribute(
    'href',
    '/api/resume/file',
  );

  // Hooli asks something only the candidate knows: answer it, and it becomes ready.
  const hooli = queue.job('Hooli: Product Manager, Platform');
  await expect(queue.section(/^Needs you/)).toContainText('Needs you (1)');
  await hooli.getByLabel('Do you hold an active security clearance? (required)').selectOption('No');
  await hooli.getByRole('button', { name: 'Save answers' }).click();
  await expect(ready).toContainText('Ready to apply (2)');

  // Claude in Chrome presses Mark applied after submitting: the application is tracked.
  await initech
    .getByRole('button', { name: 'Mark applied: Initech, Senior Product Manager' })
    .click();
  await expect(ready).toContainText('Ready to apply (1)');

  await hooli.getByRole('button', { name: /^Mark blocked/ }).click();
  await hooli.getByLabel('Why it is blocked').fill('Asked to create an account');
  await hooli.getByRole('button', { name: 'Save' }).click();
  await expect(ready).toContainText('Ready to apply (0)');

  await page.goto('/');
  await expect(page.getByRole('link', { name: /Initech/ }).first()).toBeVisible();

  // The run's list now labels the job applied to, linking to its application.
  await page.goto(`/job-search/runs/${runId}`);
  await expect(
    page
      .getByRole('region', { name: 'Target roles' })
      .getByRole('link', { name: 'Already applied · Applied' }),
  ).toBeVisible();

  // The run's summary counts what happened.
  await page.goto('/job-search');
  await expect(page.getByRole('list', { name: 'Runs' })).toContainText(
    '4 found · 2 target · 1 applied · 0 waiting · 1 blocked · 1 skipped',
  );
});

test('first run: the setup asks once, confirms everything, then opens the overview', async ({
  page,
  api,
}) => {
  await api.uploadResumeText('Pat Example. Senior product manager. '.repeat(10));
  await page.goto('/job-search');
  await page.getByRole('link', { name: 'Set up the job search' }).click();

  await page.getByLabel('Phone').fill('+1 555 010 0199');
  await page.getByLabel('City', { exact: true }).fill('Boston');
  await page.getByLabel('State', { exact: true }).fill('MA');
  await page.getByLabel('Work authorization').fill('US citizen');
  await page.getByLabel('Salary (minimum)').fill('150000');
  await page.getByLabel('Full name').fill('Pat Example');
  await page.getByLabel('Email').fill('pat@example.com');
  await page.getByLabel('How often').selectOption('weekly');
  await page.getByLabel('On', { exact: true }).selectOption('Friday');
  await page.getByLabel('Gender', { exact: true }).fill('Female');
  await page.getByLabel('Veteran status').selectOption('I am not a protected veteran');

  // Titles and ticked sites make the searches, shown as they change.
  await page.getByLabel('Job titles to search for').fill('SDET\nQA automation engineer');
  const preview = page.getByRole('list', { name: 'Searches that will run' });
  await expect(preview.getByRole('listitem')).toHaveText(['"SDET"', '"QA automation engineer"']);
  await page.getByRole('button', { name: 'Select none' }).click();
  await page.getByRole('checkbox', { name: 'Greenhouse' }).check();
  await page.getByRole('checkbox', { name: 'Ashby' }).check();
  await expect(preview.getByRole('listitem').first()).toHaveText(
    'site:job-boards.greenhouse.io OR site:boards.greenhouse.io OR site:jobs.ashbyhq.com "SDET"',
  );
  await page.getByRole('button', { name: 'Review' }).click();

  const confirm = page.getByRole('region', { name: 'Check everything before it is saved' });
  await expect(confirm).toContainText('Every Friday at 8:00 AM');
  await expect(confirm).toContainText('Gender');
  await expect(confirm).toContainText('Female');
  await expect(confirm).toContainText('I am not a protected veteran');
  await expect(confirm).toContainText('Disability');
  await expect(confirm).toContainText('United States onlyYes');
  await expect(confirm).toContainText('Job sitesGreenhouse, Ashby');
  await expect(confirm).toContainText('site:jobs.ashbyhq.com "QA automation engineer"');
  await page.getByRole('button', { name: 'Confirm and save' }).click();

  await expect(page).toHaveURL('/job-search');
  await expect(page.getByText('Every Friday at 8:00 AM.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy Claude in Chrome prompt' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Job search' }),
  ).toBeVisible();
});

test('a running search shows its progress, step by step', async ({ page, api }) => {
  await api.seedJobSearch({ profile: PROFILE, jobs: [], answers: {} });
  // The run itself is covered by API tests; here the browser sees one half way through.
  await page.route('**/api/job-search/runs', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            items: [
              {
                id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
                trigger: 'schedule',
                status: 'running',
                searches: 6,
                error: null,
                startedAt: new Date().toISOString(),
                finishedAt: null,
                counts: {
                  found: 3,
                  target: 1,
                  keywordOnly: 0,
                  finishYourself: 0,
                  skipped: 2,
                  ready: 0,
                  needsYou: 0,
                  applied: 0,
                  blocked: 0,
                  notDrafted: 1,
                },
                progress: {
                  step: 'reading',
                  queriesDone: 3,
                  queriesTotal: 3,
                  boardsDone: 12,
                  boardsTotal: 12,
                  jobsRead: 5,
                  jobsTotal: 20,
                  drafted: 0,
                  draftsTotal: 0,
                },
              },
            ],
          },
        })
      : route.fallback(),
  );
  await page.goto('/job-search');

  const panel = page.getByRole('region', { name: 'Scheduled search running' });
  await expect(panel.getByRole('progressbar', { name: 'Job search progress' })).toHaveAttribute(
    'aria-valuenow',
    '56',
  );
  const steps = panel.getByRole('list', { name: 'Steps' }).getByRole('listitem');
  await expect(steps).toHaveText([
    /Searching the job boards\s*\(done\)\s*· 3 of 3 queries/,
    /Checking companies' own job lists\s*\(done\)\s*· 12 of 12 companies/,
    /Reading new jobs\s*\(in progress\)\s*· 5 of 20 jobs/,
    /Drafting answers\s*\(waiting\)/,
  ]);
  await expect(panel.getByRole('status')).toContainText('Reading new jobs…');
});
