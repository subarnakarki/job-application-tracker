import { EMPTY_MORE_ANSWERS, SEARCH_SOURCES, type JobSearchProfile } from '@jat/shared';
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
  salaryFloor: null,
  linkedin: 'https://www.linkedin.com/in/pat',
  portfolio: '',
  website: '',
  workModes: ['Remote', 'Hybrid'],
  commuteArea: [],
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
  more: EMPTY_MORE_ANSWERS,
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
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Job search' }),
  ).toHaveAttribute('href', '/job-search');
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
  await expect(
    page.getByRole('navigation', { name: 'Job search' }).getByRole('link', { name: 'Apply queue' }),
  ).toHaveAttribute('aria-current', 'page');
  const ready = queue.section(/^Ready to apply/);
  const initech = queue.job('Initech: Senior Product Manager');
  await expect(ready).toContainText('Ready to apply (1)');
  await queue.showAnswers(initech);
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
  await queue.openTab('Needs you');
  await expect(queue.section(/^Needs you/)).toContainText('Needs you (1)');
  await hooli.getByLabel('Do you hold an active security clearance? (required)').selectOption('No');
  await hooli.getByRole('button', { name: 'Save answers' }).click();
  await expect(queue.section(/^Needs you/)).toContainText('Needs you (0)');
  await queue.openTab('Ready to apply');
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
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Job search' }),
  ).toHaveAttribute('href', '/job-search');
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
  await page.getByLabel("Lowest pay I'll accept").fill('$140,000');
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
  await expect(confirm).toContainText('Lowest pay accepted$140,000');
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

