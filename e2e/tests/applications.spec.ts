import { expect, test } from '../fixtures';

test('add an application and see it in the pipeline', async ({
  page,
  applicationsPage,
  formPage,
  detailPage,
}) => {
  await applicationsPage.goto();
  await expect(applicationsPage.emptyState).toBeVisible();

  await applicationsPage.addButton.click();
  await formPage.fill({ company: 'Acme Robotics', role: 'Senior SDET', status: 'Applied' });
  await formPage.save.click();

  await expect(detailPage.heading('Acme Robotics')).toBeVisible();
  await expect(detailPage.history).toHaveText([/Created as Applied/]);

  await page.goBack();
  await page.goBack();
  await expect(applicationsPage.card('Acme Robotics')).toContainText('Applied');
  await expect(applicationsPage.stage('Applied')).toContainText('1');
});

test('change the status and keep a history', async ({ api, detailPage, formPage }) => {
  const created = await api.createApplication({
    company: 'Globex',
    role: 'QA Lead',
    status: 'Applied',
  });

  await detailPage.goto(created.id);
  await detailPage.editButton.click();
  await formPage.fill({ status: 'Interviewing' });
  await formPage.save.click();

  await expect(detailPage.history).toHaveText([/Applied → Interviewing/, /Created as Applied/]);
});

test('filter by stage, search, and flag stale applications for follow-up', async ({
  page,
  api,
  applicationsPage,
}) => {
  await api.createApplication({ company: 'Initech', role: 'SDET', status: 'Applied' });
  await api.createApplication({ company: 'Hooli', role: 'Test Engineer', status: 'Offer' });
  await api.shiftClock(8);

  await applicationsPage.goto();
  await expect(applicationsPage.cards).toHaveCount(2);

  await applicationsPage.stage('Offer').click();
  await expect(page).toHaveURL(/status=Offer/);
  await expect(applicationsPage.cards).toHaveCount(1);
  await expect(applicationsPage.card('Hooli')).toBeVisible();
  await applicationsPage.stage('Offer').click();

  await applicationsPage.search.fill('initech');
  await expect(applicationsPage.cards).toHaveCount(1);
  await applicationsPage.search.fill('');

  // Applied 8 days ago with no next step: needs a follow-up. An offer does not.
  await applicationsPage.followUpFilter.click();
  await expect(applicationsPage.cards).toHaveCount(1);
  await expect(applicationsPage.card('Initech')).toContainText('Needs follow-up');
});

test('delete an application after confirming', async ({ api, applicationsPage, detailPage }) => {
  const created = await api.createApplication({ company: 'Umbrella', role: 'SDET II' });

  await detailPage.goto(created.id);
  await detailPage.deleteButton.click();
  await detailPage.confirmDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(detailPage.heading('Umbrella')).toBeVisible();

  await detailPage.deleteButton.click();
  await detailPage.confirmDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(applicationsPage.heading).toBeVisible();
  await expect(applicationsPage.emptyState).toBeVisible();
});
