import { expect, test } from '../fixtures';

test('change the status from the list with the Move to menu', async ({ api, applicationsPage }) => {
  const created = await api.createApplication({ company: 'Acme', role: 'SDET', status: 'Applied' });
  await applicationsPage.goto();

  await applicationsPage.moveMenu('Acme').selectOption('Interviewing');

  await expect(applicationsPage.moveMenu('Acme')).toHaveValue('Interviewing');
  await expect(applicationsPage.stage('Interviewing')).toContainText('1');
  await expect.poll(async () => (await api.getApplication(created.id)).status).toBe('Interviewing');
});

test('drag a card to another column on the board', async ({ api, applicationsPage, isMobile }) => {
  test.skip(isMobile, 'Phones use the Move to menu; dragging is long-press, covered on desktop');
  const created = await api.createApplication({ company: 'Globex', role: 'QA', status: 'Applied' });
  await applicationsPage.goto();
  await applicationsPage.view('Board').click();
  await expect(applicationsPage.column('Applied')).toContainText('Globex');

  await applicationsPage.dragTo('Globex', 'Offer');

  await expect(applicationsPage.column('Offer')).toContainText('Globex');
  await expect(applicationsPage.column('Applied')).toContainText('No applications');
  await expect.poll(async () => (await api.getApplication(created.id)).status).toBe('Offer');
});

test('move a card with the keyboard on the board', async ({ page, api, applicationsPage }) => {
  const created = await api.createApplication({
    company: 'Initech',
    role: 'SDET',
    status: 'Saved',
  });
  await page.goto('/?view=board');

  await applicationsPage.dragHandle('Initech').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');

  await expect(applicationsPage.column('Screening')).toContainText('Initech');
  await expect.poll(async () => (await api.getApplication(created.id)).status).toBe('Screening');
});

test('a move that conflicts with an edit made elsewhere is explained and corrected', async ({
  page,
  api,
  applicationsPage,
}) => {
  const created = await api.createApplication({
    company: 'Hooli',
    role: 'SDET',
    status: 'Applied',
  });
  await applicationsPage.goto();
  await expect(applicationsPage.moveMenu('Hooli')).toHaveValue('Applied');

  // Another tab moves it to Screening; this page still holds the old version.
  await api.updateApplication(created.id, created.version, { status: 'Screening' });
  await applicationsPage.moveMenu('Hooli').selectOption('Offer');

  await expect(page.getByRole('alert')).toContainText('Hooli was changed somewhere else');
  await expect(applicationsPage.moveMenu('Hooli')).toHaveValue('Screening');
  expect((await api.getApplication(created.id)).status).toBe('Screening');
});
