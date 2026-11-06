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

test('move a card with the keyboard on the board', async ({
  page,
  api,
  applicationsPage,
  isMobile,
}) => {
  test.skip(isMobile, 'Phones show one stage at a time as tabs; moves there use the Move to menu');
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

test('on a phone the board is one tab per stage, and the menu moves a card between tabs', async ({
  page,
  api,
  applicationsPage,
  isMobile,
}) => {
  test.skip(!isMobile, 'Desktop shows every column at once');
  await api.createApplication({ company: 'Acme', role: 'SDET', status: 'Applied' });
  await api.createApplication({ company: 'Globex', role: 'QA', status: 'Screening' });
  await page.goto('/?view=board');

  const tabs = page.getByRole('tablist', { name: 'Stages' });
  await expect(tabs.getByRole('tab', { name: 'Applied 1' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toContainText('Acme');
  await expect(page.getByRole('tabpanel')).not.toContainText('Globex');

  await tabs.getByRole('tab', { name: 'Screening 1' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Globex');
  await applicationsPage.moveMenu('Globex').selectOption('Offer');

  await expect(tabs.getByRole('tab', { name: 'Offer 1' })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: 'Screening 0' })).toBeVisible();
});
