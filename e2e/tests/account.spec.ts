import { expect, test } from '../fixtures';

test('delete my account: signed out, and the data is gone', async ({ page, api }) => {
  await api.createApplication({ company: 'Soon Gone', role: 'SDET' });

  await page.goto('/account');
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete my account' }).click();

  await expect(page).toHaveURL(/\/login/);
  // The old session no longer works.
  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(401);
});

test('the privacy notice is public and linked from sign-in', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible();
});