test('adds titles from the Resume match to the job titles', async ({ page, api }) => {
  await api.uploadResumeText('Pat Example. Senior SDET. '.repeat(10));
  const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const title = (rank: number, name: string, fit: 'strong' | 'good' | 'stretch') => ({
    rank,
    title: name,
    fit,
    seniority: 'Senior',
    reason: 'r',
    keywords: [],
  });
  // The analysis itself is covered by API tests; here the browser sees a saved one.
  await page.route('**/api/resume/analyses', (route) =>
    route.fulfill({
      json: {
        items: [{ id, fileName: 'cv.pdf', createdAt: new Date().toISOString(), topTitles: [] }],
      },
    }),
  );
  await page.route(`**/api/resume/analyses/${id}`, (route) =>
    route.fulfill({
      json: {
        id,
        fileName: 'cv.pdf',
        model: 'claude-haiku-5-5',
        createdAt: new Date().toISOString(),
        summary: 's',
        gaps: [],
        warnings: [],
        titles: [
          title(1, 'Senior Software Development Engineer in Test (SDET)', 'strong'),
          title(2, 'Senior QA Automation Engineer', 'strong'),
          title(3, 'Developer Productivity Engineer', 'good'),
          title(4, 'DevOps Engineer', 'stretch'),
        ],
      },
    }),
  );
  await page.goto('/job-search/setup');
  const titles = page.getByLabel('Job titles to search for');
  await titles.fill('SDET');

  await page.getByText(/^From your Resume match/).click();
  const list = page.getByRole('list', { name: 'Titles from your Resume match' });
  await expect(list).toContainText('Software Development Engineer in Test · already covered');
  await expect(
    list.getByRole('checkbox', { name: 'QA Automation Engineer · Strong fit' }),
  ).toBeChecked();
  await expect(list.getByRole('checkbox', { name: 'DevOps Engineer · Stretch' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Add 2 titles' }).click();

  await expect(titles).toHaveValue('SDET\nQA Automation Engineer\nDeveloper Productivity Engineer');
  await expect(page.getByRole('list', { name: 'Searches that will run' })).toContainText(
    '"Developer Productivity Engineer"',
  );
});

test('a job found closed on its form is marked closed and leaves the queue', async ({
  page,
  api,
}) => {
  await api.uploadResumeText(
    'Pat Example. Senior product manager with eight years of launches. '.repeat(4),
  );
  await api.seedJobSearch({
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
    ],
    answers: { 'Why do you want to work here?': 'Your roadmap work matches my launches.' },
  });
  const queue = new ApplyQueuePage(page);
  await queue.goto();
  await expect(page.getByRole('button', { name: "Check they're still open" })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Not checked yet' })).toBeVisible();

  await queue
    .job('Initech: Senior Product Manager')
    .getByRole('button', { name: 'Mark closed: Initech, Senior Product Manager' })
    .click();
  await expect(queue.section(/^Ready to apply/)).toContainText('Ready to apply (0)');
  await expect(page.getByRole('status').filter({ hasText: 'closed this week' })).toContainText(
    '1 closed this week',
  );
});

test('the ready jobs are listed newest first, or by fit with the resume, with the missing keywords', async ({
  page,
  api,
}) => {
  await api.uploadResumeText(
    'Pat Example. Senior product manager: roadmaps, SQL and A/B testing. '.repeat(4),
  );
  const job = (company: string, hoursAgo: number, keywords: string[]) => ({
    board: company.toLowerCase(),
    company,
    title: 'Senior Product Manager',
    location: 'Remote, US',
    hoursAgo,
    content: 'Own the roadmap. '.repeat(20),
    questions: QUESTIONS.filter((question) => !/clearance/.test(question.label)),
    keywords,
  });
  await api.seedJobSearch({
    profile: PROFILE,
    jobs: [
      job('Initech', 1, ['roadmaps', 'Figma', 'Jira', 'Kubernetes', 'SQL']),
      job('Hooli', 5, ['roadmaps', 'SQL', 'A/B testing', 'product manager', 'Figma']),
    ],
    answers: { 'Why do you want to work here?': 'Your roadmap work matches my launches.' },
  });
  const queue = new ApplyQueuePage(page);
  await queue.goto();
  const cards = queue.section(/^Ready to apply/).getByRole('article');
  // Newest first: Initech was posted an hour ago, Hooli five.
  await expect(cards.getByRole('heading', { level: 3 })).toHaveText([
    'Initech: Senior Product Manager',
    'Hooli: Senior Product Manager',
  ]);
  await expect(queue.job('Initech: Senior Product Manager')).toContainText(
    /Posted \d+ (minute|hour)s? ago/,
  );
  const order = page.getByRole('group', { name: 'Order' });
  await expect(order.getByRole('button', { name: 'Newest first' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await order.getByRole('button', { name: 'Best fit first' }).click();
  await expect(cards.getByRole('heading', { level: 3 })).toHaveText([
    'Hooli: Senior Product Manager',
    'Initech: Senior Product Manager',
  ]);
  const initech = queue.job('Initech: Senior Product Manager');
  await expect(initech.getByText('Resume fit: Fit 40%')).toBeVisible();
  await expect(initech).toContainText('Missing from your resume: Figma, Jira, Kubernetes');
  await expect(
    queue.job('Hooli: Senior Product Manager').getByText('Resume fit: Fit 80%'),
  ).toBeVisible();
});

test('tailor my resume: checked suggestions, the fit after, and the tailored text', async ({
  page,
  api,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const rest =
    '\nRan SQL reports for the growth team.\nWrote product specs and release notes.'.repeat(3);
  await api.uploadResumeText(
    `Senior product manager with eight years of roadmaps and launches.${rest}`,
  );
  await api.seedJobSearch({
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
        keywords: ['roadmaps', 'SQL', 'launches', 'stakeholder management', 'Figma'],
      },
    ],
    answers: { 'Why do you want to work here?': 'Your roadmap work matches my launches.' },
  });
  const queue = new ApplyQueuePage(page);
  await queue.goto();
  const job = queue.job('Initech: Senior Product Manager');
  await expect(job.getByText('Resume fit: Fit 60%')).toBeVisible();

  await job
    .getByRole('button', { name: 'Tailor my resume: Initech, Senior Product Manager' })
    .click();
  const panel = job.getByRole('region', {
    name: 'Tailored resume: Initech, Senior Product Manager',
  });
  await expect(panel.getByText('Tailored resume: 1 suggestion')).toBeVisible();
  await expect(panel).toContainText(
    'Senior product manager with eight years of roadmaps and launches, including stakeholder management across 12 teams.',
  );
  await expect(panel.getByRole('note')).toHaveText('Check this: not in your resume: 12');
  await expect(panel).toContainText('Figma: No Figma experience in the resume.');

  // A suggestion with something to check starts unticked; ticking it shows the fit after.
  const use = panel.getByRole('checkbox', { name: /Use suggestion 1/ });
  await expect(use).not.toBeChecked();
  await expect(panel.getByRole('status')).toHaveText('Fit 60% → 60% with the ticked edits');
  await use.check();
  await expect(panel.getByRole('status')).toHaveText('Fit 60% → 80% with the ticked edits');

  await panel.getByRole('button', { name: 'Copy tailored resume' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(
      `Senior product manager with eight years of roadmaps and launches, including stakeholder management across 12 teams.${rest}`,
    );
});

test('more answers: set a few optional answers once, review only those, keep them', async ({
  page,
  api,
}) => {
  await api.seedJobSearch({ profile: PROFILE, jobs: [], answers: {} });
  await page.goto('/job-search/setup');

  const section = page.getByRole('region', { name: 'More answers (optional)' });
  // Folded away while nothing is set.
  await expect(section.getByRole('combobox', { name: 'U.S. citizen?' })).toBeHidden();
  await section.getByText('More answers (optional)').click();
  const citizen = section.getByRole('combobox', { name: 'U.S. citizen?' });
  await expect(citizen).toHaveValue('');
  await citizen.selectOption('Yes');
  await section
    .getByRole('combobox', { name: 'Security clearance', exact: true })
    .selectOption('I am eligible for one');
  await section.getByLabel('Pronouns').fill('He/Him');
  await page.getByRole('button', { name: 'Review' }).click();

  const confirm = page.getByRole('region', { name: 'Check everything before it is saved' });
  await expect(confirm).toContainText('U.S. citizen?Yes');
  await expect(confirm).toContainText('Security clearanceI am eligible for one');
  await expect(confirm).toContainText('PronounsHe/Him');
  // Answers left at Not set are not listed.
  await expect(confirm).not.toContainText('Country of birth');
  await expect(confirm).not.toContainText('W2 hourly rate');
  await page.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(page).toHaveURL('/job-search');

  // Saved: the section opens with the answers in place.
  await page.goto('/job-search/setup');
  await expect(section.getByRole('combobox', { name: 'U.S. citizen?' })).toHaveValue('yes');
  await expect(
    section.getByRole('combobox', { name: 'Security clearance', exact: true }),
  ).toHaveValue('eligible');
  await expect(section.getByLabel('Pronouns')).toHaveValue('He/Him');
  await expect(section.getByRole('combobox', { name: 'Open to a W2 contract?' })).toHaveValue('');
});

test('track it: a queue job is saved in the tracker before applying', async ({ page, api }) => {
  await api.uploadResumeText('Pat Example. Senior product manager. '.repeat(10));
  await api.seedJobSearch({
    profile: PROFILE,
    jobs: [
      {
        board: 'hooli',
        company: 'Hooli',
        title: 'Senior Product Manager',
        location: 'Remote, US',
        hoursAgo: 3,
        content: 'Own the roadmap. '.repeat(20),
        questions: QUESTIONS.filter((question) => !/clearance/.test(question.label)),
      },
    ],
    answers: { 'Why do you want to work here?': 'Your roadmap work matches my launches.' },
  });
  const queue = new ApplyQueuePage(page);
  await queue.goto();
  const job = queue.job('Hooli: Senior Product Manager');

  await job
    .getByRole('button', { name: 'Track it in your applications: Hooli, Senior Product Manager' })
    .click();

  // Still in the queue, now linked to its Saved application.
  const saved = job.getByRole('link', { name: /Saved/ });
  await expect(saved).toBeVisible();
  await expect(job.getByRole('button', { name: /^Track it in your applications/ })).toHaveCount(0);
  await saved.click();
  await expect(page.getByRole('heading', { name: 'Hooli', level: 1 })).toBeVisible();
  await expect(page.getByText('Saved from the job search (Greenhouse).')).toBeVisible();
});

test("save a queue job's tailored resume: it is tracked as Saved and kept on the application", async ({
  page,
  api,
}) => {
  await api.uploadResumeText(
    'Pat Example. Senior product manager: roadmaps and launches for growth teams. '.repeat(4),
  );
  await api.seedJobSearch({
    profile: PROFILE,
    jobs: [
      {
        board: 'hooli',
        company: 'Hooli',
        title: 'Senior Product Manager',
        location: 'Remote, US',
        hoursAgo: 3,
        content: 'Own the roadmap. '.repeat(20),
        questions: QUESTIONS.filter((question) => !/clearance/.test(question.label)),
        keywords: ['roadmaps', 'launches', 'SQL', 'Figma', 'Jira'],
      },
    ],
    answers: { 'Why do you want to work here?': 'Your roadmap work matches my launches.' },
  });
  const queue = new ApplyQueuePage(page);
  await queue.goto();
  const job = queue.job('Hooli: Senior Product Manager');
  await job.getByRole('button', { name: /^Tailor my resume/ }).click();
  await job.getByRole('checkbox', { name: /Use suggestion 1/ }).check();
  await job.getByRole('button', { name: "Edit and save as this job's resume" }).click();

  await expect(
    job.getByText('Saving also adds this job to your applications as Saved.'),
  ).toBeVisible();
  const editor = job.getByLabel("This job's resume");
  await editor.fill(`${await editor.inputValue()}\n- Planned launches in Jira.`);
  await job.getByRole('button', { name: "Save as this job's resume" }).click();

  const saved = job.getByRole('link', { name: /Saved/ });
  await expect(saved).toBeVisible();
  await saved.click();
  const section = page.getByRole('region', { name: 'Tailored resume' });
  await expect(section.getByText(/^Saved for this job on/)).toBeVisible();
  await section.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(section.getByLabel("This job's resume")).toHaveValue(
    /- Planned launches in Jira\.$/,
  );
});

test('a job that could not be drafted waits in Needs you, with Redraft', async ({ page, api }) => {
  await api.uploadResumeText('Pat Example. Senior product manager. '.repeat(10));
  await api.seedJobSearch({
    profile: PROFILE,
    jobs: [
      {
        board: 'hooli',
        company: 'Hooli',
        title: 'Senior Product Manager',
        location: 'Remote, US',
        hoursAgo: 3,
        content: 'Own the roadmap. '.repeat(20),
        questions: [],
        undraftable: true,
      },
    ],
    answers: {},
  });
  const queue = new ApplyQueuePage(page);
  await queue.goto();
  await queue.openTab('Needs you');
  const job = queue.job('Hooli: Senior Product Manager');

  await expect(job).toContainText(
    "Couldn't draft this job after 3 tries: answer it yourself, or press Redraft.",
  );
  await expect(
    job.getByRole('button', {
      name: 'Redraft with my current setup: Hooli, Senior Product Manager',
    }),
  ).toBeVisible();
});

test('commute area: filled with the Charlotte core area, confirmed, saved and kept', async ({
  page,
  api,
}) => {
  await api.uploadResumeText('Pat Example. Senior product manager. '.repeat(10));
  await api.seedJobSearch({ profile: PROFILE, jobs: [], answers: {} });
  await page.goto('/job-search/setup');
  const area = page.getByLabel('Commute area for hybrid and on-site jobs');
  await expect(area).toHaveValue('');

  await page.getByRole('button', { name: 'Use the Charlotte core area' }).click();
  await expect(area).toHaveValue(/^Charlotte\nConcord\nKannapolis/);
  // The search near home joins the searches that will run (it is made from the titles).
  await page.getByLabel('Job titles to search for').fill('SDET');
  await expect(
    page.getByRole('list', { name: 'Searches that will run' }).getByRole('listitem').last(),
  ).toContainText('"Charlotte, ');
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(
    page.getByRole('region', { name: 'Check everything before it is saved' }),
  ).toContainText('Commute area (hybrid and on-site)Charlotte, Concord, Kannapolis');
  await page.getByRole('button', { name: 'Confirm and save' }).click();
  await expect(page).toHaveURL('/job-search');

  await page.goto('/job-search/setup');
  await expect(page.getByLabel('Commute area for hybrid and on-site jobs')).toHaveValue(
    /^Charlotte\nConcord/,
  );
  // Only remote work: no commute, so the field goes.
  await page.getByRole('checkbox', { name: 'Hybrid' }).uncheck();
  await expect(page.getByLabel('Commute area for hybrid and on-site jobs')).toHaveCount(0);
});

test('companies watched: a found company is listed, a bad link is refused, and one can be removed', async ({
  page,
  api,
}) => {
  await api.uploadResumeText('Pat Example. Senior product manager. '.repeat(10));
  await api.seedJobSearch({
    profile: PROFILE,
    jobs: [
      {
        board: 'hooli',
        company: 'Hooli',
        title: 'Senior Product Manager',
        location: 'Remote, US',
        hoursAgo: 3,
        content: 'Own the roadmap. '.repeat(20),
        questions: [],
      },
    ],
    answers: {},
  });
  await page.goto('/job-search');
  const section = page.getByRole('region', { name: /^Companies watched/ });
  await expect(section.getByRole('heading', { level: 2 })).toHaveText('Companies watched (1)');
  await section.getByText('Show the companies').click();
  const company = section.getByRole('list', { name: 'Companies watched' }).getByRole('listitem');
  await expect(company).toContainText('Hooli');
  await expect(company).toContainText('Greenhouse');

  // A link that is not a careers board is refused, with the reason.
  await section.getByLabel('Add a company').fill('https://example.com/careers');
  await section.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Greenhouse, Lever, Ashby or Workday');

  await section.getByRole('button', { name: 'Stop watching Hooli' }).click();
  await expect(section.getByRole('heading', { level: 2 })).toHaveText('Companies watched (0)');
  await expect(section).toContainText('None yet');
});
