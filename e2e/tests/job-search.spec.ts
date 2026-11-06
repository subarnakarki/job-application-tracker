import type { JobSearchProfile } from '@jat/shared';
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
  await page.getByLabel('City').fill('Boston');
  await page.getByLabel('State').fill('MA');
  await page.getByLabel('Work authorization').fill('US citizen');
  await page.getByLabel('Salary (minimum)').fill('150000');
  await page.getByLabel('Full name').fill('Pat Example');
  await page.getByLabel('Email').fill('pat@example.com');
  await page.getByLabel('How often').selectOption('weekly');
  await page.getByLabel('On', { exact: true }).selectOption('Friday');
  await page.getByRole('button', { name: 'Review' }).click();

  const confirm = page.getByRole('region', { name: 'Check everything before it is saved' });
  await expect(confirm).toContainText('Every Friday at 8:00 AM');
  await expect(confirm).toContainText('site:job-boards.greenhouse.io "product manager"');
  await page.getByRole('button', { name: 'Confirm and save' }).click();

  await expect(page).toHaveURL('/job-search');
  await expect(page.getByText('Every Friday at 8:00 AM.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy Claude in Chrome prompt' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Job search' }),
  ).toBeVisible();
});
