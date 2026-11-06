import { expect, test } from '../fixtures';

// The server-side reading is covered by API and unit tests; here the browser's answer is mocked,
// so the test checks the form and never depends on a real job site.
test('fill from link fills only empty fields, then saves', async ({
  page,
  formPage,
  detailPage,
}) => {
  await page.route('**/api/postings/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobLink: 'https://jobs.example.com/sdet-42',
        company: 'Initech',
        role: 'Senior SDET',
        salaryMin: 140000,
        salaryMax: 170000,
        salaryCurrency: 'USD',
      }),
    }),
  );
  await page.goto('/applications/new');
  await formPage.company.fill('Initech Labs'); // typed by hand: must survive

  await page.getByLabel('Job posting link').fill('https://jobs.example.com/sdet-42');
  await page.getByRole('button', { name: 'Fill from link' }).click();

  await expect(page.getByText(/Filled 4 fields from the posting/)).toBeVisible();
  await expect(formPage.company).toHaveValue('Initech Labs');
  await expect(formPage.role).toHaveValue('Senior SDET');
  await expect(page.getByLabel('Salary from')).toHaveValue('140000');
  await formPage.save.click();
  await expect(detailPage.heading('Initech Labs')).toBeVisible();
});

test('a link that cannot be read is explained and changes nothing', async ({ page, formPage }) => {
  await page.route('**/api/postings/preview', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'unsupported_site',
        message:
          "This site needs a sign-in to show its postings, so it can't be read here. Fill in the details by hand.",
      }),
    }),
  );
  await page.goto('/applications/new');
  await page.getByLabel('Job posting link').fill('https://www.linkedin.com/jobs/view/1');
  await page.getByRole('button', { name: 'Fill from link' }).click();
  await expect(page.getByText(/needs a sign-in/)).toBeVisible();
  await expect(formPage.role).toHaveValue('');
});
