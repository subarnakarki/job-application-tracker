import type { ApplicationDetail } from '@jat/shared';
import { expect, test } from '../fixtures';

// Reading postings and the job-board lookup are covered by unit and API tests; here the browser's
// answers are mocked, so these tests check the page and never depend on a real job site.

const PREVIEW = {
  jobLink: 'https://jobs.example.com/sdet-42',
  company: 'Someone Else',
  role: 'Senior SDET',
  salaryMin: 140000,
  salaryMax: 170000,
  salaryCurrency: 'USD',
  location: 'Boston, MA',
  workMode: 'Hybrid',
  postedOn: '2026-10-01',
};

test('fill from posting fills the empty fields of a saved application', async ({
  page,
  api,
  detailPage,
}) => {
  const application = await api.createApplication({
    company: 'Initech',
    role: 'Role not stated',
    jobLink: 'https://jobs.example.com/sdet-42',
    location: 'Remote (US)', // typed by hand: must survive
  });
  await page.route('**/api/postings/preview', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREVIEW) }),
  );
  await detailPage.goto(application.id);
  await page.getByRole('button', { name: 'Fill from posting' }).click();

  await expect(page.getByText(/Filled 5 fields from the posting/)).toBeVisible();
  await expect(page.getByText('Senior SDET', { exact: true })).toBeVisible();
  const saved = await api.getApplication(application.id);
  expect(saved).toMatchObject({
    company: 'Initech',
    role: 'Senior SDET',
    location: 'Remote (US)',
    workMode: 'Hybrid',
    salaryMin: 140000,
    postedOn: '2026-10-01',
  });

  // Nothing left to fill: says so and saves nothing.
  await page.getByRole('button', { name: 'Fill from posting' }).click();
  await expect(page.getByText(/Nothing new to fill/)).toBeVisible();
  expect((await api.getApplication(application.id)).version).toBe(saved.version);
});

test('the edit page offers fill from link with the job link already in', async ({ page, api }) => {
  const application = await api.createApplication({
    company: 'Initech',
    role: 'SDET',
    jobLink: 'https://jobs.example.com/sdet-42',
  });
  await page.goto(`/applications/${application.id}/edit`);
  await expect(page.getByLabel('Job posting link')).toHaveValue('https://jobs.example.com/sdet-42');
});

test('a posting found on a job board is shown, and can be dismissed', async ({
  page,
  api,
  detailPage,
}) => {
  const application = await api.createApplication({ company: 'Initech', role: 'SDET' });
  const suggestion = {
    source: 'greenhouse',
    jobLink: 'https://job-boards.greenhouse.io/initech/jobs/42',
    role: 'SDET',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    location: 'Boston, MA',
    workMode: 'Hybrid',
    postedOn: null,
    createdAt: new Date().toISOString(),
  };
  // As an import would leave it (imports with a board lookup are covered by API tests).
  let dismissed = false;
  await page.route(`**/api/applications/${application.id}`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ApplicationDetail;
    await route.fulfill({
      response,
      json: { ...body, postingSuggestion: dismissed ? null : suggestion },
    });
  });
  await page.route(`**/api/applications/${application.id}/suggestion`, (route) => {
    dismissed = true;
    return route.fulfill({ status: 204 });
  });

  await detailPage.goto(application.id);
  const card = page.getByRole('region', { name: 'Possible posting found on Greenhouse' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: 'SDET' })).toHaveAttribute(
    'href',
    suggestion.jobLink,
  );
  await expect(card.getByText('Boston, MA · Hybrid')).toBeVisible();
  await card.getByRole('button', { name: 'Not this job' }).click();
  await expect(card).toBeHidden();
});
