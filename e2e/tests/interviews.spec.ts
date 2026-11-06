import { expect, test } from '../fixtures';

/** A day `offset` days from today, as YYYY-MM-DD (the test user's zone is UTC). */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test('log a scheduled interview and see it on the card and in the history', async ({
  page,
  api,
  detailPage,
  applicationsPage,
}) => {
  const created = await api.createApplication({
    company: 'Hooli',
    role: 'SDET',
    status: 'Interviewing',
  });
  await detailPage.goto(created.id);

  const interviews = page.getByRole('region', { name: 'Interviews' });
  await interviews.getByRole('button', { name: 'Add interview' }).click();
  await interviews.getByLabel('Day').fill(day(10));
  await interviews.getByLabel('Round').fill('Onsite');
  await interviews.getByRole('button', { name: 'Save interview' }).click();

  await expect(interviews.getByRole('listitem')).toHaveText([/Onsite\s*Upcoming/]);
  await expect(detailPage.history.first()).toHaveText(/Interview: Onsite/);

  await applicationsPage.goto();
  await expect(applicationsPage.card('Hooli')).toContainText(/Interview \w+ \d+, \d{4}/);

  // Removing it brings the card back to no interviews.
  await detailPage.goto(created.id);
  await interviews.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove interview' }).click();
  await expect(interviews).toContainText('None yet');
});
