import { expect, test } from '../fixtures';

test('add a lead with a note, link it to an application, and see it both ways', async ({
  page,
  formPage,
  detailPage,
}) => {
  await page.goto('/leads');
  await page.getByRole('link', { name: 'Add lead' }).click();
  await page.getByLabel('Name *').fill('Sam Rivera');
  await page.getByLabel('Company', { exact: true }).fill('Globex');
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: 'Sam Rivera', level: 1 })).toBeVisible();

  const notes = page.getByRole('region', { name: 'Notes' });
  await notes.getByLabel('What was said').fill('Coffee chat: their team is hiring SDETs');
  await notes.getByRole('button', { name: 'Add note' }).click();
  await expect(notes.getByRole('listitem')).toHaveText([/Coffee chat: their team is hiring SDETs/]);

  await page.goto('/applications/new');
  await formPage.fill({ company: 'Globex', role: 'Senior SDET', status: 'Applied' });
  await page.getByLabel('Lead', { exact: true }).selectOption({ label: 'Sam Rivera (Globex)' });
  await formPage.save.click();
  await expect(detailPage.heading('Globex')).toBeVisible();
  await page.getByRole('link', { name: 'Sam Rivera' }).click();

  const applications = page.getByRole('region', { name: 'Applications' });
  await expect(applications.getByRole('link', { name: 'Globex · Senior SDET' })).toBeVisible();
  await page.goto('/leads');
  await expect(page.getByRole('listitem').filter({ hasText: 'Sam Rivera' })).toContainText(
    '1 application',
  );
});

test('message a lead: draft, copy and open their profile, then log it sent', async ({
  page,
  api,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Opening the profile must not reach LinkedIn from a test.
  await context.route('https://www.linkedin.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Profile</title>' }),
  );
  await api.uploadResumeText('Pat Example. SDET, Playwright suites across 12 teams. '.repeat(5));
  const application = await api.createApplication({
    company: 'Acme',
    role: 'SDET',
    status: 'Applied',
  });
  const lead = await api.createLead({
    name: 'Sam Lee',
    company: 'Acme',
    profileLink: 'https://www.linkedin.com/in/samlee',
  });
  await page.goto(`/applications/${application.id}`);

  const panel = page.getByRole('region', { name: 'Message a lead' });
  await panel.getByLabel('Lead', { exact: true }).selectOption({ label: 'Sam Lee (Acme)' });
  // Applied: a follow-up is suggested.
  await expect(panel.getByLabel('Kind of message')).toHaveValue('follow_up');
  await panel.getByLabel('What you want to say (optional)').fill('I start in two weeks.');
  await panel.getByRole('button', { name: 'Draft message' }).click();

  const message = panel.getByLabel('Message', { exact: true });
  await expect(message).toHaveValue(
    /I'm interested in the SDET role at Acme\. I start in two weeks\./,
  );
  await expect(panel.getByText(/^\d+ of 200 characters$/)).toBeVisible();

  const popup = page.waitForEvent('popup');
  await panel.getByRole('button', { name: 'Copy and open profile: message' }).click();
  expect((await popup).url()).toBe('https://www.linkedin.com/in/samlee');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("I'm interested in the SDET role at Acme.");

  await panel.getByRole('button', { name: 'Mark sent: message' }).click();
  await panel.getByRole('link', { name: 'Sam Lee' }).click();
  await expect(page).toHaveURL(`/leads/${lead.id}`);
  await expect(page.getByText('LinkedIn message about SDET at Acme:')).toBeVisible();
});
