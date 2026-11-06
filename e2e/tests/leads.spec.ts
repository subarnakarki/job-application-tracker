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
